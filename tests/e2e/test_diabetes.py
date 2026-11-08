"""The diabetes use case through the real model: a researcher new to the team's project asks what
the platform gives her, has the agent bring the public Pima cohort into a dataset, then asks to
screen it with the team's onset-risk model. The agent asks where the work runs, offering the
profiles that can start here and no GPU where there is none; she picks Small; it makes a unit
from Small, builds and runs the workflow on it (the model's predict, the team's ROC AUC and
calibration operators), and the chat's graph joins the dataset, the model, the unit and the
workflow. Outcomes are asserted in the catalog, never the wording."""
import pytest

from texera_e2e import chat, diabetes

ASK_TOOLS = "I study type 2 diabetes and I'm new to this team. What tools does this platform give me: data, models, operators, and where my work can run?"
BRING_IN = (f"Please get the Pima Indians diabetes data from {diabetes.PIMA_URL} and put it into a new dataset "
            "called 'Pima cohort'.")
SCREEN = ("Now screen every woman in the Pima cohort with our diabetes onset-risk model: how well does its risk separate "
          "the women who developed diabetes from those who did not, and is it calibrated? Use the team's ROC AUC and "
          "Risk calibration operators.")


def asks_in(api, conversation: str) -> list[dict]:
    """The questions with choices the agent put to the chat, oldest first, as its messages keep them."""
    messages = api.get(f"/conversations/{conversation}/messages?limit=200")["items"]
    return [part["args"] for m in messages if m["role"] == "assistant"
            for part in m["parts"] if part.get("type") == "tool_call" and part.get("toolName") == "ask"]


def profiles(api, project: str) -> dict[str, dict]:
    return {p["metadata"]["name"]: p for p in api.get(f"/profiles?scope={project}&limit=100")["items"]}


@pytest.mark.model
@pytest.mark.slow
def test_a_researcher_brings_in_a_cohort_and_screens_it_with_the_teams_model(alice, project):
    team = diabetes.team(alice, project)
    ladder = profiles(alice, project)
    small = ladder["Small"]
    assert small["status"]["startable"], small["status"]
    crid = chat.conversation(alice, "screening the Pima cohort", project)
    units: list[dict] = []
    try:
        # What there is: the agent reads, and makes nothing.
        turn = chat.say(alice, crid, ASK_TOOLS)
        assert turn.outcome == "success", turn.errors
        assert {"list_operators", "search_resources"} & set(turn.tool_calls), turn.tool_calls
        assert chat.made_in(alice, crid) == []

        # The cohort comes in: a dataset of the chat's, holding the public file byte for byte.
        turn = chat.say(alice, crid, BRING_IN)
        assert turn.outcome == "success", turn.errors
        assert "import_dataset_file" in turn.tool_calls, turn.tool_calls
        datasets = [r for r in chat.made_in(alice, crid) if r["kind"] == "dataset"]
        assert len(datasets) == 1 and datasets[0]["metadata"]["head"] >= 1, datasets
        cohort = datasets[0]
        files = alice.get(f"/datasets/{cohort['metadata']['rid']}/versions/{cohort['metadata']['head']}/files")["files"]
        assert [f["sha256"] for f in files] == [diabetes.pima_digest()], files

        # The screening: before anything runs, the agent asks where, with what can start here.
        turn = chat.say(alice, crid, SCREEN)
        assert turn.outcome == "success", turn.errors
        asks = asks_in(alice, crid)
        assert asks, f"no question about where it runs: {turn.tool_calls}"
        labels = [o["label"] for o in asks[-1]["options"]]
        startable = [name for name, p in ladder.items() if p["status"].get("startable")]
        assert any(name in label for label in labels for name in startable), labels
        if not ladder["GPU"]["status"].get("startable"):
            assert not any(label.strip().lower().startswith("gpu") for label in labels), f"a GPU offered where none starts: {labels}"
        assert [r for r in chat.made_in(alice, crid) if r["kind"] == "computing-unit"] == [], "no unit before she chose"

        # A choice of sizes: at least two of the ladder's rungs. She picks Small, or the smallest offered.
        rungs = [name for name in ("Small", "Medium", "Large", "ML") if ladder[name]["status"].get("startable")]
        offered = [(label, name) for name in rungs for label in labels if label.startswith(name) or f" {name}" in label]
        assert len({name for _, name in offered}) >= 2, f"sizes to choose from: {labels}"
        pick, rung = offered[0]
        turn = chat.say(alice, crid, pick)
        assert turn.outcome == "success", turn.errors
        made = chat.made_in(alice, crid)
        units = [r for r in made if r["kind"] == "computing-unit"]
        assert len(units) == 1, [r["metadata"]["name"] for r in units]
        unit = units[0]
        assert unit["spec"]["computingNodes"][0]["profile"].split("@")[0] == ladder[rung]["metadata"]["uri"], (rung, unit["spec"])
        runs = [r for r in made if r["kind"] == "execution" and r["status"]["phase"] == "completed"]
        assert runs, [(r["metadata"]["name"], r["status"].get("phase")) for r in made if r["kind"] == "execution"]
        assert {r["spec"]["computingUnit"] for r in runs} == {unit["metadata"]["uri"]}, "every run went to her unit"

        # The graph joins them: the cohort and the model go into the workflow, with the team's
        # operators, and the workflow runs on the unit.
        graph = alice.get(f"/conversations/{crid}/graph")
        roles = {node["role"] for node in graph["nodes"]}
        assert {"data", "model", "unit", "workflow"} <= roles, sorted(roles)
        edges = {(e["relation"], e["from"].split("@")[0], e["to"].split("@")[0]) for e in graph["edges"]}
        into = {(relation, source) for relation, source, _ in edges}
        assert ("reads", cohort["metadata"]["uri"]) in into, graph["edges"]
        assert ("uses", team["model"]) in into, graph["edges"]
        assert ("runsOn", unit["metadata"]["uri"]) in {(relation, target) for relation, _, target in edges}, graph["edges"]
        assert {("uses", team["roc_auc"]), ("uses", team["calibration"])} & into, "the team's operators are on the graph"
    finally:
        for u in units:
            alice.post(f"/computing-units/{u['metadata']['rid']}/terminate", {})
