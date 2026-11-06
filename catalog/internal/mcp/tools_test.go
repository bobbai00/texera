package mcp

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The catalog has one MCP server and it holds every tool: any resource with its versions,
// lineage and grants, dataset files, operators, computing units and the profiles they are made
// from, people, and the verbs of a
// workflow and its executions. A tool added to the contract is listed here on purpose.
func TestTheCatalogServerHoldsEveryTool(t *testing.T) {
	want := []string{
		"commit_dataset_version", "create_computing_unit", "create_workflow", "edit_workflow", "get_execution", "get_lineage",
		"get_port_result", "get_resource", "get_version", "get_workflow", "grant_access",
		"list_computing_units", "list_dataset_files", "list_operators", "list_versions",
		"pause_execution", "read_dataset_file", "resolve_uri", "resume_execution", "run_workflow",
		"save_unit_as_profile", "search_principals", "search_resources", "validate_workflow", "whoami",
	}
	var got []string
	seen := map[string]bool{}
	for _, tool := range Tools {
		if seen[tool.Name] {
			t.Errorf("%s is listed twice", tool.Name)
		}
		seen[tool.Name] = true
		got = append(got, tool.Name)
	}
	if !sort.StringsAreSorted(got) {
		t.Errorf("the tools are not in name order: %v", got)
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("tools:\n got  %v\n want %v", got, want)
	}
}

// What the server tells a client about itself names every tool it has and no tool it has not,
// so the text cannot fall behind the contract.
func TestTheInstructionsNameEveryToolAndNoOther(t *testing.T) {
	has := map[string]bool{}
	for _, tool := range Tools {
		has[tool.Name] = true
		if !regexp.MustCompile(`\b` + tool.Name + `\b`).MatchString(instructions) {
			t.Errorf("the instructions do not name %s", tool.Name)
		}
	}
	// A word shaped like a tool name is one.
	for _, name := range regexp.MustCompile(`[a-z]+(?:_[a-z]+)+`).FindAllString(instructions, -1) {
		if !has[name] {
			t.Errorf("the instructions name %s, which is not a tool", name)
		}
	}
}
