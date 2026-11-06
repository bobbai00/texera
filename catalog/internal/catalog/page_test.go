package catalog

import "testing"

// A page holds as many items as were asked for, the usual number when nothing was asked, and
// never more than the most a page gives. Asking for more is asking for a full page: a client
// that wants everything must not be handed the usual few without knowing.
func TestAPageHoldsWhatWasAskedForUpToTheMost(t *testing.T) {
	for _, c := range []struct{ asked, usual, most, want int }{
		{0, 50, 200, 50},
		{-3, 50, 200, 50},
		{10, 50, 200, 10},
		{200, 50, 200, 200},
		{201, 50, 200, 200},
		{5000, 100, 1000, 1000},
	} {
		if got := pageSize(c.asked, c.usual, c.most); got != c.want {
			t.Errorf("asked %d (usual %d, most %d): %d, want %d", c.asked, c.usual, c.most, got, c.want)
		}
	}
}
