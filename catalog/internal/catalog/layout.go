package catalog

import "encoding/json"

// Where a workflow's operators sit is kept in its spec beside what runs, and is the app's: the
// catalog only keeps it honest. A place is kept for an operator the spec has, and a spec written
// without places (as the agent writes one) keeps those its workflow had.

// keepLayout gives a workflow spec written without places the places its workflow had for the
// operators it kept.
func keepLayout(spec, previous json.RawMessage) json.RawMessage {
	var next map[string]any
	if json.Unmarshal(spec, &next) != nil || next == nil {
		return spec
	}
	if _, ok := next["layout"]; ok {
		return spec
	}
	var before struct {
		Layout map[string]any `json:"layout"`
	}
	if json.Unmarshal(previous, &before) != nil || len(before.Layout) == 0 {
		return spec
	}
	next["layout"] = before.Layout
	return mustJSON(next)
}

// placesOfOperators keeps in a workflow spec the places of the operators it has, and only those.
func placesOfOperators(doc map[string]any) {
	layout, ok := doc["layout"].(map[string]any)
	if !ok {
		return
	}
	present := map[string]bool{}
	operators, _ := doc["operators"].([]any)
	for _, o := range operators {
		if op, ok := o.(map[string]any); ok {
			if id, ok := op["operatorID"].(string); ok {
				present[id] = true
			}
		}
	}
	for id := range layout {
		if !present[id] {
			delete(layout, id)
		}
	}
	if len(layout) == 0 {
		delete(doc, "layout")
	}
}
