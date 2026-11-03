// Package config reads the catalog's configuration from the environment.
//
// Every setting has a development default that matches bin/texera-2-0/docker-compose.yml,
// so `go run ./cmd/catalog` works against the dev stack with no configuration.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is the catalog's runtime configuration.
type Config struct {
	// HTTPAddr is the listen address, e.g. ":8090".
	HTTPAddr string
	// DatabaseURL is the Postgres URL of the catalog database.
	DatabaseURL string
	// PublicURL is the gateway URL as clients see it, e.g. http://localhost:8088.
	PublicURL string

	// OIDCIssuer is the issuer claim tokens carry (Keycloak's realm URL as the browser sees it).
	OIDCIssuer string
	// OIDCDiscoveryURL overrides where OIDC discovery and JWKS are fetched from when the
	// issuer URL is not reachable from the catalog; empty means the issuer URL.
	OIDCDiscoveryURL string
	// OIDCJWKSURL and OIDCTokenURL, when set, are used as given instead of the URLs discovery
	// returns. Keycloak's discovery document names its public hostname, which a pod inside a
	// cluster may not reach; the issuer claim is checked against OIDCIssuer either way.
	OIDCJWKSURL  string
	OIDCTokenURL string
	// OIDCAudience is the audience the access token must carry.
	OIDCAudience string
	// ServiceClientID and ServiceClientSecret identify the catalog (and the other services)
	// to the identity provider for client-credentials tokens.
	ServiceClientID     string
	ServiceClientSecret string

	// OpenFGAURL is the OpenFGA HTTP API; OpenFGAStoreName the store the catalog owns.
	OpenFGAURL       string
	OpenFGAStoreName string
	// OpenFGAModelPath is the DSL file written to the store at startup.
	OpenFGAModelPath string

	// S3 settings for dataset files.
	S3Endpoint string
	// S3PublicEndpoint is the endpoint presigned URLs point at, reachable by engines and browsers.
	S3PublicEndpoint string
	S3Region         string
	S3AccessKey      string
	S3SecretKey      string
	S3DatasetBucket  string
	S3PathStyle      bool

	// Iceberg result store the units write to.
	IcebergCatalogURI string
	IcebergWarehouse  string

	// Static computing unit for the dev stack: registered at startup when set.
	StaticUnitEndpoint string
	StaticUnitName     string
	// LineageCallbackURL is where units post OpenLineage events (the catalog as the unit reaches it).
	LineageCallbackURL string

	// PresignTTL bounds presigned URLs.
	PresignTTL time.Duration
	// MaxDownloadBytes bounds read_dataset_file responses.
	MaxDownloadBytes int64
}

// FromEnv builds a Config from TEXERA_* environment variables with dev-stack defaults.
func FromEnv() (Config, error) {
	c := Config{
		HTTPAddr:            env("TEXERA_HTTP_ADDR", ":8090"),
		DatabaseURL:         env("TEXERA_DATABASE_URL", "postgres://texera:texera@localhost:15432/catalog?sslmode=disable"),
		PublicURL:           env("TEXERA_PUBLIC_URL", "http://localhost:8088"),
		OIDCIssuer:          env("TEXERA_OIDC_ISSUER", "http://localhost:8088/auth/realms/texera"),
		OIDCDiscoveryURL:    env("TEXERA_OIDC_DISCOVERY_URL", "http://localhost:18081/auth/realms/texera"),
		OIDCJWKSURL:         env("TEXERA_OIDC_JWKS_URL", ""),
		OIDCTokenURL:        env("TEXERA_OIDC_TOKEN_URL", ""),
		OIDCAudience:        env("TEXERA_OIDC_AUDIENCE", "texera"),
		ServiceClientID:     env("TEXERA_SERVICE_CLIENT_ID", "texera-services"),
		ServiceClientSecret: env("TEXERA_SERVICE_CLIENT_SECRET", "texera-services-secret"),
		OpenFGAURL:          env("TEXERA_OPENFGA_URL", "http://localhost:18082"),
		OpenFGAStoreName:    env("TEXERA_OPENFGA_STORE", "texera"),
		OpenFGAModelPath:    env("TEXERA_OPENFGA_MODEL", "../api/openfga/model.fga"),
		S3Endpoint:          env("TEXERA_S3_ENDPOINT", "http://localhost:19001"),
		S3PublicEndpoint:    env("TEXERA_S3_PUBLIC_ENDPOINT", "http://localhost:19001"),
		S3Region:            env("TEXERA_S3_REGION", "us-east-1"),
		S3AccessKey:         env("TEXERA_S3_ACCESS_KEY", "texera"),
		S3SecretKey:         env("TEXERA_S3_SECRET_KEY", "texera-secret"),
		S3DatasetBucket:     env("TEXERA_S3_DATASET_BUCKET", "datasets"),
		S3PathStyle:         envBool("TEXERA_S3_PATH_STYLE", true),
		IcebergCatalogURI:   env("TEXERA_ICEBERG_CATALOG_URI", "http://localhost:18181/catalog"),
		IcebergWarehouse:    env("TEXERA_ICEBERG_WAREHOUSE", "texera"),
		StaticUnitEndpoint:  env("TEXERA_STATIC_UNIT_ENDPOINT", "http://localhost:28085"),
		StaticUnitName:      env("TEXERA_STATIC_UNIT_NAME", "local unit"),
		LineageCallbackURL:  env("TEXERA_LINEAGE_CALLBACK_URL", "http://localhost:8090/lineage/v1/events"),
		PresignTTL:          envDuration("TEXERA_PRESIGN_TTL", time.Hour),
		MaxDownloadBytes:    envInt64("TEXERA_MAX_DOWNLOAD_BYTES", 1<<20),
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("TEXERA_DATABASE_URL is required")
	}
	return c, nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v, ok := os.LookupEnv(key); ok {
		n, err := strconv.ParseInt(v, 10, 64)
		if err == nil {
			return n
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		d, err := time.ParseDuration(v)
		if err == nil {
			return d
		}
	}
	return def
}
