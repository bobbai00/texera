"""On the cluster an agent reaches every MCP server a chat mounts: an add-on's URL is read from
inside the agent runtime's pod, where localhost is the pod itself. An add-on it cannot reach is
left out of every turn, so no scenario that skips the model would notice."""
from urllib.parse import urlparse

import pytest

from texera_e2e import kube
from texera_e2e.client import uri_rid


@pytest.mark.cluster
def test_the_runtime_reaches_every_mcp_server(alice, kubectl):
    # What a new chat mounts, as the catalog resolves it. The platform's own server is reached
    # at the gateway whatever its URL says; an add-on goes by its URL.
    mounted = alice.get(f"/projects/{alice.home()}/chat-settings")["mcpServers"]
    assert [m["name"] for m in mounted if m["platform"]] == ["catalog"]
    add_ons = [m for m in mounted if not m["platform"]]
    assert add_ons, "the platform ships the bio server as an add-on"
    for add_on in add_ons:
        name, url = add_on["name"], alice.get(f"/mcp-servers/{uri_rid(add_on['uri'])}")["spec"]["url"]
        assert urlparse(url).hostname not in ("localhost", "127.0.0.1"), f"{name} at {url} is the pod itself"
        if kubectl:
            answer = kube.fetch_from("agent-runtime", url)
            assert answer.isdigit(), f"{name} at {url}: {answer}"
