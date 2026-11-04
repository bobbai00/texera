package memory

import (
	"testing"

	"github.com/apache/texera/catalog/internal/ports/contracttest"
)

func TestSecrets(t *testing.T)    { contracttest.SecretStore(t, NewSecrets()) }
func TestBlobs(t *testing.T)      { contracttest.BlobStore(t, NewBlobs()) }
func TestAuthorizer(t *testing.T) { contracttest.Authorizer(t, NewAuthorizer()) }
