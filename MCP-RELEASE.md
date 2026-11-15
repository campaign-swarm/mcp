# Campaign Swarm MCP release

## Release identity

| Field | Value |
| --- | --- |
| Registry name | `io.github.campaign-swarm/mcp` |
| Version | `0.1.0` |
| Source | https://github.com/campaign-swarm/mcp |
| Endpoint | https://mcp.campaignswarm.com/mcp |
| Transport | streamable HTTP |
| Auth | `Authorization: Bearer csw_...` |
| Tools | 35 total: 20 read, 15 write |

## Registry readiness

`server.json` is written for the official MCP Registry schema dated
2025-09-29. It describes the hosted streamable-HTTP endpoint and marks the
Authorization header as required and secret. The descriptor validates with
zero schema errors.

The registry requires the GitHub repository to be public and the publisher to
authenticate as the owner of the `campaign-swarm` namespace. The repository is
now public (user changed visibility on 2026-11-15). This release run
deliberately did not change visibility or publish to the official registry;
publisher authorization is still required.

`LICENSE` is MIT (Copyright 2026 Campaign Swarm), so the Docker MCP Catalog
license prerequisite is satisfied.

## Published release content

`README.md`, `LICENSE`, `server.json`, and this file are committed to the public
default branch so repo-derived listings can use the full release copy. The
`csw_` values in `src/index.test.ts` are synthetic test fixtures, not live
credentials; no real API key, token, OTP, or credential is committed.

## Marketplace status

| Destination | Status |
| --- | --- |
| mcpservers.org | Submitted to the free queue; review quoted at two weeks. |
| Glama | Hosted connector submitted and currently marked unhealthy after two 401 checks because the test profile sends no Authorization header. Glama holds no Campaign Swarm credential; awaiting the user's dedicated viewer key under Admin → Test Profile. No key is stored in this repository. |
| Launch MCP | Submitted through the keyless REST API; live status page says “In review”; no public listing URL yet. |
| AgenticSkills | Submitted through the public MCP form; pending weekly triage. |
| Official MCP Registry | Descriptor validates; repository public; no successful publish because the GitHub CLI token exchange returned 401. Interactive device flow/PAT publisher authorization remains. |
| GitHub MCP Registry | Follows the official registry; no separate form. |
| PulseMCP | Submissions paused since September 3, 2026; imports the official registry when it reopens. |
| MCP Market | Submitted to the $0 Free Queue; API check returns `exists:false`; pending ~4–6 weeks. Paid upgrades ($29/$69) not purchased. |
| MCP.so | Account created under support@; authenticated free plan returns “Free submissions are currently paused”; $39 paid path not purchased. |
| Docker MCP Catalog | Parked by user request. PR #7137 remains open; ci.yaml run 43659671963 is action_required with 0 jobs and awaits a Docker maintainer’s approval. |
| Smithery | Sign-in, dashboard, /new, and /servers/new all show the October 31, 2026 shutdown notice; no submission path. |
| Claude Connectors | Blocked: OAuth 2.0, test account, tool annotations, and a paid Claude plan (free cannot submit). |
| OpenAI Apps | Blocked: OAuth, verified publisher, domain challenge, tool scan, and review tests. |
| Cursor | Submitted to Cursor Directory as a manual MCP server component; scan failed and an admin re-run is pending; listing unpublished/hidden. Official Marketplace uses a separate publisher application. |

## Security check

`campaign-swarm/mcp` is public as of 2026-11-15. Secret scanning and push
protection are now enabled, and the open secret-scanning endpoint returns **0
alerts**. Code scanning has no analysis and Dependabot alerts are disabled. The
independent history scan below found no live credential. The public
`campaign-swarm/mcp-registry` fork has secret scanning enabled with **0 open
alerts**. GitHub notifications
show 0 unread; the security log shows the account-level
`user.sign_in_from_unrecognized_device` / `user.new_device_used` event and the
Cursor Directory / GitHub CLI OAuth authorizations. That is a device/OAuth
review item, not a leaked-secret alert. No alert or session was changed; secret
scanning and push protection were enabled on `mcp`.

The public history is the source-only initial commit plus this release-content
commit; a full-history and working-tree scan for `csw_` keys,
GitHub/OpenAI/AWS/Slack/Google/SendGrid tokens, JWTs, and private-key blocks
found no high-risk credential. The test fixture values are synthetic. No `.env` or credential file
is tracked; `v1/creds/creds.txt` is outside the repository and remains mode
`600`.

## Safety model

The server authenticates every request at the door. Write tools require an
editor-or-higher key and create drafts, schedules, or approval items. No tool
publishes content, approves a human gate, runs SQL, or makes an arbitrary HTTP
request.
