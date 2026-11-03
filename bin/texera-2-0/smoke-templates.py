#!/usr/bin/env python3
"""Agent templates and pluggable MCP servers, end to end with a real model.

A person registers a third-party MCP server (agent-runtime/examples/mcp-iris-facts on :23010)
as a catalog resource, creates an agent template that binds it beside the built-in Texera MCP
server (with a tool allowlist), edits the template (a new version), starts a chat in that mode,
and the agent uses tools from both servers in one turn.

Needs the dev stack, the catalog, the unit, the agent runtime and the example MCP server.
"""
import os
import sys
import time

# Where the agent runtime reaches the example server: the host itself in the dev stack;
# EXTERNAL_MCP_URL=http://host.docker.internal:23010/mcp for the runtime in a cluster.
EXTERNAL_MCP_URL = os.environ.get("EXTERNAL_MCP_URL", "http://localhost:23010/mcp")

GW = "http://localhost:8088"


def load_chat():
    import importlib.util
    spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    c = load_chat()
    tok = c.token("bob", "bob")
    me = c.api(tok, "GET", "/catalog/v1/me")["principal"]["pid"]
    c.ensure_iris(tok)

    facts = c.api(tok, "POST", "/catalog/v1/mcp-servers", {
        "name": f"iris-facts {time.strftime('%H%M%S')}", "description": "Facts about iris species and a length converter",
        "spec": {"transport": "streamable_http", "url": EXTERNAL_MCP_URL}})
    texera = next(s for s in c.api(tok, "GET", "/catalog/v1/mcp-servers")["items"] if s["metadata"]["name"] == "texera")
    print(f"MCP servers: texera {texera['metadata']['rid'][:8]} (built-in), iris-facts {facts['metadata']['rid'][:8]}")

    spec = {
        "card": {"name": "Botanist", "description": "Analyzes plant datasets and explains the species"},
        "model": {"name": "claude-haiku-5-5"},
        "prompts": {"system": "You are a botanist. Use Texera workflows for every number you report."},
        "tools": {"mcp": [{"server": texera["metadata"]["rid"]},
                          {"server": facts["metadata"]["rid"], "allow": ["species_facts", "convert_length"]}]},
    }
    tpl = c.api(tok, "POST", "/catalog/v1/agent-templates", {"name": f"Botanist {time.strftime('%H%M%S')}", "spec": spec})
    rid = tpl["metadata"]["rid"]
    spec["prompts"]["system"] = (
        "You are a botanist. Compute every number with a Texera workflow (create, validate, run, read results). "
        "Use convert_length for unit conversions and species_facts for facts about species; never guess either."
    )
    tpl = c.api(tok, "PUT", f"/catalog/v1/agent-templates/{rid}", spec)
    versions = c.api(tok, "GET", f"/catalog/v1/resources/{rid}/versions")["items"]
    print(f"template {rid[:8]}: head v{tpl['metadata']['headVersion']}, versions {[v['vno'] for v in versions]}")
    ok = tpl["metadata"]["headVersion"] == 2 and [v["vno"] for v in versions] == [2, 1]
    ok &= versions[0]["content"]["prompts"]["system"].startswith("You are a botanist. Compute")

    templates = [t["metadata"]["name"] for t in c.api(tok, "GET", "/catalog/v1/agent-templates")["items"]]
    print(f"modes bob can pick: {templates}")

    units = c.api(tok, "GET", "/catalog/v1/computing-units/available")
    unit = next(u for u in units if u["status"]["phase"] == "ready")
    conv = c.api(tok, "POST", "/catalog/v1/conversations", {"name": "botanist chat",
                 "spec": {"template": {"rid": rid, "vno": 2}, "computingUnit": unit["metadata"]["rid"]}})
    agent = c.api(tok, "POST", "/catalog/v1/agents", {"template": {"rid": rid, "vno": 2}, "conversation": conv["metadata"]["rid"]})
    print(f"agent {agent['pid'][:8]} from template v{agent['template']['vno']}\n")

    events = c.run_turn(tok, agent["pid"], conv["metadata"]["rid"],
                        "Using my iris dataset, compute the average petal length per species with a Texera workflow, "
                        "convert each average to inches, and give one fact about each species.")
    called = [e.get("toolCallName") for e in events if e.get("type") == "TOOL_CALL_START"]
    print(f"tools called: {called}")
    used_facts = "species_facts" in called
    used_convert = "convert_length" in called
    used_texera = "run_workflow" in called
    print(f"used the external server: species_facts={used_facts} convert_length={used_convert}; ran a Texera workflow={used_texera}")
    ok &= used_facts and used_convert and used_texera
    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
