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

## Client configuration

### Claude Desktop / Claude Code

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
