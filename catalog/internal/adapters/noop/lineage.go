// Package noop holds adapters that do nothing: the lineage sink of a deployment without an
// external lineage consumer.
package noop

import (
	"context"
	"encoding/json"
)

// Lineage implements ports.LineageSink and drops every event.
type Lineage struct{}

// Emit drops the event.
func (Lineage) Emit(context.Context, json.RawMessage) error { return nil }
