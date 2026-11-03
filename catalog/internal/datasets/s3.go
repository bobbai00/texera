// Package datasets stores dataset files on S3-compatible object storage. A dataset's
// staged files live under `staging/{rid}/{path}`; a committed version copies them to the
// immutable prefix `versions/{rid}/v{vno}/{path}` and records a manifest in the catalog.
package datasets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Options configure the object store.
type Options struct {
	Endpoint       string
	PublicEndpoint string
	Region         string
	AccessKey      string
	SecretKey      string
	Bucket         string
	PathStyle      bool
	PresignTTL     time.Duration
}

// Store is the S3 dataset store.
type Store struct {
	opts    Options
	client  *s3.Client
	public  *s3.Client
	presign *s3.PresignClient
}

// New builds the store. The public client signs URLs against PublicEndpoint so engines
// and browsers outside the cluster can read them.
func New(opts Options) *Store {
	mk := func(endpoint string) *s3.Client {
		return s3.New(s3.Options{
			Region:       opts.Region,
			BaseEndpoint: aws.String(endpoint),
			UsePathStyle: opts.PathStyle,
			Credentials:  credentials.NewStaticCredentialsProvider(opts.AccessKey, opts.SecretKey, ""),
		})
	}
	st := &Store{opts: opts, client: mk(opts.Endpoint)}
	pub := opts.PublicEndpoint
	if pub == "" {
		pub = opts.Endpoint
	}
	st.public = mk(pub)
	st.presign = s3.NewPresignClient(st.public)
	return st
}

// StagingKey is the object key of a staged file.
func StagingKey(rid, path string) string { return "staging/" + rid + "/" + cleanPath(path) }

// VersionKey is the object key of a committed file.
func VersionKey(rid string, vno int32, path string) string {
	return fmt.Sprintf("versions/%s/v%d/%s", rid, vno, cleanPath(path))
}

func cleanPath(p string) string {
	p = strings.TrimPrefix(p, "/")
	parts := strings.Split(p, "/")
	out := parts[:0]
	for _, s := range parts {
		if s == "" || s == "." || s == ".." {
			continue
		}
		out = append(out, s)
	}
	return strings.Join(out, "/")
}

// Uploaded describes a stored object.
type Uploaded struct {
	Key         string
	Size        int64
	SHA256      string
	ContentType string
}

// Put streams body into key, hashing it on the way.
func (s *Store) Put(ctx context.Context, key string, body io.Reader, contentType string) (*Uploaded, error) {
	h := sha256.New()
	counter := &countingReader{r: io.TeeReader(body, h)}
	// S3 PutObject needs the length for non-seekable bodies on many servers; buffer through a
	// multipart-free upload by reading fully. Datasets in the slice are small; the manager
	// uploader can replace this.
	data, err := io.ReadAll(counter)
	if err != nil {
		return nil, err
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.opts.Bucket),
		Key:           aws.String(key),
		Body:          strings.NewReader(string(data)),
		ContentLength: aws.Int64(int64(len(data))),
		ContentType:   aws.String(contentType),
	})
	if err != nil {
		return nil, fmt.Errorf("put %s: %w", key, err)
	}
	return &Uploaded{Key: key, Size: int64(len(data)), SHA256: hex.EncodeToString(h.Sum(nil)), ContentType: contentType}, nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// Get opens an object, optionally limited to the first maxBytes.
func (s *Store) Get(ctx context.Context, key string, maxBytes int64) (io.ReadCloser, int64, error) {
	in := &s3.GetObjectInput{Bucket: aws.String(s.opts.Bucket), Key: aws.String(key)}
	if maxBytes > 0 {
		in.Range = aws.String(fmt.Sprintf("bytes=0-%d", maxBytes-1))
	}
	out, err := s.client.GetObject(ctx, in)
	if err != nil {
		return nil, 0, fmt.Errorf("get %s: %w", key, err)
	}
	var n int64
	if out.ContentLength != nil {
		n = *out.ContentLength
	}
	return out.Body, n, nil
}

// Delete removes an object.
func (s *Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.opts.Bucket), Key: aws.String(key)})
	return err
}

// Copy copies an object within the bucket.
func (s *Store) Copy(ctx context.Context, from, to string) error {
	_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(s.opts.Bucket),
		CopySource: aws.String(s.opts.Bucket + "/" + url.PathEscape(from)),
		Key:        aws.String(to),
	})
	if err != nil {
		return fmt.Errorf("copy %s -> %s: %w", from, to, err)
	}
	return nil
}

// Presign returns a GET URL for key valid for the configured TTL.
func (s *Store) Presign(ctx context.Context, key string) (string, time.Duration, error) {
	ttl := s.opts.PresignTTL
	if ttl == 0 {
		ttl = time.Hour
	}
	out, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.opts.Bucket), Key: aws.String(key)},
		func(po *s3.PresignOptions) { po.Expires = ttl })
	if err != nil {
		return "", 0, err
	}
	return out.URL, ttl, nil
}
