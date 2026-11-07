package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/uri"
)

// predictType is the engine's operator that runs a model version on rows.
const predictType = "predict"

// compilePredict pins a predict operator's model to a version and gives the engine the
// version's contract and its files by URI: the files are presigned for a run, with the
// caller's access, and recorded as what the execution used.
func (s *Service) compilePredict(ctx context.Context, props map[string]any) error {
	name, _ := props["model"].(string)
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("model: name the model, as texera://models/<rid>@<version>")
	}
	ref, err := uri.Parse(name)
	if err != nil || ref.Kind.Name != "model" || ref.Subresource != "" {
		return fmt.Errorf("model: %s is not a model's URI", name)
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return fmt.Errorf("model: %s is not a model's URI", name)
	}
	r, err := s.Store.GetResource(ctx, rid)
	if err != nil || r.Kind != "model" {
		return fmt.Errorf("model: there is no model %s", name)
	}
	vno := ref.Vno
	if vno == 0 {
		vno = r.HeadVno
	}
	if vno == 0 {
		return fmt.Errorf("model: %s has no version yet", r.Name)
	}
	v, err := s.Store.GetVersion(ctx, rid, vno)
	if err != nil {
		return fmt.Errorf("model: %s has no version %d", r.Name, vno)
	}
	var m api.Manifest
	if err := json.Unmarshal(v.Content, &m); err != nil {
		return err
	}
	if m.Contract == nil {
		return fmt.Errorf("model: version %d of %s has no contract; commit one that says what it reads and puts out", vno, r.Name)
	}
	version := URI(r).WithVersion(vno).String()
	files := map[string]any{}
	for _, f := range m.Files {
		files[f.Path] = version + "/files/" + f.Path
	}
	var contract map[string]any
	if err := json.Unmarshal(mustJSON(m.Contract), &contract); err != nil {
		return err
	}
	props["model"] = version
	props["contract"] = contract
	props["files"] = files
	return nil
}

// columnTypes are the types a model's contract may name.
var columnTypes = map[string]bool{"string": true, "integer": true, "long": true, "double": true, "boolean": true, "timestamp": true}

// checkContract says what is wrong with a model version's contract, given the version's files.
func checkContract(c api.ModelContract, files []api.DatasetFile) error {
	if !c.Framework.Valid() {
		return fmt.Errorf("framework %q is not sklearn or python", c.Framework)
	}
	found := false
	for _, f := range files {
		found = found || f.Path == c.Entry
	}
	if !found {
		var paths []string
		for _, f := range files {
			paths = append(paths, f.Path)
		}
		return fmt.Errorf("entry %q is not a file of the version: %s", c.Entry, strings.Join(paths, ", "))
	}
	for _, side := range []struct {
		name    string
		columns []api.Attribute
	}{{"inputs", c.Inputs}, {"outputs", c.Outputs}} {
		if len(side.columns) == 0 {
			return fmt.Errorf("%s: name at least one column", side.name)
		}
		seen := map[string]bool{}
		for _, a := range side.columns {
			if strings.TrimSpace(a.AttributeName) == "" {
				return fmt.Errorf("%s: a column has no name", side.name)
			}
			if seen[a.AttributeName] {
				return fmt.Errorf("%s: %s is named twice", side.name, a.AttributeName)
			}
			seen[a.AttributeName] = true
			if !columnTypes[a.AttributeType] {
				return fmt.Errorf("%s: %s is of type %q; use string, integer, long, double, boolean or timestamp", side.name, a.AttributeName, a.AttributeType)
			}
		}
	}
	return nil
}
