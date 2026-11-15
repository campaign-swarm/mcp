# Campaign Swarm MCP

Campaign Swarm is an AI campaign workspace for agencies. This server exposes the
campaign workflow over the Model Context Protocol: plan a campaign, create and
adapt content, schedule posts, inspect performance, and review the approval
queue from Claude, Cursor, VS Code, or any MCP-compatible client.

## Hosted endpoint

```
https://mcp.campaignswarm.com/mcp
```

Transport: streamable HTTP.

The hosted server uses the same organization API keys as the Campaign Swarm
dashboard. Create a key in **Settings → API keys**, then send it as a bearer
token:

```
Authorization: Bearer csw_...
```

Anonymous requests receive `401`. The key resolves the organization and role on
the API; read tools work for any valid key, and write tools require an editor,
admin, or owner key.

## OAuth 2.1 for Claude and OpenAI

The hosted endpoint also supports OAuth 2.1 authorization-code + PKCE for
clients that require OAuth. Discovery is published at:

```
https://mcp.campaignswarm.com/.well-known/oauth-protected-resource/mcp
https://mcp.campaignswarm.com/.well-known/oauth-authorization-server
```

The server supports Client ID Metadata Documents (CIMD), Dynamic Client
Registration (DCR), S256 PKCE, resource indicators, refresh-token rotation, and
the `mcp:tools` scope. The consent page asks for a Campaign Swarm API key; use
a read-only key for evaluation. The key is sent only to Campaign Swarm, is
encrypted in the authorization store, and is never placed in a URL.

OAuth is enabled on the server by setting `OAUTH_ENCRYPTION_KEY` and a writable
`OAUTH_STATE_FILE`; see `.env.example`. API-key clients continue to work with
or without OAuth enabled.

The hosted service is running this build with OAuth enabled as of 2026-11-15.
Both discovery endpoints return 200, and a full authorization, refresh, and
restart-persistence flow has passed against `https://mcp.campaignswarm.com`.
API-key clients continue to work unchanged. The service stores clients and
tokens in a mode-600 state file on persistent disk; it is single-process state,
so do not run multiple MCP replicas against the same file.

## Client configuration

### Claude Desktop / Claude Code

OAuth (preferred; live in production) — no header is needed:

```json
{
  "mcpServers": {
    "campaign-swarm": {
      "type": "http",
      "url": "https://mcp.campaignswarm.com/mcp"
    }
  }
}
```

API-key fallback:

```json
{
  "mcpServers": {
    "campaign-swarm": {
      "type": "http",
      "url": "https://mcp.campaignswarm.com/mcp",
      "headers": {
        "Authorization": "Bearer csw_REPLACE_WITH_YOUR_KEY"
      }
    }
  }
}
```

### Cursor

Add a remote MCP server named `campaign-swarm` with the URL above and the same
`Authorization` header.

### VS Code

```json
{
  "servers": {
    "campaign-swarm": {
      "type": "http",
      "url": "https://mcp.campaignswarm.com/mcp",
      "headers": {
        "Authorization": "Bearer csw_REPLACE_WITH_YOUR_KEY"
      }
    }
  }
}
```

## Tool surface

The server exposes 35 tools: 20 read tools and 15 write tools. Read tools cover
connected accounts, pages, posts, comments, plans, projects, schedules,
publish queue, ads, content assets, planner stages, and performance. Write
tools cover projects, content items, post drafts, schedules, planner runs,
ads budgets/pauses, comment replies, and performance learnings.

Write tools never publish or approve silently. They create drafts, schedules,
or approval items for a human to review in Campaign Swarm. The server does not
expose raw SQL, arbitrary HTTP requests, publish, approval, or human-gate
bypasses.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
MCP_PORT=3101 INTERNAL_API_URL=http://localhost:8000 ./run-mcp.sh
```

The process binds to loopback by default. TLS is terminated by the reverse
proxy in production.

## Links

- Website: https://campaignswarm.com
- Privacy: https://campaignswarm.com/privacy
- Terms: https://campaignswarm.com/terms
- Support: support@campaignswarm.com
- Registry descriptor: [`server.json`](./server.json)
- Release and marketplace status: [`MCP-RELEASE.md`](./MCP-RELEASE.md)
- Claude, OpenAI, and Cursor submission pack: [`../docs/MCP-CLIENT-SUBMISSIONS.md`](../docs/MCP-CLIENT-SUBMISSIONS.md)
