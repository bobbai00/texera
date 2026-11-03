package authn

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"
)

// In a cluster, Keycloak's discovery document names its public hostname, which pods cannot
// reach; the catalog then takes the key set and token endpoint as given. Nothing here serves
// discovery, so a verifier or token source that tried it would fail.
func TestExplicitKeySetAndTokenURLs(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	mux := http.NewServeMux()
	mux.HandleFunc("/certs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "service-token", "expires_in": 300})
	})
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		t.Error("discovery must not be used when the URLs are given")
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	const issuer = "http://localhost:28088/auth/realms/texera" // the public URL, unreachable here
	mint := func(iss string) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"iss": iss, "aud": "texera", "sub": "bob", "exp": time.Now().Add(time.Minute).Unix(),
		})
		tok.Header["kid"] = "k1"
		raw, err := tok.SignedString(key)
		require.NoError(t, err)
		return raw
	}

	ctx := context.Background()
	v, err := NewVerifier(ctx, nil, issuer, "", srv.URL+"/certs", "texera", "texera-services")
	require.NoError(t, err)
	claims, err := v.VerifyToken(ctx, mint(issuer))
	require.NoError(t, err)
	require.Equal(t, "bob", claims.Subject)
	_, err = v.VerifyToken(ctx, mint("http://elsewhere/realms/texera"))
	require.ErrorIs(t, err, ErrUnauthenticated, "the issuer is still checked")

	tokens, err := NewServiceTokenSource(ctx, "http://127.0.0.1:1/unreachable", srv.URL+"/token", "texera-services", "secret")
	require.NoError(t, err)
	got, err := tokens.Token(ctx)
	require.NoError(t, err)
	require.Equal(t, "service-token", got)
}
