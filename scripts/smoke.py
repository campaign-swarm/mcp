#!/usr/bin/env python3
"""MCP smoke test — talk to the server the way an agent would.

Creates (or reuses) an org API key, then:
  1. initialize the session
  2. list the tools
  3. call a read tool and a write tool, checking the role gate

No LLM calls are made: the tools only read the database.

Usage:  python3 mcp/scripts/smoke.py [--mcp http://localhost:3101/mcp]
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from typing import Any, Optional

import requests

# repo root: mcp/scripts/smoke.py -> mcp/scripts -> mcp -> repo
ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
BACKEND = os.environ.get("BACKEND_URL", "http://localhost:8000")


def load_secret() -> str:
    secret = os.environ.get("INTERNAL_HMAC_SECRET")
    if secret:
        return secret
    path = os.path.join(ROOT, "backend", ".env")
    try:
        with open(path) as fh:
            for line in fh:
                if line.startswith("INTERNAL_HMAC_SECRET="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return "dev-secret"


def headers(org: str, role: str = "owner") -> dict:
    user_id = "mcp-smoke"
    ts = int(time.time() * 1000)
    sig = hmac.new(
        load_secret().encode(),
        f"{org}.{user_id}.{role}.{ts}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-Org-Id": org,
        "X-User-Id": user_id,
        "X-Org-Role": role,
        "X-Timestamp": str(ts),
        "X-Signature": sig,
    }


def rpc(url: str, payload: dict, key: Optional[str]) -> Any:
    headers_out = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if key:
        headers_out["Authorization"] = f"Bearer {key}"
    res = requests.post(url, json=payload, headers=headers_out, timeout=60)
    text = res.text
    if res.status_code >= 400:
        return {"__error__": f"{res.status_code}: {text[:300]}"}
    # streamable HTTP may answer with SSE framing
    if text.startswith("event:") or text.startswith("data:"):
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    return json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
        return {"__error__": "no data frame in SSE response"}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"__error__": f"unparseable: {text[:200]}"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mcp", default=os.environ.get("MCP_URL", "http://localhost:3101/mcp"))
    ap.add_argument("--org", default="cs-seed-tenant")
    args = ap.parse_args()

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))
        if not ok:
            failures.append(name)

    def tool(name: str, arguments: dict, use_key: Optional[str] = None, rid: int = 100) -> str:
        """Call a tool and return its text content (or the error frame)."""
        res = rpc(
            args.mcp,
            {
                "jsonrpc": "2.0",
                "id": rid,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
            key if use_key is None else use_key,
        )
        content = res.get("result", {}).get("content", []) if "result" in res else []
        return content[0].get("text", "") if content else json.dumps(res)[:300]

    # A key to talk to the MCP server with.
    res = requests.post(
        f"{BACKEND}/api/keys",
        json={"name": f"mcp-smoke-{uuid.uuid4().hex[:6]}", "role": "owner"},
        headers=headers(args.org),
        timeout=30,
    )
    if res.status_code != 200:
        print(f"  !! could not issue a key: {res.status_code} {res.text[:200]}")
        return 1
    key = res.json()["key"]
    print(f"== MCP smoke against {args.mcp} ==\n  (key {key[:12]}…)\n")

    init = rpc(
        args.mcp,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "smoke", "version": "1.0"},
            },
        },
        key,
    )
    check(
        "initialize",
        "error" not in init and "result" in init,
        json.dumps(init)[:200],
    )

    rpc(args.mcp, {"jsonrpc": "2.0", "method": "notifications/initialized"}, key)

    tools = rpc(args.mcp, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, key)
    listed = tools.get("result", {}).get("tools", []) if "result" in tools else []
    check(f"tools/list returns the tools ({len(listed)})", len(listed) >= 10, json.dumps(tools)[:200])

    call = rpc(
        args.mcp,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "list_social_accounts", "arguments": {} },
        },
        key,
    )
    content = call.get("result", {}).get("content", []) if "result" in call else []
    text = content[0].get("text", "") if content else ""
    check("read tool returns data", "accounts" in text, json.dumps(call)[:200])

    call2 = rpc(
        args.mcp,
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": { "name": "get_data_catalogue", "arguments": {} },
        },
        key,
    )
    content2 = call2.get("result", {}).get("content", []) if "result" in call2 else []
    text2 = content2[0].get("text", "") if content2 else ""
    check("catalogue tool returns the brief", "CONNECTED DATA SOURCES" in text2 or "No connected data" in text2, json.dumps(call2)[:200])

    # Content plans must be linked to a real 12-stage strategy campaign.
    strategy_id = os.environ.get("MCP_STRATEGY_CAMPAIGN_ID", "")
    if not strategy_id:
        listed_campaigns = tool("list_planner_campaigns", {"limit": 10}, rid=8)
        try:
            strategy_id = json.loads(listed_campaigns).get("campaigns", [{}])[0].get("id", "")
        except (json.JSONDecodeError, AttributeError, IndexError):
            strategy_id = ""
    if not strategy_id:
        created_campaign = tool(
            "create_planner_campaign",
            {
                "name": f"MCP smoke strategy {uuid.uuid4().hex[:6]}",
                "mode": "manual",
                "intake_data": {
                    "objective": "Verify the MCP strategy link",
                    "languages": ["English"],
                },
            },
            rid=9,
        )
        try:
            strategy_id = json.loads(created_campaign).get("id", "")
        except (json.JSONDecodeError, AttributeError):
            strategy_id = ""
    check("a planner campaign is available for the draft", bool(strategy_id), listed_campaigns[:250] if not strategy_id else "")

    # A write tool must work for an editor key...
    write = rpc(
        args.mcp,
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "create_post_draft",
                "arguments": {
                    "name": "MCP smoke plan",
                    "objective": "Verify the MCP write path",
                    "platforms": ["instagram"],
                    "strategy_campaign_id": strategy_id,
                },
            },
        },
        key,
    )
    content3 = write.get("result", {}).get("content", []) if "result" in write else []
    text3 = content3[0].get("text", "") if content3 else ""
    plan_id = ""
    try:
        plan_id = json.loads(text3).get("id", "")
    except (json.JSONDecodeError, AttributeError):
        pass
    check("write tool creates a linked draft", bool(plan_id), json.dumps(write)[:300])

    # The override path: the planner does not write the copy, the caller does.
    brief = tool(
        "update_plan_brief",
        {
            "plan_id": plan_id,
            "context_summary": "Naati Ninja is a CCL test prep app; 20% off with NINJA20.",
            "context_position": "Lead with the free mock test, then the discount.",
            "claims": ["20% off at checkout with NINJA20", "First mock test is free"],
        },
        rid=10,
    )
    check("plan brief can be rewritten", "context_summary" in brief, brief[:250])

    created = tool(
        "create_content_item",
        {
            "plan_id": plan_id,
            "caption": "Booked your CCL test yet? Naati Ninja's mock exams mirror the real thing.",
            "hashtags": ["CCL", "NaatiNinja"],
            "status": "approved",
        },
        rid=11,
    )
    item_id = ""
    try:
        item_id = json.loads(created).get("id", "")
    except (json.JSONDecodeError, AttributeError):
        pass
    check("copy can be authored without the planner", bool(item_id), created[:250])

    edited = tool(
        "update_content_asset",
        {"item_id": item_id, "caption": "Edited by the agent.", "status": "rejected"},
        rid=12,
    )
    check("an asset can be edited in place", "Edited by the agent." in edited, edited[:250])

    unowned = tool("create_content_item", {"plan_id": str(uuid.uuid4()), "caption": "x"}, rid=14)
    check("an asset needs a real plan", "not found" in unowned.lower(), unowned[:200])

    # ...and be refused for a viewer key.
    viewer_res = requests.post(
        f"{BACKEND}/api/keys",
        json={"name": f"mcp-viewer-{uuid.uuid4().hex[:6]}", "role": "viewer"},
        headers=headers(args.org),
        timeout=30,
    )
    viewer_key = viewer_res.json()["key"]
    denied = rpc(
        args.mcp,
        {
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "create_post_draft",
                "arguments": {
                    "name": "nope",
                    "objective": "nope",
                    "strategy_campaign_id": strategy_id,
                },
            },
        },
        viewer_key,
    )
    content4 = denied.get("result", {}).get("content", []) if "result" in denied else []
    text4 = content4[0].get("text", "") if content4 else json.dumps(denied)[:200]
    check("viewer key cannot write", "cannot" in text4.lower(), text4[:200])

    refused = tool(
        "update_content_asset",
        {"item_id": item_id, "caption": "viewer should not get here"},
        use_key=viewer_key,
        rid=13,
    )
    check("viewer key cannot edit assets", "cannot" in refused.lower(), refused[:200])

    # A bad key is refused.
    bad = rpc(
        args.mcp,
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": { "name": "list_social_accounts", "arguments": {} },
        },
        "csw_not-a-real-key",
    )
    content5 = bad.get("result", {}).get("content", []) if "result" in bad else []
    text5 = content5[0].get("text", "") if content5 else json.dumps(bad)[:200]
    check("an invalid key is refused", "not accepted" in text5.lower() or "required" in text5.lower(), text5[:200])

    print(f"\n{'all good' if not failures else str(len(failures)) + ' failed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
