package catalog

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

// Retention: what an execution and an upload leave behind is kept as long as the projects say. A
// finished execution's result tables are dropped from the lake once older than its project's
// limit (`limits.results`, the shortest along the project's chain), and it keeps its record and
// summaries with resultsExpiredAt set; an upload no version and no staging names belongs to no
// project, and is removed from the blob store once older than the deployment's grace period.

// defaultUploadGrace is how long an unreferenced upload lives when the deployment sets no grace
// period: long enough for it to be committed.
const defaultUploadGrace = 24 * time.Hour

// KeepLabel marks an execution whose results the policy leaves alone.
const KeepLabel = "texera.keep"

// Sweep executions one retention pass as the janitor does; Texera's admins may ask for one.
func (s *Service) Sweep(ctx context.Context, caller *auth.Caller) (*api.RetentionSweep, error) {
	if !caller.Service {
		root := s.Root()
		if root == nil {
			return nil, Forbidden()
		}
		if err := s.require(ctx, caller, authz.Admin, root.RID); err != nil {
			return nil, err
		}
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
	now := time.Now()
	out.ExecutionsExpired = int32(s.expireResults(ctx, now))
	grace := s.Config.UploadGrace
	if grace <= 0 {
		grace = defaultUploadGrace
	}
	out.BlobsDeleted = int32(s.removeUnreferencedBlobs(ctx, now.Add(-grace)))
	return out
}

// expireResults drops the tables of the finished executions older than their project's limit.
// Only a project that sets a limit can make one hold, so the shortest limit set anywhere bounds
// what is looked at; each execution is then held to its own project's.
func (s *Service) expireResults(ctx context.Context, now time.Time) int {
	limited, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: projectKind.Name, Present: []string{"/spec/limits/results"}, Limit: 500})
	if err != nil {
		s.Log.Warn("retention: list projects", "err", err)
		return 0
	}
	var shortest *time.Duration
	for i := range limited {
		var spec api.ProjectSpec
		if json.Unmarshal(limited[i].Spec, &spec) != nil || spec.Limits == nil || spec.Limits.Results == nil {
			continue
		}
		if d := asDuration(*spec.Limits.Results); shortest == nil || d < *shortest {
			shortest = &d
		}
	}
	if shortest == nil {
		return 0
	}
	before := now.Add(-*shortest)
	limits := map[uuid.UUID]*time.Duration{}
	limitOf := func(project *uuid.UUID) *time.Duration {
		if project == nil {
			return nil
		}
		if d, ok := limits[*project]; ok {
			return d
		}
		var d *time.Duration
		if settings, err := s.settingsOf(ctx, *project); err == nil && settings.Limits.Results != nil {
			v := asDuration(*settings.Limits.Results)
			d = &v
		}
		limits[*project] = d
		return d
	}
	n := 0
	for _, phase := range []api.ExecutionPhase{api.ExecutionPhaseCompleted, api.ExecutionPhaseFailed, api.ExecutionPhaseCancelled} {
		for offset := 0; offset < 20*500; offset += 500 {
			executions, err := s.Store.ListResources(ctx, store.ResourceFilter{
				Kind: "execution", Fields: map[string]string{"/status/phase": string(phase)},
				Absent: []string{"/status/resultsExpiredAt"}, WithoutLabel: KeepLabel, UpdatedBefore: &before, Limit: 500, Offset: offset,
			})
			if err != nil {
				s.Log.Warn("retention: list executions", "err", err)
				break
			}
			for i := range executions {
				limit := limitOf(executions[i].ProjectRID)
				if limit == nil || executions[i].UpdatedAt.After(now.Add(-*limit)) {
					continue
				}
				if err := s.Lake.DropNamespace(ctx, s.warehouseOf(ctx, &executions[i]), executionNamespace(executions[i].RID)); err != nil {
					s.Log.Warn("retention: drop namespace", "execution", executions[i].RID, "err", err)
					continue
				}
				if _, err := s.Store.MergeStatus(ctx, executions[i].RID, mustJSON(map[string]any{"resultsExpiredAt": time.Now().UTC()})); err != nil {
					s.Log.Warn("retention: mark expired", "execution", executions[i].RID, "err", err)
					continue
				}
				n++
			}
			if len(executions) < 500 {
				break
			}
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
