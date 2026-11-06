package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// A warehouse is where executions keep their result tables: an execution runs on a computing
// unit and keeps its results in a warehouse. The two are chosen the same way (the request's,
// else the workflow's, the project's, the platform's) and used the same way (whoever may use
// it). The platform's own warehouse is built in; any other is on a place of its own, on the
// deployment's store or on a store its owner names. The lake holds the tables; this file is
// what the catalog decides about them.

var warehouseKind, _ = kinds.ByName("warehouse")

// named finds the resource a URI names, of the kind it must be, without the read check:
// running on a unit, keeping results in a warehouse or leasing a credential needs the use of
// it, which a `user` grant gives without the right to read its spec. Every caller asks for
// the permission it needs itself.
func (s *Service) named(ctx context.Context, name string, kind kinds.Kind) (*store.Resource, error) {
	what := strings.ReplaceAll(kind.Name, "-", " ")
	ref, err := uri.Parse(name)
	if err != nil {
		return nil, Invalid(err.Error(), nil)
	}
	if ref.Kind.Name != kind.Name {
		return nil, Invalid(fmt.Sprintf("%s is not a %s", name, what), nil)
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil, Invalid(err.Error(), nil)
	}
	r, err := s.Store.GetResource(ctx, rid)
	if err != nil || r.Kind != kind.Name {
		return nil, NotFound(what + " " + rid.String())
	}
	return r, nil
}

// lakeNameOf is a warehouse's name in the lake, recorded when the warehouse was made: what the
// lake and the engine are told.
func lakeNameOf(warehouse *store.Resource) string {
	var status api.WarehouseStatus
	if json.Unmarshal(warehouse.Status, &status) == nil && status.Name != nil {
		return *status.Name
	}
	return ""
}

// warehouseOf is the name in the lake of the warehouse an execution keeps its results in; ""
// when the warehouse is gone, and its tables with it.
func (s *Service) warehouseOf(ctx context.Context, execution *store.Resource) string {
	var spec api.ExecutionSpec
	if json.Unmarshal(execution.Spec, &spec) != nil || spec.Warehouse == "" {
		return ""
	}
	warehouse, err := s.named(ctx, string(spec.Warehouse), warehouseKind)
	if err != nil {
		return ""
	}
	return lakeNameOf(warehouse)
}

// checkWarehouse refuses a warehouse the caller may not ask for: on a store nobody listed, or
// with a credential that is not theirs to use.
func (s *Service) checkWarehouse(ctx context.Context, caller *auth.Caller, spec json.RawMessage) error {
	var w api.WarehouseSpec
	if err := json.Unmarshal(spec, &w); err != nil {
		return err
	}
	if w.Storage == nil {
		return nil
	}
	if !s.storeListed(ctx, w.Storage.Endpoint) {
		return Invalid(fmt.Sprintf("%s is not a store a warehouse may be on: an administrator lists them in the settings", w.Storage.Endpoint), map[string]any{"field": "/storage/endpoint"})
	}
	credential, err := s.named(ctx, string(w.Storage.Credential), credentialKind)
	if err != nil {
		return err
	}
	return s.require(ctx, caller, authz.Use, credential.RID)
}

// storeListed reports whether a warehouse may be on a store: the deployment's own, or one an
// administrator listed in the settings. The lake and the units connect to it.
func (s *Service) storeListed(ctx context.Context, endpoint string) bool {
	same := func(a, b string) bool { return strings.TrimRight(a, "/") == strings.TrimRight(b, "/") }
	if same(endpoint, s.Config.WarehouseStore.Endpoint) {
		return true
	}
	if listed := s.settingsSpec(ctx).WarehouseEndpoints; listed != nil {
		for _, e := range *listed {
			if same(endpoint, e) {
				return true
			}
		}
	}
	return false
}

// storageOf is where a warehouse keeps its tables. With a store of its own: that place, and
// the key its credential holds. Without: a place on the deployment's store, the configured one
// for the platform's warehouse and one of its own for any other.
func (s *Service) storageOf(ctx context.Context, warehouse *store.Resource) (ports.WarehouseStorage, error) {
	var spec api.WarehouseSpec
	if err := json.Unmarshal(warehouse.Spec, &spec); err != nil {
		return ports.WarehouseStorage{}, err
	}
	if spec.Storage == nil {
		storage := s.Config.WarehouseStore
		if !s.builtIn(warehouse) {
			storage.KeyPrefix = "w/" + warehouse.RID.String()
		}
		return storage, nil
	}
	credential, err := s.named(ctx, string(spec.Storage.Credential), credentialKind)
	if err != nil {
		return ports.WarehouseStorage{}, err
	}
	fields, err := s.Secrets.Get(ctx, secretPath(credential))
	if err != nil && !errors.Is(err, ports.ErrSecretNotFound) {
		return ports.WarehouseStorage{}, Unavailable("secret store", err)
	}
	if fields["accessKeyId"] == "" || fields["secretAccessKey"] == "" {
		return ports.WarehouseStorage{}, Invalid(fmt.Sprintf("the secret of %s must hold accessKeyId and secretAccessKey", credential.Name), map[string]any{"field": "/storage/credential"})
	}
	storage := ports.WarehouseStorage{
		Endpoint: spec.Storage.Endpoint, Region: spec.Storage.Region, Bucket: spec.Storage.Bucket,
		AccessKey: fields["accessKeyId"], SecretKey: fields["secretAccessKey"],
	}
	if spec.Storage.KeyPrefix != nil {
		storage.KeyPrefix = strings.Trim(*spec.Storage.KeyPrefix, "/")
	}
	return storage, nil
}

// provisionWarehouse makes the warehouse in the lake, or brings its storage and key there up
// to date, and records the name it has there. The lake tries the storage before it takes it:
// what it cannot use is the caller's to put right.
func (s *Service) provisionWarehouse(ctx context.Context, warehouse *store.Resource) error {
	name := lakeNameOf(warehouse)
	named := name != ""
	if !named {
		name = "w_" + strings.ReplaceAll(warehouse.RID.String(), "-", "")
	}
	storage, err := s.storageOf(ctx, warehouse)
	if err != nil {
		return err
	}
	if err := s.Lake.EnsureWarehouse(ctx, name, storage); err != nil {
		if errors.Is(err, ports.ErrStorageRefused) {
			return Invalid(err.Error(), map[string]any{"field": "/storage"})
		}
		return Unavailable("lake", err)
	}
	if named {
		return nil
	}
	updated, err := s.Store.MergeStatus(ctx, warehouse.RID, mustJSON(api.WarehouseStatus{Name: &name}))
	if err != nil {
		return err
	}
	*warehouse = *updated
	return nil
}

// samePlace reports whether two warehouse specs keep their tables in the same place; the
// credential is not part of the place.
func samePlace(a, b api.WarehouseSpec) bool {
	if a.Storage == nil || b.Storage == nil {
		return a.Storage == nil && b.Storage == nil
	}
	prefix := func(s *api.WarehouseStorage) string {
		if s.KeyPrefix == nil {
			return ""
		}
		return strings.Trim(*s.KeyPrefix, "/")
	}
	return a.Storage.Endpoint == b.Storage.Endpoint && a.Storage.Region == b.Storage.Region && a.Storage.Bucket == b.Storage.Bucket && prefix(a.Storage) == prefix(b.Storage)
}

// removeWarehouse takes a warehouse out of the lake. It goes only when no execution keeps
// results in it: those would be lost with it. The lake has the last word: it holds what it
// holds, whatever the catalog knows of.
func (s *Service) removeWarehouse(ctx context.Context, warehouse *store.Resource) error {
	kept, err := s.Store.ListResources(ctx, store.ResourceFilter{
		Kind: "execution", Fields: map[string]string{"/spec/warehouse": URI(warehouse).String()}, Absent: []string{"/status/resultsExpiredAt"}, Limit: 1,
	})
	if err != nil {
		return err
	}
	if len(kept) > 0 {
		return Conflict("in_use", fmt.Sprintf("executions still keep results in %s; delete them or let them expire first", warehouse.Name), map[string]any{"execution": kept[0].RID.String()})
	}
	name := lakeNameOf(warehouse)
	if name == "" {
		return nil
	}
	if err := s.Lake.RemoveWarehouse(ctx, name); err != nil {
		if errors.Is(err, ports.ErrWarehouseNotEmpty) {
			return Conflict("not_empty", fmt.Sprintf("the lake does not let go of %s yet: %v", warehouse.Name, err), nil)
		}
		return Unavailable("lake", err)
	}
	return nil
}

// credentialRotated hands a credential's new secret to the lake for every warehouse that
// keeps its key there.
func (s *Service) credentialRotated(ctx context.Context, credential *store.Resource) error {
	warehouses, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "warehouse", Fields: map[string]string{"/spec/storage/credential": URI(credential).String()}, Limit: 500})
	if err != nil {
		return err
	}
	for i := range warehouses {
		if err := s.provisionWarehouse(ctx, &warehouses[i]); err != nil {
			return err
		}
	}
	return nil
}
