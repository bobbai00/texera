package server_test

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeS3 is an in-memory, path-style object store with the four calls the catalog makes: put,
// copy, get (with a byte range) and delete. Enough to run uploads and commits end to end.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	srv     *httptest.Server
}

func newFakeS3(t *testing.T) *fakeS3 {
	f := &fakeS3{objects: map[string][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeS3) serve(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/")
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.Method {
	case http.MethodPut:
		if src := r.Header.Get("X-Amz-Copy-Source"); src != "" {
			src, _ = url.PathUnescape(src)
			data, ok := f.objects[strings.TrimPrefix(src, "/")]
			if !ok {
				noSuchKey(w)
				return
			}
			f.objects[key] = append([]byte(nil), data...)
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"0"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>`)
			return
		}
		body, err := readBody(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.objects[key] = body
		w.Header().Set("ETag", `"0"`)
	case http.MethodGet:
		data, ok := f.objects[key]
		if !ok {
			noSuchKey(w)
			return
		}
		if rng := r.Header.Get("Range"); strings.HasPrefix(rng, "bytes=0-") {
			if end, err := strconv.Atoi(strings.TrimPrefix(rng, "bytes=0-")); err == nil && end+1 < len(data) {
				data = data[:end+1]
			}
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data)
	case http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// readBody returns an object's bytes, undoing the SDK's aws-chunked framing when it streams.
func readBody(r *http.Request) ([]byte, error) {
	if !strings.Contains(r.Header.Get("Content-Encoding"), "aws-chunked") &&
		!strings.HasPrefix(r.Header.Get("X-Amz-Content-Sha256"), "STREAMING-") {
		return io.ReadAll(r.Body)
	}
	var out bytes.Buffer
	rd := bufio.NewReader(r.Body)
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return nil, err
		}
		size, err := strconv.ParseInt(strings.TrimSpace(strings.SplitN(line, ";", 2)[0]), 16, 64)
		if err != nil {
			return nil, err
		}
		if size == 0 {
			return out.Bytes(), nil // trailers (checksums) follow; nothing to keep
		}
		if _, err := io.CopyN(&out, rd, size); err != nil {
			return nil, err
		}
		if _, err := rd.ReadString('\n'); err != nil {
			return nil, err
		}
	}
}

func noSuchKey(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusNotFound)
	fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>not found</Message></Error>`)
}
