// Package config reads the catalog's configuration from the environment.
//
// Every setting has a development default that matches bin/texera-2-0/docker-compose.yml,
// so `go run ./cmd/catalog` works against the dev stack with no configuration. No secret
// value is read here except the dev secret store's token and the S3 keys of the dev stack.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is the catalog's runtime configuration.
type Config struct {
	HTTPAddr    string
	DatabaseURL string
	// PublicURL is the gateway URL as clients see it.
	PublicURL string
	BrandName string

	// Identity (OIDC).
	OIDCIssuer          string
	OIDCDiscoveryURL    string
	OIDCJWKSURL         string
	OIDCTokenURL        string
	OIDCAudience        string
	OIDCAppClientID     string
	ServiceClientID     string
	ServiceClientSecret string

	// Authorization (OpenFGA).
	OpenFGAURL       string
	OpenFGAStoreName string
	OpenFGAModelPath string

	// Secrets (OpenBao, the Vault KV v2 API).
	SecretsURL   string
	SecretsToken string
	SecretsMount string

	// Blobs (S3). Without a key, the store is reached as the catalog itself (a pod identity, an
	// instance role), and without an endpoint it is the region's own S3.
	S3Endpoint       string
	S3PublicEndpoint string
	S3Region         string
	S3AccessKey      string
	S3SecretKey      string
	S3Bucket         string
	S3PathStyle      bool

	// Results (Iceberg through Lakekeeper), as the units reach them.
	IcebergCatalogURI string
	IcebergWarehouse  string
	// The lake as the catalog reaches it, and the warehouse's store as Lakekeeper and the
	// units reach it (the warehouse profile the catalog creates). With the S3 key above, an
	// S3-compatible store at LakeS3Endpoint; without one, AWS S3 itself: the lake uses its own
	// identity and assumes LakeS3RoleArn, which trusts it by LakeS3ExternalID, for its reads and
	// for the credentials it vends to units.
	LakeURL          string
	LakeS3Endpoint   string
	LakeBucket       string
	LakeKeyPrefix    string
	LakeS3RoleArn    string
	LakeS3ExternalID string
	// LineageCallbackURL is where units post OpenLineage events.
	LineageCallbackURL string

	// Seeds of the dev stack: the unit that already runs, and the OAuth client it presents
	// to the lake (empty: the unit has no identity and the lake must be open).
	StaticUnitEndpoint string
	StaticUnitName     string
	StaticUnitClientID string
	// ImportMaxBytes is the largest file an import fetches from the internet.
	ImportMaxBytes int64

	// Kubernetes units: set the namespace to let the catalog create units as Deployments there
	// (in-cluster, or through the kubeconfig KUBECONFIG names); empty means static units only.
	KubeNamespace   string
	KubeUnitImage   string
	KubeUnitMemory  string
	BioMcpURL       string
	BioMcpKey       string
	ModelName       string
	ModelSecretPath string

	PresignTTL       time.Duration
	LeaseTTL         time.Duration
	UploadGrace      time.Duration
	MaxDownloadBytes int64
}

// FromEnv builds a Config from TEXERA_* environment variables with dev-stack defaults.
func FromEnv() (Config, error) {
	public := env("TEXERA_PUBLIC_URL", "http://localhost:8088")
	c := Config{
		HTTPAddr:            env("TEXERA_HTTP_ADDR", ":8090"),
		DatabaseURL:         env("TEXERA_DATABASE_URL", "postgres://texera:texera@localhost:15432/catalog?sslmode=disable"),
		PublicURL:           public,
		BrandName:           env("TEXERA_BRAND_NAME", "Texera"),
		OIDCIssuer:          env("TEXERA_OIDC_ISSUER", "http://localhost:8088/auth/realms/texera"),
		OIDCDiscoveryURL:    env("TEXERA_OIDC_DISCOVERY_URL", "http://localhost:18081/auth/realms/texera"),
		OIDCJWKSURL:         env("TEXERA_OIDC_JWKS_URL", ""),
		OIDCTokenURL:        env("TEXERA_OIDC_TOKEN_URL", ""),
		OIDCAudience:        env("TEXERA_OIDC_AUDIENCE", "texera"),
		OIDCAppClientID:     env("TEXERA_OIDC_APP_CLIENT_ID", "texera-app"),
		ServiceClientID:     env("TEXERA_SERVICE_CLIENT_ID", "texera-services"),
		ServiceClientSecret: env("TEXERA_SERVICE_CLIENT_SECRET", "texera-services-secret"),
		OpenFGAURL:          env("TEXERA_OPENFGA_URL", "http://localhost:18082"),
		OpenFGAStoreName:    env("TEXERA_OPENFGA_STORE", "texera"),
		OpenFGAModelPath:    env("TEXERA_OPENFGA_MODEL", "../api/openfga/model.fga"),
		SecretsURL:          env("TEXERA_SECRETS_URL", "http://localhost:18200"),
		SecretsToken:        env("TEXERA_SECRETS_TOKEN", "texera-dev-root"),
		SecretsMount:        env("TEXERA_SECRETS_MOUNT", "texera"),
		S3Endpoint:          env("TEXERA_S3_ENDPOINT", "http://localhost:19001"),
		S3PublicEndpoint:    env("TEXERA_S3_PUBLIC_ENDPOINT", "http://localhost:19001"),
		S3Region:            env("TEXERA_S3_REGION", "us-east-1"),
		S3AccessKey:         env("TEXERA_S3_ACCESS_KEY", "texera"),
		S3SecretKey:         env("TEXERA_S3_SECRET_KEY", "texera-secret"),
		S3Bucket:            env("TEXERA_S3_BUCKET", "datasets"),
		S3PathStyle:         envBool("TEXERA_S3_PATH_STYLE", true),
		IcebergCatalogURI:   env("TEXERA_ICEBERG_CATALOG_URI", "http://localhost:18181/catalog"),
		IcebergWarehouse:    env("TEXERA_ICEBERG_WAREHOUSE", "texera"),
		LakeURL:             env("TEXERA_LAKE_URL", "http://localhost:18181"),
		LakeS3Endpoint:      env("TEXERA_LAKE_S3_ENDPOINT", "http://127.0.0.1:19001"),
		LakeBucket:          env("TEXERA_LAKE_BUCKET", "texera"),
		LakeKeyPrefix:       env("TEXERA_LAKE_KEY_PREFIX", "warehouse"),
		LakeS3RoleArn:       env("TEXERA_LAKE_S3_ROLE_ARN", ""),
		LakeS3ExternalID:    env("TEXERA_LAKE_S3_EXTERNAL_ID", ""),
		LineageCallbackURL:  env("TEXERA_LINEAGE_CALLBACK_URL", "http://localhost:8090/lineage/v1/events"),
		StaticUnitEndpoint:  env("TEXERA_STATIC_UNIT_ENDPOINT", "http://localhost:28085"),
		StaticUnitName:      env("TEXERA_STATIC_UNIT_NAME", "Public unit"),
		StaticUnitClientID:  env("TEXERA_STATIC_UNIT_CLIENT_ID", "texera-unit"),
		KubeNamespace:       env("TEXERA_KUBE_NAMESPACE", ""),
		KubeUnitImage:       env("TEXERA_KUBE_UNIT_IMAGE", "texera/computing-unit-master:2.0-dev"),
		KubeUnitMemory:      env("TEXERA_KUBE_UNIT_MEMORY", "2Gi"),
		BioMcpURL:           env("TEXERA_BIOMCP_URL", public+"/bio-mcp"),
		BioMcpKey:           env("TEXERA_BIOMCP_KEY", "texera-bio-dev-key"),
		ModelName:           env("TEXERA_MODEL_NAME", "claude-haiku-5-5"),
		ModelSecretPath:     env("TEXERA_MODEL_SECRET_PATH", "platform/anthropic"),
		PresignTTL:          envDuration("TEXERA_PRESIGN_TTL", time.Hour),
		LeaseTTL:            envDuration("TEXERA_LEASE_TTL", time.Hour),
		UploadGrace:         envDuration("TEXERA_UPLOAD_GRACE", 24*time.Hour),
		ImportMaxBytes:      envInt64("TEXERA_IMPORT_MAX_BYTES", 1<<30),
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
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
