"""The demo's analysis through the real model: a file attached to a chat stays the chat's, the agent
reads it and the team's model, applies the model on the unit picked when it asks, compares with
what is published, and keeps the file as a dataset when asked. The chat's graph joins the file, the
model, the operators and the unit. Outcomes are asserted in the catalog, never the wording. The
clicks around it are `frontend-next/e2e/diabetes.spec.ts`."""
import pytest

from texera_e2e import chat, diabetes
from texera_e2e.client import uri_rid

CHECK = "Can you check what's in this data? I want to analyze it using the models in our project. Which model do you think works best? Please go ahead and run it."
LITERATURE = "How does that compare with what has been published on models like this? Cite what you find."
KEEP = "Please keep this file as a dataset called Screening cohort."


def asks_in(api, conversation: str) -> list[dict]:
    """The questions with choices the agent put to the chat, oldest first, as its messages keep them."""
    messages = api.get(f"/conversations/{conversation}/messages?limit=200")["items"]
    return [part["args"] for m in messages if m["role"] == "assistant"
            for part in m["parts"] if part.get("type") == "tool_call" and part.get("toolName") == "ask"]


def datasets_listed(api, project: str) -> list[str]:
    return [d["metadata"]["name"] for d in api.get(f"/datasets?project={project}&limit=100")["items"]]


@pytest.mark.model
@pytest.mark.slow
def test_a_file_brought_to_a_chat_is_analyzed_with_the_teams_model(alice, project):
    team = diabetes.team(alice, project)
    crid = chat.conversation(alice, "the screening cohort", project)
    attached = diabetes.attach_cohort(alice, project, crid)

    # What is in it and which model fits: the file is read, the agent says which, and asks where.
    turn = chat.say(alice, crid, CHECK, attached=attached)
    assert turn.outcome == "success", turn.errors
    assert "read_dataset_file" in turn.tool_calls, turn.tool_calls
    assert "create_dataset" not in turn.tool_calls, turn.tool_calls
    assert turn.text, "it says what it found before it asks"
    assert datasets_listed(alice, project) == [], "an attached file is in no list"
    asks = asks_in(alice, crid)
    assert asks, f"no question about where it runs: {turn.tool_calls}"

    # She picks; the agent builds the pipeline and runs it.
    labels = [o["label"] for o in asks[-1]["options"]]
    pick = next((label for label in labels if "eployment" in label or "hared" in label), labels[0])
    turn = chat.say(alice, crid, pick)
    assert turn.outcome == "success", turn.errors
    made = chat.made_in(alice, crid)
    runs = [r for r in made if r["kind"] == "execution" and r["status"]["phase"] == "completed"]
    assert runs, [(r["metadata"]["name"], r["status"].get("phase")) for r in made if r["kind"] == "execution"]

    # What is published: from PubMed.
    turn = chat.say(alice, crid, LITERATURE)
    assert turn.outcome == "success", turn.errors
    assert "search_pubmed" in turn.tool_calls, turn.tool_calls

    # The graph joins them, and says where the agent looked.
    graph = alice.get(f"/conversations/{crid}/graph")
    roles = {node["role"] for node in graph["nodes"]}
    assert {"data", "model", "unit", "workflow"} <= roles, sorted(roles)
    edges = {(e["relation"], e["from"].split("@")[0]) for e in graph["edges"]}
    assert ("reads", attached[0].split("@")[0]) in edges, graph["edges"]
    assert ("uses", team["model"]) in edges, graph["edges"]
    assert [s["name"] for s in graph["sources"]] == ["biomcp"], graph["sources"]

    # Kept when asked: a dataset of the project from then on.
    turn = chat.say(alice, crid, KEEP)
    assert turn.outcome == "success", turn.errors
    assert "keep_attachment" in turn.tool_calls, turn.tool_calls
    assert datasets_listed(alice, project) == ["Screening cohort"]
    assert alice.get(f"/datasets/{uri_rid(attached[0].split('@')[0])}")["metadata"]["name"] == "Screening cohort"
