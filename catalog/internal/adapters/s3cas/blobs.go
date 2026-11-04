// Package s3cas is the BlobStore adapter: content-addressed objects on S3-compatible storage,
// under blobs/sha256/{aa}/{digest}. The same bytes are stored once; presigned URLs let
// engines and browsers read without the catalog in the path.
package s3cas

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/apache/texera/catalog/internal/ports"
)

// Options configure the adapter.
type Options struct {
	Endpoint string
	// PublicEndpoint is what presigned URLs point at, reachable by engines and browsers.
	PublicEndpoint string
	Region         string
	AccessKey      string
	SecretKey      string
	Bucket         string
	PathStyle      bool
}

// Blobs implements ports.BlobStore.
type Blobs struct {
	opts    Options
	client  *s3.Client
	presign *s3.PresignClient
}

// New builds the adapter. The presigner signs against PublicEndpoint.
func New(opts Options) *Blobs {
	mk := func(endpoint string) *s3.Client {
		return s3.New(s3.Options{
			Region:       opts.Region,
			BaseEndpoint: aws.String(endpoint),
			UsePathStyle: opts.PathStyle,
			Credentials:  credentials.NewStaticCredentialsProvider(opts.AccessKey, opts.SecretKey, ""),
		})
	}
	b := &Blobs{opts: opts, client: mk(opts.Endpoint)}
	pub := opts.PublicEndpoint
	if pub == "" {
		pub = opts.Endpoint
	}
	b.presign = s3.NewPresignClient(mk(pub))
	return b
}

// Key returns the object key of a digest.
func Key(digest string) string {
	hex := strings.TrimPrefix(digest, "sha256:")
	if len(hex) < 2 {
		return "blobs/sha256/" + hex
	}
	return "blobs/sha256/" + hex[:2] + "/" + hex
}

// Put stores the bytes unless the digest is already stored. A body that cannot seek is
// spooled to a temporary file, since the S3 signer needs to read it twice.
func (b *Blobs) Put(ctx context.Context, digest string, size int64, body io.Reader, contentType string) error {
	exists, err := b.Exists(ctx, digest)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	seeker, ok := body.(io.ReadSeeker)
	if !ok {
		tmp, err := os.CreateTemp("", "texera-blob-*")
		if err != nil {
			return err
		}
		defer os.Remove(tmp.Name())
		defer tmp.Close()
		if _, err := io.Copy(tmp, body); err != nil {
			return err
		}
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			return err
		}
		seeker = tmp
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err = b.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(b.opts.Bucket),
		Key:           aws.String(Key(digest)),
		Body:          seeker,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
	})
	if err != nil {
		return fmt.Errorf("put %s: %w", digest, err)
	}
	return nil
}

// Exists reports whether the digest is stored.
func (b *Blobs) Exists(ctx context.Context, digest string) (bool, error) {
	_, err := b.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(b.opts.Bucket), Key: aws.String(Key(digest))})
	if err == nil {
		return true, nil
	}
	var notFound *types.NotFound
	if errors.As(err, &notFound) || strings.Contains(err.Error(), "NotFound") || strings.Contains(err.Error(), "404") {
		return false, nil
	}
	return false, fmt.Errorf("head %s: %w", digest, err)
}

// Get reads a range of the blob.
func (b *Blobs) Get(ctx context.Context, digest string, offset, length int64) (io.ReadCloser, error) {
	in := &s3.GetObjectInput{Bucket: aws.String(b.opts.Bucket), Key: aws.String(Key(digest))}
	switch {
	case length > 0:
		in.Range = aws.String(fmt.Sprintf("bytes=%d-%d", offset, offset+length-1))
	case offset > 0:
		in.Range = aws.String(fmt.Sprintf("bytes=%d-", offset))
	}
	out, err := b.client.GetObject(ctx, in)
	if err != nil {
		var noKey *types.NoSuchKey
		if errors.As(err, &noKey) || strings.Contains(err.Error(), "NoSuchKey") {
			return nil, ports.ErrBlobNotFound
		}
		return nil, fmt.Errorf("get %s: %w", digest, err)
	}
	return out.Body, nil
}

// Delete removes the object; a missing one is not an error.
func (b *Blobs) Delete(ctx context.Context, digest string) error {
	if _, err := b.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(b.opts.Bucket), Key: aws.String(Key(digest))}); err != nil {
		var noKey *types.NoSuchKey
		if errors.As(err, &noKey) || strings.Contains(err.Error(), "NoSuchKey") {
			return nil
		}
		return fmt.Errorf("delete %s: %w", digest, err)
	}
	return nil
}

// Presign returns a GET URL served under filename.
func (b *Blobs) Presign(ctx context.Context, digest, filename string, ttl time.Duration) (string, error) {
	in := &s3.GetObjectInput{Bucket: aws.String(b.opts.Bucket), Key: aws.String(Key(digest))}
	if filename != "" {
		in.ResponseContentDisposition = aws.String(`inline; filename="` + strings.ReplaceAll(filename, `"`, "") + `"`)
	}
	out, err := b.presign.PresignGetObject(ctx, in, func(po *s3.PresignOptions) { po.Expires = ttl })
	if err != nil {
		return "", err
	}
	return out.URL, nil
}
