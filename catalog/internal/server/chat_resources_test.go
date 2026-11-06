package server_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// A chat lists what it made or changed, the latest first, then what it worked from, by name,
// each with the versions that count. What a person attached counts, and so does what the
// chat's work names at a version: the workflow version a run ran and the files it read, the
// files a workflow version reads, the profile version a unit was made from. A search the
// agent made, the unit a run went to and the chat itself do not; what the caller may not read
// is left out.
func TestAChatListsWhatItMadeAndWhatItWorkedFrom(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	dataset := func(name string) envelope {
		t.Helper()
		ds := h.create("alice", "datasets", name, map[string]any{"format": "csv"})
		h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/"+name+".csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
		h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
		return ds
	}
	iris, penguins := dataset("iris"), dataset("penguins")
	dataset("never touched")
	reads := func(ds envelope, view bool) map[string]any {
		return map[string]any{
			"operators": []any{
				map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/" + ds.Metadata.Name + ".csv"}},
				map[string]any{"operatorID": "avg", "operatorType": "Aggregate", "viewResult": view, "operatorProperties": map[string]any{}},
			},
			"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
		}
	}
	byHand := h.create("alice", "workflows", "by hand", reads(iris, true))
	small := h.create("alice", "profiles", "small", map[string]any{"memory": "2Gi"})

	conv := h.create("alice", "conversations", "the work", map[string]any{"template": string(agent.Metadata.Uri)})
	var turn api.Turn
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	inChat := []string{"X-Texera-Origin", "conversation=" + rid(conv) + ";turn=" + turn.Turn + ";template=" + string(turn.Template), "X-Texera-Service-Token", "service"}
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{"turn": turn.Turn, "role": "user", "parts": []any{
		map[string]any{"type": "text", "text": "the penguins too"},
		map[string]any{"type": "resource", "resource": string(penguins.Metadata.Uri) + "@1", "text": "penguins.csv"},
	}}, nil)

	// The agent searches, makes a workflow and changes it, runs the person's, and makes a unit.
	h.mustJSON("alice", "GET", p+"/resources?kind=dataset", nil, nil, inChat...)
	var made envelope
	h.mustJSON("alice", "POST", p+"/workflows", map[string]any{"name": "made here", "spec": reads(iris, false)}, &made, inChat...)
	h.mustJSON("alice", "PUT", p+"/workflows/"+rid(made), map[string]any{"spec": reads(iris, true)}, nil, inChat...)
	var run envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(byHand)+"/run", map[string]any{}, &run, inChat...)
	var unit envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "for the work", "profile": string(small.Metadata.Uri)}, &unit, inChat...)
	h.mustJSON("alice", "DELETE", p+"/conversations/"+rid(conv)+"/turns/"+turn.Turn, nil, nil)

	var items []api.ChatResource
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/resources", nil, &items)
	want := []string{
		"made computing-unit for the work",
		"made execution " + run.Metadata.Name,
		"made workflow made here [v2 made, v1 made]",
		"worked from workflow by hand [v1]",
		"worked from dataset iris [v1]",
		"worked from dataset penguins [v1]",
		"worked from profile small [v1]",
	}
	if got := listed(items); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("the chat's resources:\n got %q\nwant %q", got, want)
	}

	// Bob, in the chat, sees what of it he may read.
	bob := string(me(h, "bob").Principal.Pid)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(conv)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(iris)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	h.mustJSON("bob", "GET", p+"/conversations/"+rid(conv)+"/resources", nil, &items)
	if got := listed(items); fmt.Sprint(got) != fmt.Sprint([]string{"worked from dataset iris [v1]"}) {
		t.Fatalf("bob's view: %q", got)
	}
}

// listed puts a chat's resources in words: made or worked from, the kind and name, and the versions.
func listed(items []api.ChatResource) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		line := "worked from "
		if item.Made {
			line = "made "
		}
		line += string(item.Resource.Kind) + " " + item.Resource.Metadata.Name
		if item.Versions != nil {
			var vs []string
			for _, v := range *item.Versions {
				s := fmt.Sprintf("v%d", v.Vno)
				if v.Made {
					s += " made"
				}
				vs = append(vs, s)
			}
			line += " [" + strings.Join(vs, ", ") + "]"
		}
		out = append(out, line)
	}
	return out
}
