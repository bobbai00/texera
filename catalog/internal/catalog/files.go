package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
)

// cleanPath normalizes a file path inside a version.
func cleanPath(p string) (string, error) {
	p = strings.TrimPrefix(strings.TrimSpace(p), "/")
	var parts []string
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			continue
		}
		parts = append(parts, seg)
	}
	if len(parts) == 0 {
		return "", Invalid("a file path is required", nil)
	}
	return strings.Join(parts, "/"), nil
}

// Upload stores a file in the staging area of a dataset or model: the bytes are hashed on
// the way, stored once by digest, and the path waits for a commit.
func (s *Service) Upload(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, path string, body io.Reader, contentType string) (*api.DatasetFile, error) {
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
	path, err = cleanPath(path)
	if err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp("", "texera-upload-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), body)
	if err != nil {
		return nil, Invalid("reading the upload: "+err.Error(), nil)
	}
	digest := "sha256:" + hex.EncodeToString(h.Sum(nil))
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if err := s.Blobs.Put(ctx, digest, size, tmp, contentType); err != nil {
		return nil, Unavailable("blob store", err)
	}
	if _, err := s.Store.EnsureBlob(ctx, store.Blob{SHA256: digest, Size: size, ContentType: &contentType}); err != nil {
		return nil, err
	}
	if err := s.Store.Stage(ctx, store.StagedFile{RID: rid, Path: path, SHA256: digest, Size: size, ContentType: &contentType}); err != nil {
		return nil, err
	}
	s.refreshFileStatus(ctx, r)
	return &api.DatasetFile{Path: path, Size: size, Sha256: api.Digest(digest), ContentType: &contentType}, nil
}

// Unstage drops a staged file.
func (s *Service) Unstage(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, path string) error {
	r, err := s.Get(ctx, caller, &k, rid)
	if err != nil {
		return err
	}
	if err := s.require(ctx, caller, authz.Write, r.RID); err != nil {
		return err
	}
	path, err = cleanPath(path)
	if err != nil {
		return err
	}
	if err := s.Store.Unstage(ctx, rid, path); err != nil {
		return wrap(err, "staged file "+path)
	}
	s.refreshFileStatus(ctx, r)
	return nil
}

// Staged lists the files waiting for a commit.
func (s *Service) Staged(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID) (*api.Manifest, error) {
	if _, err := s.Get(ctx, caller, &k, rid); err != nil {
		return nil, err
	}
	staged, err := s.Store.ListStaged(ctx, rid)
	if err != nil {
		return nil, err
	}
	m := &api.Manifest{Files: []api.DatasetFile{}}
	for _, f := range staged {
		m.Files = append(m.Files, api.DatasetFile{Path: f.Path, Size: f.Size, Sha256: api.Digest(f.SHA256), ContentType: f.ContentType})
	}
	return m, nil
}

// Commit makes a version from the head version's files overlaid with the staged ones.
func (s *Service) Commit(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, message *string) (*store.Resource, *store.Version, error) {
	r, err := s.Get(ctx, caller, &k, rid)
	if err != nil {
		return nil, nil, err
	}
	if err := s.require(ctx, caller, authz.Write, r.RID); err != nil {
		return nil, nil, err
	}
	staged, err := s.Store.ListStaged(ctx, rid)
	if err != nil {
		return nil, nil, err
	}
	if len(staged) == 0 {
		return nil, nil, Conflict("nothing_staged", "upload files before committing", nil)
	}
	files := map[string]api.DatasetFile{}
	if r.HeadVno > 0 {
		if head, err := s.Store.GetVersion(ctx, rid, 0); err == nil {
			var m api.Manifest
			_ = json.Unmarshal(head.Content, &m)
			for _, f := range m.Files {
				files[f.Path] = f
			}
		}
	}
	for _, f := range staged {
		files[f.Path] = api.DatasetFile{Path: f.Path, Size: f.Size, Sha256: api.Digest(f.SHA256), ContentType: f.ContentType}
	}
	manifest := api.Manifest{Files: make([]api.DatasetFile, 0, len(files))}
	for _, f := range files {
		manifest.Files = append(manifest.Files, f)
	}
	sortFiles(manifest.Files)
	v, err := s.Store.CreateVersion(ctx, store.NewVersion{RID: rid, ContentKind: "manifest", Content: mustJSON(manifest), Message: message, CreatedByPID: caller.PID(), Origin: caller.Origin, ClearStaging: true})
	if err != nil {
		return nil, nil, wrap(err, k.Name)
	}
	r, _ = s.Store.GetResource(ctx, rid)
	s.refreshFileStatus(ctx, r)
	return r, v, nil
}

func sortFiles(files []api.DatasetFile) {
	for i := 1; i < len(files); i++ {
		for j := i; j > 0 && files[j].Path < files[j-1].Path; j-- {
			files[j], files[j-1] = files[j-1], files[j]
		}
	}
}

// refreshFileStatus records the head's file count and bytes and the staged count.
func (s *Service) refreshFileStatus(ctx context.Context, r *store.Resource) {
	status := map[string]any{"files": 0, "bytes": 0, "staged": 0}
	if r.HeadVno > 0 {
		if head, err := s.Store.GetVersion(ctx, r.RID, 0); err == nil {
			var m api.Manifest
			_ = json.Unmarshal(head.Content, &m)
			var bytes int64
			for _, f := range m.Files {
				bytes += f.Size
			}
			status["files"], status["bytes"] = len(m.Files), bytes
		}
	}
	if staged, err := s.Store.ListStaged(ctx, r.RID); err == nil {
		status["staged"] = len(staged)
	}
	_, _ = s.Store.MergeStatus(ctx, r.RID, mustJSON(status))
}

// Files returns the manifest of a version.
func (s *Service) Files(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, vno int) (*api.Manifest, error) {
	_, v, err := s.Version(ctx, caller, &k, rid, vno)
	if err != nil {
		return nil, err
	}
	var m api.Manifest
	if err := json.Unmarshal(v.Content, &m); err != nil {
		return nil, fmt.Errorf("manifest of version %d: %w", vno, err)
	}
	if m.Files == nil {
		m.Files = []api.DatasetFile{}
	}
	return &m, nil
}

// File finds one file of a version.
func (s *Service) File(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, vno int, path string) (*api.DatasetFile, error) {
	path, err := cleanPath(path)
	if err != nil {
		return nil, err
	}
	m, err := s.Files(ctx, caller, k, rid, vno)
	if err != nil {
		return nil, err
	}
	for _, f := range m.Files {
		if f.Path == path {
			return &f, nil
		}
	}
	return nil, NotFound("file " + path)
}

// Download opens a file of a version from offset, at most length bytes (0 means all).
func (s *Service) Download(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, vno int, path string, offset, length int64) (*api.DatasetFile, io.ReadCloser, error) {
	f, err := s.File(ctx, caller, k, rid, vno, path)
	if err != nil {
		return nil, nil, err
	}
	rc, err := s.Blobs.Get(ctx, string(f.Sha256), offset, length)
	if err != nil {
		return nil, nil, Unavailable("blob store", err)
	}
	return f, rc, nil
}

// Link returns a presigned URL for a file of a version.
func (s *Service) Link(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, vno int, path string) (*api.FileLink, error) {
	f, err := s.File(ctx, caller, k, rid, vno, path)
	if err != nil {
		return nil, err
	}
	ttl := s.Config.PresignTTL
	url, err := s.Blobs.Presign(ctx, string(f.Sha256), f.Path[strings.LastIndex(f.Path, "/")+1:], ttl)
	if err != nil {
		return nil, Unavailable("blob store", err)
	}
	return &api.FileLink{Url: url, ExpiresInSeconds: int32(ttl.Seconds())}, nil
}
