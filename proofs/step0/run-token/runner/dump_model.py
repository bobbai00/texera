"""Print the OpenFGA authorization model Lakekeeper wrote, as readable DSL.

  SCE0TOK_KEEP=1 ./run.sh                     # leave the stack up
  .venv/bin/python -I runner/dump_model.py    # reads OpenFGA's HTTP API on 127.0.0.1:19502
  ./run.sh --down

or, for a saved response:  .venv/bin/python -I runner/dump_model.py models.json
"""

import json
import sys
import urllib.request

FGA = "http://127.0.0.1:19502"


def fetch():
    with urllib.request.urlopen(FGA + "/stores") as resp:
        store = json.load(resp)["stores"][0]["id"]
    with urllib.request.urlopen("%s/stores/%s/authorization-models" % (FGA, store)) as resp:
        return json.load(resp)


def render(rw):
    if "this" in rw:
        return "[direct]"
    if "computedUserset" in rw:
        return rw["computedUserset"]["relation"]
    if "tupleToUserset" in rw:
        t = rw["tupleToUserset"]
        return "%s from %s" % (t["computedUserset"]["relation"], t["tupleset"]["relation"])
    if "union" in rw:
        return " or ".join(render(c) for c in rw["union"]["child"])
    if "intersection" in rw:
        return "(" + " and ".join(render(c) for c in rw["intersection"]["child"]) + ")"
    if "difference" in rw:
        return "(%s but not %s)" % (render(rw["difference"]["base"]), render(rw["difference"]["subtract"]))
    return json.dumps(rw)


def main():
    data = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else fetch()
    model = data["authorization_models"][0]  # newest first
    print("# OpenFGA model %s (schema %s), as written by Lakekeeper" % (model["id"], model.get("schema_version")))
    for td in model["type_definitions"]:
        print("type %s" % td["type"])
        meta = (td.get("metadata") or {}).get("relations") or {}
        for rel, rw in sorted((td.get("relations") or {}).items()):
            direct = meta.get(rel, {}).get("directly_related_user_types") or []
            types = ", ".join(d["type"] + ("#" + d["relation"] if d.get("relation") else "") +
                              (":*" if d.get("wildcard") is not None else "") for d in direct)
            text = render(rw)
            if types:
                text = text.replace("[direct]", "[" + types + "]")
            print("  define %s: %s" % (rel, text))


if __name__ == "__main__":
    main()
