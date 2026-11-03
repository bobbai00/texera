package server

import (
	"context"
	"encoding/json"
	"io"
	"strings"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/datasets"
	"github.com/apache/texera/catalog/internal/store"
)

// DatasetsUpload stages a file.
func (s *Server) DatasetsUpload(ctx context.Context, req api.DatasetsUploadRequestObject) (api.DatasetsUploadResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "dataset", authz.ActionWrite)
	if err != nil {
		return nil, err
	}
	f, err := s.stageFile(ctx, r, req.Path, req.Body)
	if err != nil {
		return nil, err
	}
	return api.DatasetsUpload200JSONResponse(*f), nil
}

// stageFile puts one file into a dataset's staging area; the next commit makes it part of a version.
func (s *Server) stageFile(ctx context.Context, r *store.Resource, path string, body io.Reader) (*api.DatasetFile, error) {
	path = strings.TrimPrefix(path, "/")
	if path == "" || strings.Contains(path, "..") {
		return nil, badRequest("invalid path")
	}
	key := datasets.StagingKey(r.RID.String(), path)
	up, err := s.files.Put(ctx, key, body, contentTypeFor(path))
	if err != nil {
		return nil, unavailable("object store", err)
	}
	sha := up.SHA256
	ct := up.ContentType
	if err := s.store.UpsertStagedFile(ctx, store.StagedFile{RID: r.RID, Path: path, Size: up.Size, SHA256: &sha, ContentType: &ct, ObjectKey: key}); err != nil {
		return nil, err
	}
	s.refreshDatasetStatus(ctx, r)
	return &api.DatasetFile{Path: path, Size: up.Size, Sha256: &sha, ContentType: &ct}, nil
}

func contentTypeFor(path string) string {
	switch {
	case strings.HasSuffix(path, ".csv"):
		return "text/csv"
	case strings.HasSuffix(path, ".json"):
		return "application/json"
	case strings.HasSuffix(path, ".txt"), strings.HasSuffix(path, ".md"):
		return "text/plain"
	case strings.HasSuffix(path, ".parquet"):
		return "application/vnd.apache.parquet"
	}
	return "application/octet-stream"
}

func (s *Server) refreshDatasetStatus(ctx context.Context, r *store.Resource) {
	staged, err := s.store.ListStagedFiles(ctx, r.RID)
	if err != nil {
		return
	}
	var bytes int64
	for _, f := range staged {
		bytes += f.Size
	}
	_ = s.store.UpdateStatus(ctx, r.RID, mustJSON(api.DatasetStatus{StagedFiles: int32(len(staged)), Bytes: bytes}))
}

// DatasetsUnstage removes a staged file.
func (s *Server) DatasetsUnstage(ctx context.Context, req api.DatasetsUnstageRequestObject) (api.DatasetsUnstageResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "dataset", authz.ActionWrite)
	if err != nil {
		return nil, err
	}
	f, err := s.store.DeleteStagedFile(ctx, r.RID, strings.TrimPrefix(req.Path, "/"))
	if err != nil {
		return nil, err
	}
	_ = s.files.Delete(ctx, f.ObjectKey)
	s.refreshDatasetStatus(ctx, r)
	return api.DatasetsUnstage204Response{}, nil
}

// DatasetsStaged lists staged files.
func (s *Server) DatasetsStaged(ctx context.Context, req api.DatasetsStagedRequestObject) (api.DatasetsStagedResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "dataset", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	staged, err := s.store.ListStagedFiles(ctx, r.RID)
	if err != nil {
		return nil, err
	}
	return api.DatasetsStaged200JSONResponse(api.DatasetManifest{Files: stagedToFiles(staged)}), nil
}

func stagedToFiles(staged []store.StagedFile) []api.DatasetFile {
	out := make([]api.DatasetFile, 0, len(staged))
	for _, f := range staged {
		out = append(out, api.DatasetFile{Path: f.Path, Size: f.Size, Sha256: f.SHA256, ContentType: f.ContentType})
	}
	return out
}

// DatasetsCommit turns the staged files, merged over the head version's files, into a new
// immutable version.
func (s *Server) DatasetsCommit(ctx context.Context, req api.DatasetsCommitRequestObject) (api.DatasetsCommitResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "dataset", authz.ActionWrite)
	if err != nil {
		return nil, err
	}
	var message *string
	var bodyOrigin *api.Origin
	if req.Body != nil {
		bodyOrigin, message = req.Body.Origin, req.Body.Message
	}
	v, err := s.commitStaged(ctx, caller, r, message, bodyOrigin)
	if err != nil {
		return nil, err
	}
	return api.DatasetsCommit200JSONResponse(toVersion(v, r.Kind)), nil
}

// commitStaged makes the staged files a new version of the dataset. Files of the head version that
// were not replaced are carried forward, so every version prefix is self-contained.
func (s *Server) commitStaged(ctx context.Context, caller *authn.Caller, r *store.Resource, message *string, bodyOrigin *api.Origin) (*store.Version, error) {
	staged, err := s.store.ListStagedFiles(ctx, r.RID)
	if err != nil {
		return nil, err
	}
	if len(staged) == 0 {
		return nil, badRequest("nothing is staged")
	}
	// Carry the previous version's files forward unless replaced.
	files := map[string]api.DatasetFile{}
	if r.HeadVno > 0 {
		if head, err := s.store.GetVersion(ctx, r.RID, 0); err == nil {
			var m api.DatasetManifest
			_ = json.Unmarshal(head.Content, &m)
			for _, f := range m.Files {
				files[f.Path] = f
			}
		}
	}
	nextVno := r.HeadVno + 1
	for _, f := range staged {
		if err := s.files.Copy(ctx, f.ObjectKey, datasets.VersionKey(r.RID.String(), nextVno, f.Path)); err != nil {
			return nil, unavailable("object store", err)
		}
		files[f.Path] = api.DatasetFile{Path: f.Path, Size: f.Size, Sha256: f.SHA256, ContentType: f.ContentType}
	}
	// Carried-forward files are copied too so a version prefix is self-contained.
	for path, f := range files {
		replaced := false
		for _, st := range staged {
			if st.Path == path {
				replaced = true
				break
			}
		}
		if !replaced {
			if err := s.files.Copy(ctx, datasets.VersionKey(r.RID.String(), r.HeadVno, path), datasets.VersionKey(r.RID.String(), nextVno, path)); err != nil {
				return nil, unavailable("object store", err)
			}
		}
		_ = f
	}
	manifest := api.DatasetManifest{Files: make([]api.DatasetFile, 0, len(files))}
	for _, f := range files {
		manifest.Files = append(manifest.Files, f)
	}
	sortFiles(manifest.Files)
	origin, err := originFor(caller, bodyOrigin)
	if err != nil {
		return nil, err
	}
	expected := r.HeadVno
	v, err := s.store.CreateVersion(ctx, store.NewVersion{RID: r.RID, ContentKind: "manifest", Content: mustJSON(manifest), Message: message,
		CreatedByPID: caller.Actor(), OnBehalfOfPID: onBehalfOf(caller), Origin: origin, ExpectedHead: &expected})
	if err != nil {
		return nil, err
	}
	for _, f := range staged {
		_ = s.files.Delete(ctx, f.ObjectKey)
	}
	_ = s.store.ClearStagedFiles(ctx, r.RID)
	_ = s.store.UpdateStatus(ctx, r.RID, mustJSON(api.DatasetStatus{StagedFiles: 0}))
	return v, nil
}

func sortFiles(fs []api.DatasetFile) {
	for i := 1; i < len(fs); i++ {
		for j := i; j > 0 && fs[j-1].Path > fs[j].Path; j-- {
			fs[j-1], fs[j] = fs[j], fs[j-1]
		}
	}
}

func (s *Server) manifestOf(ctx context.Context, r *store.Resource, vno int32) (*api.DatasetManifest, error) {
	v, err := s.store.GetVersion(ctx, r.RID, vno)
	if err != nil {
		return nil, notFound("dataset version")
	}
	var m api.DatasetManifest
	if err := json.Unmarshal(v.Content, &m); err != nil {
		return nil, err
	}
	if m.Files == nil {
		m.Files = []api.DatasetFile{}
	}
	return &m, nil
}

// DatasetsFiles lists a version's files.
func (s *Server) DatasetsFiles(ctx context.Context, req api.DatasetsFilesRequestObject) (api.DatasetsFilesResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "dataset", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	m, err := s.manifestOf(ctx, r, req.Vno)
	if err != nil {
		return nil, err
	}
	return api.DatasetsFiles200JSONResponse(*m), nil
}

// DatasetsDownload streams a bounded prefix of a file.
func (s *Server) DatasetsDownload(ctx context.Context, req api.DatasetsDownloadRequestObject) (api.DatasetsDownloadResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "dataset", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	m, err := s.manifestOf(ctx, r, req.Vno)
	if err != nil {
		return nil, err
	}
	path := strings.TrimPrefix(req.Path, "/")
	if !hasFile(m, path) {
		return nil, notFound("file")
	}
	max := s.cfg.MaxDownloadBytes
	if req.Params.MaxBytes != nil && int64(*req.Params.MaxBytes) > 0 && int64(*req.Params.MaxBytes) < max {
		max = int64(*req.Params.MaxBytes)
	}
	body, n, err := s.files.Get(ctx, datasets.VersionKey(r.RID.String(), req.Vno, path), max)
	if err != nil {
		return nil, unavailable("object store", err)
	}
	return api.DatasetsDownload200ApplicationoctetStreamResponse{Body: body, ContentLength: n}, nil
}

func hasFile(m *api.DatasetManifest, path string) bool {
	for _, f := range m.Files {
		if f.Path == path {
			return true
		}
	}
	return false
}

// DatasetsLink presigns a file URL.
func (s *Server) DatasetsLink(ctx context.Context, req api.DatasetsLinkRequestObject) (api.DatasetsLinkResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "dataset", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	m, err := s.manifestOf(ctx, r, req.Vno)
	if err != nil {
		return nil, err
	}
	path := strings.TrimPrefix(req.Path, "/")
	if !hasFile(m, path) {
		return nil, notFound("file")
	}
	url, ttl, err := s.files.Presign(ctx, datasets.VersionKey(r.RID.String(), req.Vno, path))
	if err != nil {
		return nil, unavailable("presign", err)
	}
	return api.DatasetsLink200JSONResponse(api.FileLink{Url: url, ExpiresInSeconds: int32(ttl.Seconds())}), nil
}

var _ io.Reader = (io.Reader)(nil)
