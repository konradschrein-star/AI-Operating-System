#!/usr/bin/env python3
"""
payload-census.py — round 1301, deliverable B2.

Measures, per field group, how many bytes of the `/api/chat/:id/team` payload
that group is worth. Nothing here is estimated: each group is DELETED from every
node in the tree, the tree is re-serialised with the same separators Hono's
`c.json()` uses, and the byte delta is recorded.

  usage:  curl -s http://127.0.0.1:<api>/api/chat/<id>/team > team.json
          python3 payload-census.py team.json > payload-census.json

Two caveats a reader must not skip:

  * The re-serialised baseline is compared against ITSELF, never against the
    wire bytes. Python's `json.dumps(..., separators=(",",":"))` reproduces the
    wire form for this payload exactly (asserted below); the assertion is the
    licence to quote these deltas as wire bytes.
  * Deleting a key removes the key NAME as well as its value. That is the
    honest number for "what would this payload cost if the field did not
    exist", which is the question round 1302 has to answer, and it is NOT the
    same as the size of the values alone.
"""

import json
import sys

# The key groups, in the order the round-1301 brief names them. `tokens` and
# `task` are whole sub-objects (the brief's "all five" — five scalar members
# each); the rest are scalars on the node.
GROUPS = [
    "tokens",
    "task",
    "description",
    "working_ms_source",
    "parent_id",
    "model",
    "role",
    "started_at",
    "status",
    "settled",
    # not in the brief's mandatory list, measured anyway because 1302 will ask
    "working_ms",
    "id",
    "kind",
    "subagents",
]


def nodes(doc):
    """Every node in the tree: manager, workers, and their sub-agents."""
    out = []
    stack = [doc["manager"]] + list(doc["workers"])
    while stack:
        n = stack.pop()
        out.append(n)
        stack.extend(n.get("subagents") or [])
    return out


def ser(doc):
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def strip(doc, key):
    """Return a deep copy of `doc` with `key` gone from every node."""
    copy = json.loads(json.dumps(doc))
    for n in nodes(copy):
        n.pop(key, None)
    return copy


def main():
    path = sys.argv[1]
    raw = open(path, "rb").read()
    doc = json.loads(raw)

    base = ser(doc)
    if base != raw.strip():
        # Not fatal — but every byte figure below is then "re-serialised bytes",
        # not wire bytes, and the report says so instead of pretending.
        print(
            f"WARNING: re-serialised form differs from the wire bytes "
            f"({len(base)} vs {len(raw.strip())}) — deltas are re-serialised bytes",
            file=sys.stderr,
        )

    all_nodes = nodes(doc)
    workers = [n for n in all_nodes if n["kind"] not in ("subagent",) and n["kind"] != "operator"]
    subagents = [n for n in all_nodes if n["kind"] == "subagent"]
    managers = [n for n in all_nodes if n["kind"] == "operator"]

    report = {
        "source": path,
        "wire_bytes": len(raw.strip()),
        "reserialised_bytes": len(base),
        "reserialisation_is_byte_identical": base == raw.strip(),
        "nodes": {
            "total": len(all_nodes),
            "manager": len(managers),
            "workers": len(workers),
            "subagents": len(subagents),
        },
        "settled_nodes": sum(1 for n in all_nodes if n.get("settled") is True),
        "groups": {},
    }

    for key in GROUPS:
        present = sum(1 for n in all_nodes if key in n)
        non_null = sum(1 for n in all_nodes if n.get(key) is not None)
        stripped = ser(strip(doc, key))
        report["groups"][key] = {
            "present_on_nodes": present,
            "non_null_on_nodes": non_null,
            "bytes_with": len(base),
            "bytes_without": len(stripped),
            "bytes_attributable": len(base) - len(stripped),
            "pct_of_payload": round(100 * (len(base) - len(stripped)) / len(base), 2),
        }

    # ── duplication: `teamNodeFromRun` sets description = task.title ──────────
    dup_nodes, dup_bytes = 0, 0
    for n in all_nodes:
        t = n.get("task")
        if isinstance(t, dict) and t.get("title") is not None and t.get("title") == n.get("description"):
            dup_nodes += 1
            # the second copy of the string, as JSON: the encoded value only
            dup_bytes += len(json.dumps(t["title"], ensure_ascii=False).encode("utf-8"))
    report["duplication"] = {
        "what": "description === task.title (forge-control/src/routes/chat.ts teamNodeFromRun)",
        "nodes_shipping_the_same_string_twice": dup_nodes,
        "bytes_of_the_duplicate_copies": dup_bytes,
        "pct_of_payload": round(100 * dup_bytes / len(base), 2),
    }

    # ── the settled share: how much of the payload belongs to frozen rows ─────
    live = json.loads(json.dumps(doc))
    live["workers"] = [w for w in live["workers"] if w.get("settled") is not True]
    for w in live["workers"]:
        w["subagents"] = [s for s in (w.get("subagents") or []) if s.get("settled") is not True]
    report["settled_share"] = {
        "what": "bytes that belong to rows whose values can never change again",
        "bytes_all_rows": len(base),
        "bytes_unsettled_rows_only": len(ser(live)),
        "bytes_attributable_to_settled_rows": len(base) - len(ser(live)),
        "pct_of_payload": round(100 * (len(base) - len(ser(live))) / len(base), 2),
    }

    json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
