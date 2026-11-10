"""A dataset takes a file from the internet as it takes an upload: the catalog fetches it into
the staging area itself, so its bytes never pass through a chat. It fetches from the public
internet only: the platform's own services, reached by address or by a name that resolves to
one, get nothing, and neither does a URL that is not https. Someone who may only read the
dataset imports nothing. The fetch of a real public file is in the diabetes use case, which
needs the internet anyway."""
import urllib.parse

import pytest


@pytest.fixture
def dataset(alice, project):
    return alice.create("datasets", "an import", {"format": "csv"}, project=project)["metadata"]["rid"]


def test_an_import_reaches_the_public_internet_only(alice, dataset, request):
    gw = urllib.parse.urlsplit(request.config.getoption("--gw"))
    # The gateway's port, which its URL names only when it is not the scheme's own.
    port = gw.port or (443 if gw.scheme == "https" else 80)
    refused = {
        # The platform's own gateway, by the name this machine knows it by and by its address.
        f"https://localhost:{port}/catalog/v1/public": "is not on the public internet",
        f"https://127.0.0.1:{port}/catalog/v1/public": "127.0.0.1 is not on the public internet",
        # The cloud's metadata service, a private network, the loopback of IPv6.
        "https://169.254.169.254/latest/meta-data/": "is not on the public internet",
        "https://10.0.0.1/data.csv": "10.0.0.1 is not on the public internet",
        "https://[::1]/data.csv": "::1 is not on the public internet",
        # Not https, a password in the URL, no file named.
        "http://example.org/data.csv": "only https is fetched",
        "https://someone:secret@example.org/data.csv": "a user and password do not go in a URL",
        "https://example.org/": "the URL names no file",
    }
    for url, says in refused.items():
        status, body = alice.call("POST", f"/datasets/{dataset}/import", {"url": url})
        assert status == 400 and says in body["message"] and body["details"]["field"] in ("url", "path"), (url, body)
    assert alice.get(f"/datasets/{dataset}/staged")["files"] == [], "nothing was staged"


def test_who_may_only_read_a_dataset_imports_nothing(alice, bob, project, dataset, grants_guard):
    grants_guard(project, bob.pid(), "viewer")
    status, _ = bob.call("POST", f"/datasets/{dataset}/import", {"url": "https://example.org/data.csv"})
    assert status == 403
    assert alice.get(f"/datasets/{dataset}/staged")["files"] == []
