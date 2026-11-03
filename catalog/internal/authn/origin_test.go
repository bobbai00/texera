package authn

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestParseOrigin(t *testing.T) {
	id := uuid.New()
	o, err := ParseOrigin(id.String() + ":7")
	require.NoError(t, err)
	require.Equal(t, id, o.Conversation)
	require.Equal(t, int64(7), o.Seq)

	for _, bad := range []string{"", "nocolon", "not-a-uuid:1", id.String() + ":x", id.String() + ":-1"} {
		_, err := ParseOrigin(bad)
		require.Error(t, err, bad)
	}
}
