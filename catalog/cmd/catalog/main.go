// Command catalog runs the Texera 2.0 catalog: the control plane's resources, versions,
// grants, executions, lineage, datasets, units and the MCP server.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/config"
	"github.com/apache/texera/catalog/internal/datasets"
	"github.com/apache/texera/catalog/internal/mcp"
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

	verifier, err := authn.NewVerifier(ctx, st, cfg.OIDCIssuer, cfg.OIDCDiscoveryURL, cfg.OIDCJWKSURL, cfg.OIDCAudience, cfg.ServiceClientID)
	if err != nil {
		return err
	}
	discovery := cfg.OIDCDiscoveryURL
	if discovery == "" {
		discovery = cfg.OIDCIssuer
	}
	tokens, err := authn.NewServiceTokenSource(ctx, discovery, cfg.OIDCTokenURL, cfg.ServiceClientID, cfg.ServiceClientSecret)
	if err != nil {
		return err
	}
	log.Info("identity provider ready", "issuer", cfg.OIDCIssuer)

	var fga *authz.FGA
	if cfg.OpenFGAURL != "" {
		fga, err = authz.NewFGA(ctx, cfg.OpenFGAURL, cfg.OpenFGAStoreName, cfg.OpenFGAModelPath, log)
		if err != nil {
			log.Warn("openfga unavailable; deciding from grants only", "err", err)
			fga = nil
		}
	}
	pdp := authz.NewPDP(st, fga, log)
	drainer := authz.NewDrainer(st, fga, log)
	if fga != nil {
		go drainer.Run(ctx, 2*time.Second)
	}

	files := datasets.New(datasets.Options{
		Endpoint: cfg.S3Endpoint, PublicEndpoint: cfg.S3PublicEndpoint, Region: cfg.S3Region,
		AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey, Bucket: cfg.S3DatasetBucket, PathStyle: cfg.S3PathStyle, PresignTTL: cfg.PresignTTL,
	})

	srv := server.New(server.Deps{Config: cfg, Store: st, PDP: pdp, Drainer: drainer, Verifier: verifier, Tokens: tokens, Files: files, Log: log})
	if err := srv.Seed(ctx); err != nil {
		return err
	}
	srv.Mount("/mcp", mcp.Handler(srv, verifier, cfg.PublicURL, log))

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
