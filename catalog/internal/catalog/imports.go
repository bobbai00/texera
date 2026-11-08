package catalog

// Importing a file from the internet into the staging area of a dataset or model: the catalog
// fetches it itself, so its bytes never pass through a chat or a browser. It reaches the public
// internet only. The address is checked when each connection is made, after the name resolves
// and after every redirect, so neither a name that resolves to a private address nor a
// redirect that points at one gets anything from the platform's own network.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
)

// DefaultImportMaxBytes is the largest file an import takes when the deployment sets no limit.
const DefaultImportMaxBytes int64 = 1 << 30

// importTimeout bounds one import from its request to its last byte.
const importTimeout = 10 * time.Minute

// notPublic are the ranges an import never connects to beyond those net/netip names: loopback,
// private, link-local, multicast and unspecified addresses.
var notPublic = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),       // this network
	netip.MustParsePrefix("100.64.0.0/10"),   // shared address space, carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),    // protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // documentation
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"), // documentation
	netip.MustParsePrefix("203.0.113.0/24"),  // documentation
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved, and the broadcast address
	netip.MustParsePrefix("64:ff9b::/96"),    // NAT64, with an IPv4 address behind it
	netip.MustParsePrefix("64:ff9b:1::/48"),  // local NAT64
	netip.MustParsePrefix("100::/64"),        // discard
	netip.MustParsePrefix("2001:db8::/32"),   // documentation
	netip.MustParsePrefix("2002::/16"),       // 6to4, with an IPv4 address inside
}

// PublicAddress says whether an import may connect to an address: one on the public internet.
func PublicAddress(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsUnspecified() || a.IsLinkLocalUnicast() ||
		a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() || a.IsMulticast() {
		return false
	}
	for _, p := range notPublic {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// notPublicError is what a connection to an address off the public internet fails with.
type notPublicError struct{ host string }

func (e notPublicError) Error() string { return e.host + " is not on the public internet" }

// PublicClient is an HTTP client that connects to public addresses only, over https, through no
// proxy: the address it checks is the one it connects to.
func PublicClient() *http.Client {
	dialer := &net.Dialer{
		Timeout: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if a, err := netip.ParseAddr(host); err != nil || !PublicAddress(a) {
				return notPublicError{host}
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: importTimeout,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: time.Minute,
			IdleConnTimeout:       30 * time.Second,
		},
		CheckRedirect: refuseUnsafeRedirects,
	}
}

// refuseUnsafeRedirects follows up to five redirects, each to https.
func refuseUnsafeRedirects(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("more than five redirects")
	}
	if req.URL.Scheme != "https" {
		return fmt.Errorf("a redirect to %s, which is not https", req.URL.Redacted())
	}
	return nil
}

// importer is the client imports fetch with: the public one unless the service was given
// another (tests reach a server of their own), which follows redirects as the public one does.
func (s *Service) importer() *http.Client {
	if s.Importer != nil {
		c := *s.Importer
		c.CheckRedirect = refuseUnsafeRedirects
		return &c
	}
	s.importerOnce.Do(func() { s.publicImporter = PublicClient() })
	return s.publicImporter
}

func (s *Service) importMax() int64 {
	if s.Config.ImportMaxBytes > 0 {
		return s.Config.ImportMaxBytes
	}
	return DefaultImportMaxBytes
}

// errTooLarge is what a capped body fails with once it passes the limit.
var errTooLarge = errors.New("larger than the import limit")

// capped reads at most a limit's bytes, and fails if the body has more.
type capped struct {
	r    io.Reader
	left int64
	over bool
}

func (c *capped) Read(p []byte) (int, error) {
	if c.left <= 0 {
		var one [1]byte
		n, err := c.r.Read(one[:])
		if n > 0 {
			c.over = true
			return 0, errTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	return n, err
}

// ImportFile fetches a file from the internet into the staging area of a dataset or model, as
// Upload stages bytes sent: the caller must be able to write it, and the file must come from an
// https URL on the public internet, within the deployment's size limit. Nothing is fetched for
// a caller who may not write, and nothing is staged when the fetch fails.
func (s *Service) ImportFile(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, in api.ImportFile) (*api.DatasetFile, error) {
	if k.Content != "manifest" {
		return nil, Invalid(k.Name+" has no files", nil)
	}
	r, err := s.Get(ctx, caller, &k, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Write, r.RID); err != nil {
		return nil, err
	}
	refused := func(msg string) error { return Invalid("url: "+msg, map[string]any{"field": "url"}) }
	u, err := url.Parse(strings.TrimSpace(in.Url))
	if err != nil || u.Host == "" {
		return nil, refused("not a URL: " + in.Url)
	}
	if u.Scheme != "https" {
		return nil, refused("only https is fetched, not " + u.Scheme)
	}
	if u.User != nil {
		return nil, refused("a user and password do not go in a URL: the catalog fetches public files only")
	}
	// An address written out is refused at once; one a name resolves to, when the public
	// client connects. A client given to the service decides for itself (a test's reaches its
	// own server).
	if a, err := netip.ParseAddr(u.Hostname()); err == nil && !PublicAddress(a) && s.Importer == nil {
		return nil, refused(notPublicError{u.Hostname()}.Error())
	}
	name := path.Base(u.Path)
	if in.Path != nil && strings.TrimSpace(*in.Path) != "" {
		name = *in.Path
	}
	name, err = cleanPath(name)
	if err != nil {
		return nil, Invalid("path: the URL names no file; say the path to stage it at", map[string]any{"field": "path"})
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, refused(err.Error())
	}
	req.Header.Set("User-Agent", "Texera-catalog-import/2.0")
	resp, err := s.importer().Do(req)
	if err != nil {
		var np notPublicError
		if errors.As(err, &np) {
			return nil, refused(np.Error())
		}
		return nil, refused("fetching it failed: " + err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, refused(fmt.Sprintf("%s answered %s", u.Host, resp.Status))
	}
	limit := s.importMax()
	if resp.ContentLength > limit {
		return nil, refused(fmt.Sprintf("the file is %d bytes, more than the %d an import takes", resp.ContentLength, limit))
	}
	body := &capped{r: resp.Body, left: limit}
	f, err := s.Upload(ctx, caller, k, rid, name, body, contentTypeOf(name, resp.Header.Get("Content-Type")))
	if body.over {
		return nil, refused(fmt.Sprintf("the file is more than the %d bytes an import takes", limit))
	}
	return f, err
}

// dataTypes are the types of the files data work imports most, by extension: the system's
// own table may lack them (a container has none).
var dataTypes = map[string]string{
	".csv": "text/csv", ".tsv": "text/tab-separated-values", ".txt": "text/plain", ".json": "application/json",
	".parquet": "application/vnd.apache.parquet", ".zip": "application/zip", ".gz": "application/gzip",
}

// contentTypeOf is what an imported file is stored as: what its name says, for a name with a
// known extension (a server often calls a CSV text/plain), else what the server said.
func contentTypeOf(name, served string) string {
	ext := strings.ToLower(path.Ext(name))
	if t, ok := dataTypes[ext]; ok {
		return t
	}
	if byName := mime.TypeByExtension(ext); byName != "" {
		return byName
	}
	if media, _, err := mime.ParseMediaType(served); err == nil {
		return media
	}
	return "application/octet-stream"
}
