package catalog

import (
	"context"
	"encoding/json"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/store"
)

// Retention: what an execution and an upload leave behind is kept as the settings say. A
// finished execution's result tables are dropped from the lake once older than the policy, and
// it keeps its record and summaries with resultsExpiredAt set; a blob no version and no staging
// names is removed from the blob store a day (or the policy) after its upload.

// defaultBlobAge is how long an unreferenced blob lives when the settings name no policy: long
// enough for an upload to be committed.
const defaultBlobAge = 24 * time.Hour

// KeepLabel marks an execution whose results the policy leaves alone.
const KeepLabel = "texera.keep"

// Sweep executions one retention pass as the janitor does; administrators may ask for one.
func (s *Service) Sweep(ctx context.Context, caller *auth.Caller) (*api.RetentionSweep, error) {
	if !caller.Admin() && !caller.Service {
		return nil, Forbidden()
	}
	out := s.sweep(ctx)
	return &out, nil
}

// RunRetention sweeps every interval until the context ends.
func (s *Service) RunRetention(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sweep(ctx)
		}
	}
}

func (s *Service) sweep(ctx context.Context) api.RetentionSweep {
	var out api.RetentionSweep
	policy := s.settingsSpec(ctx).Retention
	if policy != nil && policy.Results != nil {
		out.ExecutionsExpired = int32(s.expireResults(ctx, time.Now().Add(-asDuration(*policy.Results))))
	}
	blobAge := defaultBlobAge
	if policy != nil && policy.Blobs != nil {
		blobAge = asDuration(*policy.Blobs)
	}
	out.BlobsDeleted = int32(s.removeUnreferencedBlobs(ctx, time.Now().Add(-blobAge)))
	return out
}

// expireResults drops the tables of finished executions last changed before the instant.
func (s *Service) expireResults(ctx context.Context, before time.Time) int {
	n := 0
	for _, phase := range []api.ExecutionPhase{api.ExecutionPhaseCompleted, api.ExecutionPhaseFailed, api.ExecutionPhaseCancelled} {
		executions, err := s.Store.ListResources(ctx, store.ResourceFilter{
			Kind: "execution", Fields: map[string]string{"/status/phase": string(phase)},
			Absent: []string{"/status/resultsExpiredAt"}, WithoutLabel: KeepLabel, UpdatedBefore: &before, Limit: 500,
		})
		if err != nil {
			s.Log.Warn("retention: list executions", "err", err)
			continue
		}
		for i := range executions {
			if err := s.Lake.DropNamespace(ctx, executionNamespace(executions[i].RID)); err != nil {
				s.Log.Warn("retention: drop namespace", "execution", executions[i].RID, "err", err)
				continue
			}
			now := time.Now().UTC()
			if _, err := s.Store.MergeStatus(ctx, executions[i].RID, mustJSON(map[string]any{"resultsExpiredAt": now})); err != nil {
				s.Log.Warn("retention: mark expired", "execution", executions[i].RID, "err", err)
				continue
			}
			n++
		}
	}
	if n > 0 {
		s.Log.Info("retention: results expired", "executions", n)
	}
	return n
}

// removeUnreferencedBlobs deletes blobs uploaded before the instant that nothing names.
func (s *Service) removeUnreferencedBlobs(ctx context.Context, before time.Time) int {
	digests, err := s.Store.UnreferencedBlobs(ctx, before, 500)
	if err != nil {
		s.Log.Warn("retention: list blobs", "err", err)
		return 0
	}
	n := 0
	for _, digest := range digests {
		if err := s.Blobs.Delete(ctx, digest); err != nil {
			s.Log.Warn("retention: delete blob", "digest", digest, "err", err)
			continue
		}
		if err := s.Store.DeleteBlob(ctx, digest); err != nil {
			s.Log.Warn("retention: forget blob", "digest", digest, "err", err)
			continue
		}
		n++
	}
	if n > 0 {
		s.Log.Info("retention: blobs removed", "blobs", n)
	}
	return n
}

// asDuration reads an ISO 8601 duration as a span: a month counts thirty days, a year 365.
func asDuration(d openapi_types.Duration) time.Duration {
	days := d.Years*365 + d.Months*30 + d.Weeks*7 + d.Days
	return time.Duration(days)*24*time.Hour + time.Duration(d.Hours)*time.Hour + time.Duration(d.Minutes)*time.Minute + time.Duration(d.Seconds*float64(time.Second))
}

// resultsExpired reports whether the retention policy dropped an execution's tables.
func resultsExpired(r *store.Resource) *time.Time {
	var st api.ExecutionStatus
	if err := json.Unmarshal(r.Status, &st); err != nil {
		return nil
	}
	return st.ResultsExpiredAt
}
