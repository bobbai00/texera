package server

import (
	"encoding/json"

	jsonpatch "github.com/evanphx/json-patch/v5"
)

// applyPatch applies an RFC 6902 patch (given as decoded JSON operations) to a document.
func applyPatch(base json.RawMessage, ops []any) (json.RawMessage, error) {
	doc, err := json.Marshal(ops)
	if err != nil {
		return nil, badRequest("invalid patch: %v", err)
	}
	patch, err := jsonpatch.DecodePatch(doc)
	if err != nil {
		return nil, badRequest("invalid patch: %v", err)
	}
	if len(base) == 0 {
		base = json.RawMessage(`{}`)
	}
	out, err := patch.ApplyWithOptions(base, &jsonpatch.ApplyOptions{EnsurePathExistsOnAdd: true})
	if err != nil {
		return nil, badRequest("patch does not apply: %v", err)
	}
	return out, nil
}
