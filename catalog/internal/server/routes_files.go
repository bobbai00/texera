package server

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
)

// readKind is the kind whose version a read of files names: the route's, except that the
// dataset routes read a model's version when the rid names a model, so the agent's dataset file
// tools read a model's card and contract as well. The read itself checks the caller's access.
func (s *Server) readKind(r *http.Request, k kinds.Kind, rid uuid.UUID) kinds.Kind {
	if k.Name != "dataset" {
		return k
	}
	if res, err := s.svc.Store.GetResource(ctxOf(r), rid); err == nil && res.Kind == "model" {
		if m, ok := kinds.ByName("model"); ok {
			return m
		}
	}
	return k
}

// routeFiles registers the file subresources of every kind whose versions are manifests:
// staging, commit, and the files and links of a version.
func (s *Server) routeFiles() {
	for _, k := range kinds.Table {
		if k.Content != "manifest" {
			continue
		}
		k := k
		base := Prefix + "/" + k.Plural + "/{rid}"

		s.handle("PUT "+base+"/files/{path...}", func(w http.ResponseWriter, r *http.Request) error {
			rid, err := ridParam(r, "rid")
			if err != nil {
				return err
			}
			f, err := s.svc.Upload(ctxOf(r), callerOf(r), k, rid, r.PathValue("path"), r.Body, r.Header.Get("Content-Type"))
			if err != nil {
				return err
			}
			writeJSON(w, http.StatusOK, f)
			return nil
		})
		s.handle("DELETE "+base+"/files/{path...}", func(w http.ResponseWriter, r *http.Request) error {
			rid, err := ridParam(r, "rid")
			if err != nil {
				return err
			}
			if err := s.svc.Unstage(ctxOf(r), callerOf(r), k, rid, r.PathValue("path")); err != nil {
				return err
			}
			w.WriteHeader(http.StatusNoContent)
			return nil
		})
		s.handle("GET "+base+"/staged", func(w http.ResponseWriter, r *http.Request) error {
			rid, err := ridParam(r, "rid")
			if err != nil {
				return err
			}
			m, err := s.svc.Staged(ctxOf(r), callerOf(r), k, rid)
			if err != nil {
				return err
			}
			writeJSON(w, http.StatusOK, m)
			return nil
		})
		s.handle("POST "+base+"/commit", func(w http.ResponseWriter, r *http.Request) error {
			rid, err := ridParam(r, "rid")
			if err != nil {
				return err
			}
			var body api.CommitFiles
			if err := decode(r, &body); err != nil {
				return err
			}
			res, v, err := s.svc.Commit(ctxOf(r), callerOf(r), k, rid, body.Message, body.Contract)
			if err != nil {
				return err
			}
			writeJSON(w, http.StatusCreated, catalog.VersionOf(res, v))
			return nil
		})
		s.handle("GET "+base+"/versions/{vno}/files", func(w http.ResponseWriter, r *http.Request) error {
			rid, err := ridParam(r, "rid")
			if err != nil {
				return err
			}
			vno, err := intParam(r, "vno")
			if err != nil {
				return err
			}
			m, err := s.svc.Files(ctxOf(r), callerOf(r), s.readKind(r, k, rid), rid, vno)
			if err != nil {
				return err
			}
			writeJSON(w, http.StatusOK, m)
			return nil
		})
		s.handle("GET "+base+"/versions/{vno}/files/{path...}", func(w http.ResponseWriter, r *http.Request) error {
			rid, err := ridParam(r, "rid")
			if err != nil {
				return err
			}
			vno, err := intParam(r, "vno")
			if err != nil {
				return err
			}
			offset, length := parseRange(r.Header.Get("Range"))
			if max := queryInt(r, "maxBytes", 0); max > 0 && (length <= 0 || int64(max) < length) {
				length = int64(max)
			}
			if limit := s.svc.Config.MaxDownloadBytes; limit > 0 && (length <= 0 || length > limit) {
				length = limit
			}
			f, rc, err := s.svc.Download(ctxOf(r), callerOf(r), s.readKind(r, k, rid), rid, vno, r.PathValue("path"), offset, length)
			if err != nil {
				return err
			}
			defer rc.Close()
			// The contract serves bytes as application/octet-stream; the file's own type is in
			// the manifest and in X-Texera-Content-Type.
			w.Header().Set("Content-Type", "application/octet-stream")
			if f.ContentType != nil && *f.ContentType != "" {
				w.Header().Set("X-Texera-Content-Type", *f.ContentType)
			}
			w.Header().Set("X-Texera-File-Size", strconv.FormatInt(f.Size, 10))
			status := http.StatusOK
			if offset > 0 || (length > 0 && length < f.Size) {
				status = http.StatusPartialContent
				end := f.Size - 1
				if length > 0 && offset+length-1 < end {
					end = offset + length - 1
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, end, f.Size))
			}
			w.WriteHeader(status)
			_, _ = io.Copy(w, rc)
			return nil
		})
		s.handle("GET "+base+"/versions/{vno}/links/{path...}", func(w http.ResponseWriter, r *http.Request) error {
			rid, err := ridParam(r, "rid")
			if err != nil {
				return err
			}
			vno, err := intParam(r, "vno")
			if err != nil {
				return err
			}
			link, err := s.svc.Link(ctxOf(r), callerOf(r), k, rid, vno, r.PathValue("path"))
			if err != nil {
				return err
			}
			writeJSON(w, http.StatusOK, link)
			return nil
		})
	}
}

// parseRange reads "bytes=start-end"; end is inclusive and optional.
func parseRange(h string) (offset, length int64) {
	h = strings.TrimSpace(h)
	if !strings.HasPrefix(h, "bytes=") {
		return 0, 0
	}
	start, end, _ := strings.Cut(strings.TrimPrefix(h, "bytes="), "-")
	offset, _ = strconv.ParseInt(start, 10, 64)
	if end != "" {
		if e, err := strconv.ParseInt(end, 10, 64); err == nil && e >= offset {
			length = e - offset + 1
		}
	}
	return offset, length
}
