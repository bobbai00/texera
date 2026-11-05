"""The Texera Agent through the real model: one agent is the entry to every chat. It builds,
runs, edits and reruns a workflow over the iris file; in one chat it grounds a research question
with the bio tools, analyzes the person's data and shares it with Bob through the catalog
server, with nobody to hand the chat to; and its runs go to the computing unit the chat names
without being told. Acceptance items 3, 9, 10 and 11. Outcomes are asserted in the catalog,
never the wording."""
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
def test_the_agent_builds_runs_edits_and_reruns(alice, project, my_iris, unit):
    name = my_iris["metadata"]["name"]
    crid = chat.conversation(alice, "analysis chat", chat.agent_uri(alice), unit, project)
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


BIO_TOOLS = {"search_pubmed", "get_citation_network", "search_genes", "lookup_variant", "get_population_frequency", "search_proteins", "interpret_clinical_variant"}


@pytest.mark.model
@pytest.mark.slow
def test_one_agent_researches_analyzes_and_shares(alice, bob, project, my_iris, unit):
    name = my_iris["metadata"]["name"]
    bob_pid = bob.pid()
    agent = chat.agent_uri(alice)
    crid = chat.conversation(alice, "research chat", agent, unit, project)
    ideas = chat.say(alice, crid, "I study CRISPR off-target effects. Give me three research ideas grounded in recent literature, with citations.")
    assert ideas.outcome == "success", ideas.errors
    assert BIO_TOOLS & set(ideas.tool_calls), f"the agent consults the bio tools: {ideas.tool_calls}"
    assert len(ideas.text) > 200

    analysis = chat.say(alice, crid, f"Now analyze the dataset named {name} in my catalog: what is the average petal length per species? Build and run a workflow and report the numbers.")
    assert analysis.outcome == "success", analysis.errors
    assert _completed_runs(alice, chat.created_in(alice, crid)) >= 1
    # The same agent did both: the chat never changed hands.
    assert not ideas.handoffs and not analysis.handoffs
    assert alice.get(f"/conversations/{crid}")["spec"]["template"] == agent
    messages = alice.get(f"/conversations/{crid}/messages")["items"]
    assert {m["template"].split("@")[0] for m in messages if m["role"] == "assistant"} == {agent}

    share = chat.say(alice, crid, f"Share my dataset {name} with Bob so he can read it.")
    assert share.outcome == "success", share.errors
    granted = [g["relation"] for g in alice.get(f"/resources/{my_iris.rid}/grants") if g["principal"] == bob_pid]
    assert granted, "the turn granted bob the dataset"
    assert bob.status("GET", f"/datasets/{my_iris.rid}") == 200


@pytest.mark.model
@pytest.mark.slow
def test_the_agents_runs_go_to_the_chats_unit(alice, project, my_iris):
    """The person picks a computing unit for the chat and says nothing more about it."""
    name = my_iris["metadata"]["name"]
    mine = chat.second_unit(alice, project)
    crid = chat.conversation(alice, "on my unit", chat.agent_uri(alice), mine, project)
    turn = chat.say(alice, crid, f"Using the dataset named {name} in my catalog, how many flowers are there per species? Build and run a Texera workflow to count them, then report the numbers.")
    assert turn.outcome == "success", turn.errors
    runs = [r for r in alice.get(f"/conversations/{crid}/resources") if r["kind"] == "execution"]
    assert runs, "the agent ran a workflow"
    assert {r["spec"]["computingUnit"] for r in runs} == {mine}, "every run of the chat is on the chat's unit"
    assert any(r["status"]["phase"] == "completed" for r in runs)


@pytest.mark.model
@pytest.mark.slow
def test_bob_asks_in_alices_chat(alice, bob, project, unit, grants_guard):
    """A shared chat with the agent in it: bob, an editor of alice's conversation, asks and gets
    an answer; both his question and the answer are recorded as his turn, and alice reads them
    in the same chat."""
    crid = chat.conversation(alice, "shared chat", chat.agent_uri(alice), unit, project)
    grants_guard(crid, bob.pid(), "editor")
    turn = chat.say(bob, crid, "In one sentence, what can you help me with here? Answer without using any tool.")
    assert turn.outcome == "success" and turn.text
    messages = alice.get(f"/conversations/{crid}/messages")["items"]
    assert [(m["role"], m["author"]) for m in messages][:2] == [("user", bob.pid()), ("assistant", bob.pid())]
    assert alice.get(f"/conversations/{crid}")["status"].get("activeTurn") is None

