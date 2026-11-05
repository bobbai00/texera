"""On the cluster an agent reaches every MCP server a template mounts: a server's URL is read from
inside the agent runtime's pod, where localhost is the pod itself. A server it cannot reach fails
the whole turn before any model call, so no scenario that skips the model would notice."""
from urllib.parse import urlparse

import pytest

from texera_e2e import kube


@pytest.mark.cluster
def test_the_runtime_reaches_every_mcp_server(alice, kubectl):
    # The platform's own servers are rewritten to the gateway at mount; the others go by their URL.
    servers = [s for s in alice.get("/mcp-servers")["items"] if not s["spec"].get("builtin")]
    assert servers, "the platform seeds the bio server"
    for server in servers:
        name, url = server["metadata"]["name"], server["spec"]["url"]
        assert urlparse(url).hostname not in ("localhost", "127.0.0.1"), f"{name} at {url} is the pod itself"
        if kubectl:
            answer = kube.fetch_from("agent-runtime", url)
            assert answer.isdigit(), f"{name} at {url}: {answer}"
