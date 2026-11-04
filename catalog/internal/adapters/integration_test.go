//go:build integration

// The real adapters against the dev stack: `go test -tags integration ./internal/adapters/`
// with bin/texera-2-0/up.sh running (or at least its containers).
package adapters_test

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/apache/texera/catalog/internal/adapters/openbao"
	"github.com/apache/texera/catalog/internal/adapters/openfga"
	"github.com/apache/texera/catalog/internal/adapters/s3cas"
	"github.com/apache/texera/catalog/internal/ports/contracttest"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func TestOpenBao(t *testing.T) {
	s := openbao.New(env("TEXERA_SECRETS_URL", "http://localhost:18200"), env("TEXERA_SECRETS_MOUNT", "texera"), env("TEXERA_SECRETS_TOKEN", "texera-dev-root"))
	contracttest.SecretStore(t, s)
}

func TestS3CAS(t *testing.T) {
	b := s3cas.New(s3cas.Options{
		Endpoint: env("TEXERA_S3_ENDPOINT", "http://localhost:19001"), Region: "us-east-1",
		AccessKey: env("TEXERA_S3_ACCESS_KEY", "texera"), SecretKey: env("TEXERA_S3_SECRET_KEY", "texera-secret"),
		Bucket: env("TEXERA_S3_BUCKET", "datasets"), PathStyle: true,
	})
	contracttest.BlobStore(t, b)
}

func TestOpenFGA(t *testing.T) {
	model, err := os.ReadFile("../../../api/openfga/model.fga")
	if err != nil {
		t.Fatal(err)
	}
	a, err := openfga.New(context.Background(), env("TEXERA_OPENFGA_URL", "http://localhost:18082"), "texera-contracttest", string(model), slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	contracttest.Authorizer(t, a)
}
