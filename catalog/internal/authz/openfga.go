// Package authz is the policy decision point: it answers whether a principal may act on a
// resource, keeps OpenFGA in sync with the catalog's grants, and serves the gateway's
// ext_authz checks.
package authz

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"

	openfga "github.com/openfga/go-sdk"
	"github.com/openfga/go-sdk/client"
	"github.com/openfga/language/pkg/go/transformer"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/apache/texera/catalog/internal/store"
)

// FGA wraps an OpenFGA store with the catalog's authorization model.
type FGA struct {
	client *client.OpenFgaClient
	log    *slog.Logger
}

// NewFGA connects to OpenFGA, finds or creates the store by name and writes the model from
// the DSL file. It retries briefly because the dev stack may still be starting.
func NewFGA(ctx context.Context, apiURL, storeName, modelPath string, log *slog.Logger) (*FGA, error) {
	dsl, err := os.ReadFile(modelPath)
	if err != nil {
		return nil, fmt.Errorf("read openfga model: %w", err)
	}
	c, err := client.NewSdkClient(&client.ClientConfiguration{ApiUrl: apiURL})
	if err != nil {
		return nil, err
	}
	var storeID string
	deadline := time.Now().Add(time.Minute)
	for {
		storeID, err = findOrCreateStore(ctx, c, storeName)
		if err == nil || time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	if err != nil {
		return nil, fmt.Errorf("openfga store: %w", err)
	}
	c.SetStoreId(storeID)
	modelID, err := writeModel(ctx, c, string(dsl))
	if err != nil {
		return nil, fmt.Errorf("openfga model: %w", err)
	}
	c.SetAuthorizationModelId(modelID)
	log.Info("openfga ready", "store", storeID, "model", modelID)
	return &FGA{client: c, log: log}, nil
}

func findOrCreateStore(ctx context.Context, c *client.OpenFgaClient, name string) (string, error) {
	resp, err := c.ListStores(ctx).Execute()
	if err != nil {
		return "", err
	}
	for _, s := range resp.Stores {
		if s.Name == name {
			return s.Id, nil
		}
	}
	created, err := c.CreateStore(ctx).Body(client.ClientCreateStoreRequest{Name: name}).Execute()
	if err != nil {
		return "", err
	}
	return created.Id, nil
}

func writeModel(ctx context.Context, c *client.OpenFgaClient, dsl string) (string, error) {
	model, err := transformer.TransformDSLToProto(dsl)
	if err != nil {
		return "", fmt.Errorf("parse dsl: %w", err)
	}
	raw, err := protojson.Marshal(model)
	if err != nil {
		return "", err
	}
	var body openfga.WriteAuthorizationModelRequest
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", err
	}
	resp, err := c.WriteAuthorizationModel(ctx).Body(body).Execute()
	if err != nil {
		return "", err
	}
	return resp.AuthorizationModelId, nil
}

// Check asks OpenFGA whether subject has relation on object.
func (f *FGA) Check(ctx context.Context, subject, relation, object string) (bool, error) {
	resp, err := f.client.Check(ctx).Body(client.ClientCheckRequest{User: subject, Relation: relation, Object: object}).Execute()
	if err != nil {
		return false, err
	}
	return resp.GetAllowed(), nil
}

// Apply writes or deletes tuples from outbox entries.
func (f *FGA) Apply(ctx context.Context, entries []store.OutboxEntry) error {
	var writes []client.ClientTupleKey
	var deletes []client.ClientTupleKeyWithoutCondition
	for _, e := range entries {
		switch e.Op {
		case "write":
			writes = append(writes, client.ClientTupleKey{User: e.Subject, Relation: e.Relation, Object: e.Object})
		case "delete":
			deletes = append(deletes, client.ClientTupleKeyWithoutCondition{User: e.Subject, Relation: e.Relation, Object: e.Object})
		}
	}
	if len(writes) == 0 && len(deletes) == 0 {
		return nil
	}
	// Non-transactional mode tolerates duplicate writes and missing deletes.
	opts := client.ClientWriteOptions{Transaction: &client.TransactionOptions{Disable: true, MaxParallelRequests: 4, MaxPerChunk: 20}}
	resp, err := f.client.Write(ctx).Body(client.ClientWriteRequest{Writes: writes, Deletes: deletes}).Options(opts).Execute()
	if err != nil {
		return err
	}
	for _, w := range resp.Writes {
		if w.Error != nil && !isDuplicate(w.Error) {
			return fmt.Errorf("write %v: %w", w.TupleKey, w.Error)
		}
	}
	for _, d := range resp.Deletes {
		if d.Error != nil && !isMissing(d.Error) {
			return fmt.Errorf("delete %v: %w", d.TupleKey, d.Error)
		}
	}
	return nil
}

func isDuplicate(err error) bool {
	return err != nil && containsAny(err.Error(), "already exists", "duplicate")
}

func isMissing(err error) bool {
	return err != nil && containsAny(err.Error(), "not found", "does not exist", "no tuple")
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if contains(s, sub) {
			return true
		}
	}
	return false
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// Drainer moves outbox entries into OpenFGA.
type Drainer struct {
	store *store.Store
	fga   *FGA
	log   *slog.Logger
	wake  chan struct{}
}

// NewDrainer builds a drainer; call Run in a goroutine and Kick after writes.
func NewDrainer(st *store.Store, fga *FGA, log *slog.Logger) *Drainer {
	return &Drainer{store: st, fga: fga, log: log, wake: make(chan struct{}, 1)}
}

// Kick asks the drainer to run soon.
func (d *Drainer) Kick() {
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

// DrainOnce applies all pending entries.
func (d *Drainer) DrainOnce(ctx context.Context) error {
	for {
		entries, err := d.store.PendingOutbox(ctx, 200)
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			return nil
		}
		if err := d.fga.Apply(ctx, entries); err != nil {
			return err
		}
		ids := make([]int64, len(entries))
		for i, e := range entries {
			ids[i] = e.ID
		}
		if err := d.store.MarkOutboxProcessed(ctx, ids); err != nil {
			return err
		}
		if len(entries) < 200 {
			return nil
		}
	}
}

// Run drains on a timer and on kicks until the context ends.
func (d *Drainer) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := d.DrainOnce(ctx); err != nil && ctx.Err() == nil {
			d.log.Warn("outbox drain failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-d.wake:
		}
	}
}
