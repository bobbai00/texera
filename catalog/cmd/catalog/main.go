// Command catalog runs the Texera 2.0 catalog: the control plane's resources, versions,
// grants, executions, lineage, files, units and the MCP servers. It wires the store, the
// ports' adapters and the domain service into the HTTP server.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/apache/texera/catalog/internal/adapters/keycloak"
	"github.com/apache/texera/catalog/internal/adapters/kube"
	"github.com/apache/texera/catalog/internal/adapters/lakekeeper"
	"github.com/apache/texera/catalog/internal/adapters/noop"
	"github.com/apache/texera/catalog/internal/adapters/openbao"
	"github.com/apache/texera/catalog/internal/adapters/openfga"
	"github.com/apache/texera/catalog/internal/adapters/s3cas"
	"github.com/apache/texera/catalog/internal/adapters/staticunit"
	"github.com/apache/texera/catalog/internal/adapters/unitmux"
	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/config"
	"github.com/apache/texera/catalog/internal/mcp"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/server"
	"github.com/apache/texera/catalog/internal/store"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: levelFromEnv()}))
	if err := run(log); err != nil {
		log.Error("catalog stopped", "err", err)
		os.Exit(1)
	}
}

func levelFromEnv() slog.Level {
	switch os.Getenv("TEXERA_LOG_LEVEL") {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	default:
		return slog.LevelInfo
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	log.Info("database ready")

	identity, err := keycloak.New(ctx, keycloak.Options{
		Issuer: cfg.OIDCIssuer, DiscoveryURL: cfg.OIDCDiscoveryURL, JWKSURL: cfg.OIDCJWKSURL, TokenURL: cfg.OIDCTokenURL,
		Audience: cfg.OIDCAudience, ServiceClientID: cfg.ServiceClientID, ServiceClientSecret: cfg.ServiceClientSecret,
	})
	if err != nil {
		return err
	}
	log.Info("identity provider ready", "issuer", cfg.OIDCIssuer)

	model, err := os.ReadFile(cfg.OpenFGAModelPath)
	if err != nil {
		return err
	}
	authorizer, err := openfga.New(ctx, cfg.OpenFGAURL, cfg.OpenFGAStoreName, string(model), log)
	if err != nil {
		return err
	}
	pdp := authz.NewPDP(authorizer, log)
	relay := authz.NewRelay(outbox{st}, authorizer, log)
	go relay.Run(ctx, 2*time.Second)

	// The lake: bootstrapped with the catalog as its operator, the warehouse the units write to.
	lake := lakekeeper.New(lakekeeper.Options{URL: cfg.LakeURL, Tokens: identity}, log)
	if err := lake.Prepare(ctx); err != nil {
		return err
	}
	log.Info("lake ready", "url", cfg.LakeURL)

	// Units: static ones always; Kubernetes ones when a namespace is configured.
	units := unitmux.Mux{api.UnitProviderStatic: staticunit.Provider{}}
	if cfg.KubeNamespace != "" {
		jwks := cfg.OIDCJWKSURL
		if jwks == "" {
			jwks = cfg.OIDCDiscoveryURL + "/protocol/openid-connect/certs"
		}
		tokenURL := cfg.OIDCTokenURL
		if tokenURL == "" {
			tokenURL = cfg.OIDCDiscoveryURL + "/protocol/openid-connect/token"
		}
		kubeUnits, err := kube.New(kube.Options{
			Namespace: cfg.KubeNamespace, Image: cfg.KubeUnitImage, Memory: cfg.KubeUnitMemory,
			Env: map[string]string{
				"TEXERA_OIDC_ISSUER": cfg.OIDCIssuer, "TEXERA_OIDC_JWKS_URL": jwks,
				"TEXERA_ENV_ROOT": "/tmp/texera-environments", "UDF_PYTHON_PATH": "/usr/bin/python3",
				"STORAGE_ICEBERG_CATALOG_TYPE": "rest", "STORAGE_ICEBERG_CATALOG_REST_URI": cfg.IcebergCatalogURI,
				"STORAGE_ICEBERG_CATALOG_REST_WAREHOUSE_NAME": cfg.IcebergWarehouse,
				"STORAGE_ICEBERG_CATALOG_REST_TOKEN_URL":      tokenURL,
				"STORAGE_S3_ENDPOINT":                         cfg.S3Endpoint, "STORAGE_S3_REGION": cfg.S3Region,
				"STORAGE_S3_AUTH_USERNAME": cfg.S3AccessKey, "STORAGE_S3_AUTH_PASSWORD": cfg.S3SecretKey,
			},
		})
		if err != nil {
			return err
		}
		units[api.UnitProviderKubernetes] = kubeUnits
		log.Info("kubernetes units enabled", "namespace", cfg.KubeNamespace, "image", cfg.KubeUnitImage)
	}

	svc := &catalog.Service{
		Store: st, PDP: pdp, Relay: relay, Identity: identity,
		Secrets:     openbao.New(cfg.SecretsURL, cfg.SecretsMount, cfg.SecretsToken),
		Blobs:       s3cas.New(s3cas.Options{Endpoint: cfg.S3Endpoint, PublicEndpoint: cfg.S3PublicEndpoint, Region: cfg.S3Region, AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey, Bucket: cfg.S3Bucket, PathStyle: cfg.S3PathStyle}),
		Units:       units,
		Workloads:   identity,
		Lake:        lake,
		LineageSink: noop.Lineage{},
		Config: catalog.Config{
			PublicURL: cfg.PublicURL, APIPrefix: server.Prefix, OIDCIssuer: cfg.OIDCIssuer, OIDCClientID: cfg.OIDCAppClientID, BrandName: cfg.BrandName,
			Warehouse: cfg.IcebergWarehouse,
			WarehouseStore: ports.WarehouseStorage{
				Endpoint: cfg.LakeS3Endpoint, Region: cfg.S3Region, Bucket: cfg.LakeBucket, KeyPrefix: cfg.LakeKeyPrefix,
				AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey,
			},
			LineageCallbackURL: cfg.LineageCallbackURL,
			PresignTTL:         cfg.PresignTTL, LeaseTTL: cfg.LeaseTTL, MaxDownloadBytes: cfg.MaxDownloadBytes, UploadGrace: cfg.UploadGrace,
			StaticUnitEndpoint: cfg.StaticUnitEndpoint, StaticUnitName: cfg.StaticUnitName, StaticUnitClientID: cfg.StaticUnitClientID, BioMcpURL: cfg.BioMcpURL, BioMcpKey: cfg.BioMcpKey,
			ModelName: cfg.ModelName, ModelSecretPath: cfg.ModelSecretPath,
		},
		Log: log,
	}
	if err := svc.Seed(ctx); err != nil {
		return err
	}
	// The authorizer is a copy of the catalog's grants. Every start writes the copy again, in
	// the background, so whatever a relay once lost is there again. The work grows with the
	// catalog and holds the relay while it runs: a deployment too large for that needs a
	// rebuild on request instead.
	go func() {
		started := time.Now()
		n, err := relay.Rebuild(ctx)
		if err != nil {
			log.Warn("the access rebuild failed; what it wrote so far stays", "tuples", n, "err", err)
			return
		}
		log.Info("access rebuilt", "tuples", n, "took", time.Since(started).Round(time.Millisecond).String())
	}()
	go svc.RunOperatorSync(ctx, 30*time.Second)
	go svc.RunRetention(ctx, time.Hour)

	// The clients computing units run as: the ones the catalog mints, and the static unit's.
	isUnit := func(clientID string) bool {
		return strings.HasPrefix(clientID, "unit-") || (cfg.StaticUnitClientID != "" && clientID == cfg.StaticUnitClientID)
	}
	resolver := auth.NewResolver(identity, st, isUnit)
	// The identity provider names the administrators: each is one of Texera's admins.
	resolver.OnAdministrator(svc.MakeAdministrator)
	srv := server.New(svc, resolver, pdp, cfg.PublicURL, log)
	api := srv.API()
	srv.Mount(catalog.McpPath, mcp.Handler(api, resolver, cfg.PublicURL, log))

	httpSrv := &http.Server{Addr: cfg.HTTPAddr, Handler: srv.Handler(), ReadHeaderTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdown)
	}()
	log.Info("catalog listening", "addr", cfg.HTTPAddr, "public", cfg.PublicURL)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// outbox adapts the store to the relay.
type outbox struct{ st *store.Store }

func (o outbox) PendingOutbox(ctx context.Context, limit int) ([]authz.OutboxEntry, error) {
	entries, err := o.st.PendingOutbox(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := make([]authz.OutboxEntry, len(entries))
	for i, e := range entries {
		out[i] = authz.OutboxEntry{ID: e.ID, Op: e.Op, Object: e.Object, Relation: e.Relation, Subject: e.Subject}
	}
	return out, nil
}

func (o outbox) MarkOutboxProcessed(ctx context.Context, ids []int64) error {
	return o.st.MarkOutboxProcessed(ctx, ids)
}

func (o outbox) AllTuples(ctx context.Context) ([]authz.OutboxEntry, error) {
	entries, err := o.st.AllTuples(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]authz.OutboxEntry, len(entries))
	for i, e := range entries {
		out[i] = authz.OutboxEntry{Op: e.Op, Object: e.Object, Relation: e.Relation, Subject: e.Subject}
	}
	return out, nil
}
