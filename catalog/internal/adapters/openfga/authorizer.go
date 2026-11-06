// Package openfga is the Authorizer adapter: the catalog's model is written to a store at
// startup, tuples are written through the outbox relay, and every decision is a Check.
package openfga

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	sdk "github.com/openfga/go-sdk"
	"github.com/openfga/go-sdk/client"
	"github.com/openfga/language/pkg/go/transformer"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/apache/texera/catalog/internal/ports"
)

// Authorizer implements ports.Authorizer.
type Authorizer struct {
	client *client.OpenFgaClient
	log    *slog.Logger
}

// New connects to OpenFGA, finds or creates the store by name and writes the model DSL. It
// retries briefly because the dev stack may still be starting.
func New(ctx context.Context, apiURL, storeName, modelDSL string, log *slog.Logger) (*Authorizer, error) {
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
	modelID, err := writeModel(ctx, c, modelDSL)
	if err != nil {
		return nil, fmt.Errorf("openfga model: %w", err)
	}
	c.SetAuthorizationModelId(modelID)
	log.Info("openfga ready", "store", storeID, "model", modelID)
	return &Authorizer{client: c, log: log}, nil
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
	var body sdk.WriteAuthorizationModelRequest
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", err
	}
	resp, err := c.WriteAuthorizationModel(ctx).Body(body).Execute()
	if err != nil {
		return "", err
	}
	return resp.AuthorizationModelId, nil
}

// Check asks whether subject has the permission on the object.
func (a *Authorizer) Check(ctx context.Context, subject, permission, object string) (bool, error) {
	resp, err := a.client.Check(ctx).Body(client.ClientCheckRequest{User: subject, Relation: permission, Object: object}).Execute()
	if err != nil {
		return false, err
	}
	return resp.GetAllowed(), nil
}

// Write applies writes and deletes; duplicates and missing tuples are tolerated.
func (a *Authorizer) Write(ctx context.Context, writes, deletes []ports.Tuple) error {
	if len(writes) == 0 && len(deletes) == 0 {
		return nil
	}
	req := client.ClientWriteRequest{}
	for _, t := range writes {
		req.Writes = append(req.Writes, client.ClientTupleKey{User: t.Subject, Relation: t.Relation, Object: t.Object})
	}
	for _, t := range deletes {
		req.Deletes = append(req.Deletes, client.ClientTupleKeyWithoutCondition{User: t.Subject, Relation: t.Relation, Object: t.Object})
	}
	// OpenFGA applies a request whole or not at all, and by default refuses one that holds a
	// tuple already there or deletes one that is not. It is told to pass over those instead:
	// what remains of the request is applied, so a tuple relayed twice never costs the ones
	// that travel with it.
	opts := client.ClientWriteOptions{
		Conflict: client.ClientWriteConflictOptions{
			OnDuplicateWrites: client.CLIENT_WRITE_REQUEST_ON_DUPLICATE_WRITES_IGNORE,
			OnMissingDeletes:  client.CLIENT_WRITE_REQUEST_ON_MISSING_DELETES_IGNORE,
		},
		Transaction: &client.TransactionOptions{Disable: true, MaxParallelRequests: 4, MaxPerChunk: 20},
	}
	resp, err := a.client.Write(ctx).Body(req).Options(opts).Execute()
	if err != nil {
		return err
	}
	for _, w := range resp.Writes {
		if w.Error != nil {
			return fmt.Errorf("write %v: %w", w.TupleKey, w.Error)
		}
	}
	for _, d := range resp.Deletes {
		if d.Error != nil {
			return fmt.Errorf("delete %v: %w", d.TupleKey, d.Error)
		}
	}
	return nil
}
