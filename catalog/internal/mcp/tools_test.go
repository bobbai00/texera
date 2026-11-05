package mcp

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The two servers split by what a tool acts on and share nothing. The dataflow server holds the
// verbs of a workflow and its runs: build, edit, compile, run, control, read results. Everything
// else is the catalog server's: any resource and its versions, lineage and grants, datasets and
// their files, operators, computing units, people.
func TestTheServersSplitByWhatAToolActsOn(t *testing.T) {
	want := map[string][]string{
		"catalog": {
			"commit_dataset_version", "get_lineage", "get_resource", "get_version", "grant_access",
			"list_computing_units", "list_dataset_files", "list_operators", "list_versions",
			"read_dataset_file", "resolve_uri", "search_principals", "search_resources", "whoami",
		},
		"dataflow": {
			"create_workflow", "edit_workflow", "get_execution", "get_port_result", "get_workflow",
			"pause_execution", "resume_execution", "run_workflow", "validate_workflow",
		},
	}
	for server, names := range want {
		var got []string
		for _, tool := range ForServer(server) {
			got = append(got, tool.Name)
		}
		sort.Strings(got)
		if strings.Join(got, " ") != strings.Join(names, " ") {
			t.Errorf("%s:\n got  %v\n want %v", server, got, names)
		}
	}
	on := map[string]string{}
	for _, tool := range Tools {
		if _, known := want[tool.Server]; !known {
			t.Errorf("%s is on an unknown server %q", tool.Name, tool.Server)
		}
		if other, twice := on[tool.Name]; twice {
			t.Errorf("%s is on %s and on %s", tool.Name, other, tool.Server)
		}
		on[tool.Name] = tool.Server
		// The rule itself, so a tool added later lands on the right server.
		ofAWorkflow := strings.HasPrefix(tool.Path, "/catalog/v1/workflows")
		if (tool.Server == "dataflow") != ofAWorkflow {
			t.Errorf("%s (%s %s) is on %s", tool.Name, tool.Method, tool.Path, tool.Server)
		}
	}
}

// What a server tells a client about itself names its own tools, never the other server's.
func TestAServersInstructionsNameOnlyItsOwnTools(t *testing.T) {
	on := map[string]string{}
	for _, tool := range Tools {
		on[tool.Name] = tool.Server
	}
	word := regexp.MustCompile(`[a-z]+(?:_[a-z]+)+`)
	for _, server := range []string{"catalog", "dataflow"} {
		text := instructions[server]
		if strings.TrimSpace(text) == "" {
			t.Errorf("%s has no instructions", server)
		}
		named := 0
		for _, name := range word.FindAllString(text, -1) {
			owner, isTool := on[name]
			if !isTool {
				continue
			}
			named++
			if owner != server {
				t.Errorf("the %s instructions name %s, a tool of the %s server", server, name, owner)
			}
		}
		if named == 0 {
			t.Errorf("the %s instructions name none of its tools", server)
		}
	}
}
