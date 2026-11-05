"""Real agents through the real model. The Data Analyst builds, runs, edits and reruns over
the iris file; the Bio Researcher answers with cited ideas, hands the chat to the analyst for
the analysis, and the active agent shares the data with Bob through the catalog MCP server.
Acceptance items 3, 9, 10 and 11. Outcomes are asserted in the catalog, never the wording."""
import itertools

import pytest

from conftest import make_iris
from texera_e2e import chat


_iris_numbers = itertools.count(1)


@pytest.fixture
def my_iris(alice, project, run_id):
    """An iris dataset with a name of its own, unique across this run's tests, so the prompts
    leave the model no doubt: a same-named leftover of an earlier test once got shared instead."""
    return make_iris(alice, project, f"iris-{run_id}-{next(_iris_numbers)}")


def _kinds(resources: list) -> dict[str, list]:
    out: dict[str, list] = {}
    for kind, name, rid in resources:
        out.setdefault(kind, []).append((name, rid))
    return out


def _completed_runs(api, resources: list) -> int:
    n = 0
    for kind, _, rid in resources:
        if kind == "execution":
            wf = api.get("/executions?limit=200")  # executions across workflows
            for e in wf["items"]:
                if e["metadata"]["rid"] == rid and e["status"]["phase"] == "completed":
                    n += 1
    return n


@pytest.mark.model
@pytest.mark.slow
def test_the_data_analyst_builds_runs_edits_and_reruns(alice, project, my_iris, unit):
    name = my_iris["metadata"]["name"]
    crid = chat.conversation(alice, "analyst chat", chat.template_uri(alice, "Data Analyst"), unit, project)
    first = chat.say(alice, crid, f"Using the dataset named {name} in my catalog, what is the average petal length for each species? Build and run a Texera workflow to compute it, then report the numbers.")
    assert first.outcome == "success" and not first.errors
    made = _kinds(chat.created_in(alice, crid))
    assert made.get("workflow") and made.get("execution"), made
    assert _completed_runs(alice, chat.created_in(alice, crid)) >= 1

    second = chat.say(alice, crid, "Now edit that same workflow so it also computes the average sepal width per species, run it again, and report both averages.")
    assert second.outcome == "success"
    made = _kinds(chat.created_in(alice, crid))
    assert len(made.get("execution", [])) >= 2 and _completed_runs(alice, chat.created_in(alice, crid)) >= 2
    wf_rid = made["workflow"][0][1]
    assert alice.get(f"/workflows/{wf_rid}")["metadata"]["head"] >= 2, "the edit is a new version"

    messages = alice.get(f"/conversations/{crid}/messages")["items"]
    assert all(m.get("template") for m in messages if m["role"] == "assistant"), "every answer names the template that wrote it"


@pytest.mark.model
@pytest.mark.slow
def test_the_bio_researcher_hands_off_and_the_analyst_shares(alice, bob, project, my_iris, unit):
    name = my_iris["metadata"]["name"]
    bob_pid = bob.pid()
    crid = chat.conversation(alice, "research chat", chat.template_uri(alice, "Bio Researcher"), unit, project)
    ideas = chat.say(alice, crid, "I study CRISPR off-target effects. Give me three research ideas grounded in recent literature, with citations.")
    assert ideas.outcome == "success" and ideas.tool_calls, "the researcher consults its tools"
    assert len(ideas.text) > 200

    analysis = chat.say(alice, crid, f"Now analyze the dataset named {name} in my catalog: what is the average petal length per species? Build and run a workflow and report the numbers.")
    assert analysis.outcome == "success"
    conv = alice.get(f"/conversations/{crid}")
    assert conv["spec"]["template"] == chat.template_uri(alice, "Data Analyst"), "the chat was handed to the analyst"
    messages = alice.get(f"/conversations/{crid}/messages")["items"]
    assert any(m["role"] == "system" for m in messages), "the handoff is recorded"
    assert _completed_runs(alice, chat.created_in(alice, crid)) >= 1

    share = chat.say(alice, crid, f"Share my dataset {name} with Bob so he can read it.")
    assert share.outcome == "success"
    granted = [g["relation"] for g in alice.get(f"/resources/{my_iris.rid}/grants") if g["principal"] == bob_pid]
    assert granted, "the turn granted bob the dataset"
    assert bob.status("GET", f"/datasets/{my_iris.rid}") == 200


@pytest.mark.model
@pytest.mark.slow
def test_bob_asks_in_alices_chat(alice, bob, project, unit, grants_guard):
    """A shared chat with the agent in it: bob, an editor of alice's conversation, asks and gets
    an answer; both his question and the answer are recorded as his turn, and alice reads them
    in the same chat."""
    crid = chat.conversation(alice, "shared chat", chat.template_uri(alice, "Data Analyst"), unit, project)
    grants_guard(crid, bob.pid(), "editor")
    turn = chat.say(bob, crid, "In one sentence, what can you help me with here? Answer without using any tool.")
    assert turn.outcome == "success" and turn.text
    messages = alice.get(f"/conversations/{crid}/messages")["items"]
    assert [(m["role"], m["author"]) for m in messages][:2] == [("user", bob.pid()), ("assistant", bob.pid())]
    assert alice.get(f"/conversations/{crid}")["status"].get("activeTurn") is None

