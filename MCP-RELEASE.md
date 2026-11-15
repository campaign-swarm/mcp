# Campaign Swarm MCP release

## Release identity

| Field | Value |
| --- | --- |
| Registry name | `io.github.campaign-swarm/mcp` |
| Version | `0.1.0` |
| Source | https://github.com/campaign-swarm/mcp |
| Endpoint | https://mcp.campaignswarm.com/mcp |
| Transport | streamable HTTP |
| Auth | `Authorization: Bearer csw_...` or OAuth 2.1 access token |
| Tools | 35 total: 20 read, 15 write |
| License | MIT |

## OAuth 2.1 for Claude and OpenAI

The server now implements an OAuth 2.1 authorization-code flow with S256 PKCE,
RFC 8707 resource binding, RFC 9207 issuer responses, RFC 9728
protected-resource metadata, RFC 8414 authorization-server metadata, refresh
token rotation, revocation, dynamic client registration, and Client ID Metadata
Documents for known Claude, OpenAI, and Cursor hosts.

The consent page accepts a Campaign Swarm API key, validates it against the
Campaign Swarm API, and stores it encrypted with AES-256-GCM in a mode-600
server-side state file. The API key never appears in a URL and is never returned
to the MCP client. Direct `csw_...` keys remain supported, so existing clients do
not need to migrate.

The implementation is in `src/oauth.ts`; setup is documented in `.env.example`
and `README.md`. The server is enabled by `OAUTH_ENCRYPTION_KEY` and a writable
`OAUTH_STATE_FILE`. It is deliberately single-process state.

**Production gate:** the hosted endpoint is still running the API-key-only
build. On 2026-11-15,
`https://mcp.campaignswarm.com/.well-known/oauth-protected-resource/mcp` and
`https://mcp.campaignswarm.com/.well-known/oauth-authorization-server` both
returned 404, and the anonymous challenge advertised only
`Bearer realm="Campaign Swarm"`. Claude/OpenAI submission remains blocked until
this commit is deployed and both discovery URLs return 200. The full reviewer
pack is in `v1/docs/MCP-CLIENT-SUBMISSIONS.md`.

## Registry readiness

`server.json` is written for the official MCP Registry schema dated
2025-09-29. It describes the hosted streamable-HTTP endpoint and marks the
Authorization header as required and secret. The descriptor validates with
zero schema errors.

The registry requires the GitHub repository to be public and the publisher to
authenticate as the owner of the `campaign-swarm` namespace. The repository is
public. `.github/workflows/publish-mcp.yml` publishes through GitHub OIDC, which
is the official path that can publish an organization namespace without the
interactive device flow. It runs on `workflow_dispatch` and `v*` tags, validates
`server.json`, logs in with `github-oidc`, and publishes.

## Published release content

`README.md`, `LICENSE`, `server.json`, and this file are committed to the public
default branch so repo-derived listings can use the full release copy. The
earlier release files were fetched over HTTPS from
`https://raw.githubusercontent.com/campaign-swarm/mcp/main/`; every file
returned HTTP 200, and the README, LICENSE, and `server.json` bytes matched the
local SHA-256 hashes exactly. The live `server.json` was revalidated with
`mcp-publisher validate` and returned `✅ server.json is valid` (with the known
2025-09-29 schema deprecation warning).

The `csw_` values in `src/index.test.ts` are synthetic test fixtures, not live
credentials; no real API key, token, OTP, or credential is committed.

## Marketplace status

| Destination | Status |
| --- | --- |
| mcpservers.org | **Live** at https://mcpservers.org/servers/campaignswarm-com. The page still shows the older 25-tool copy; its “Request update” control was used on 2026-11-15 and the request was accepted. No paid placement was purchased. |
| Glama | Hosted connector submitted and marked unhealthy after two 401 checks because the Glama test profile sends no Authorization header. Glama holds no Campaign Swarm credential. A dedicated read-only test key still must be created and entered under Admin → Test Profile; no key is stored in this repository. |
| Launch MCP | Submitted through the keyless REST API. Live readback returns `status: pending`, transport `hosted`, category `Productivity`, and no listing URL. No authenticated edit endpoint exists for a pending submission, so it was left intact rather than duplicated. |
| AgenticSkills | Submitted through the public MCP form; pending weekly triage. The public repo serves the full release copy. |
| Official MCP Registry | Not yet listed. The live published `server.json` validates; the registry search returns `count: 0`. The device flow cannot publish the organization namespace and the previous non-interactive token exchange returned 401. The GitHub OIDC workflow is now committed; the first publish run result is recorded in the rollout ledger. |
| GitHub MCP Registry | Follows the official registry; no separate form. |
| PulseMCP | Submissions paused since September 3, 2026; imports the official registry when it reopens. |
| MCP Market | Submitted to the $0 Free Queue; API check returns `exists:false`; pending ~4–6 weeks. The listing is generated from the public repository with the full release copy. Paid upgrades ($29/$69) not purchased. |
| MCP.so | Account created under support@; authenticated free plan returns “Free submissions are currently paused”; $39 paid path not purchased. |
| Docker MCP Catalog | Parked by user request. PR #7137 remains open; ci.yaml run 43659671963 is action_required with 0 jobs and awaits a Docker maintainer’s approval. |
| Smithery | Sign-in, dashboard, /new, and /servers/new all show the October 31, 2026 shutdown notice; no submission path. |
| Claude Connectors | OAuth implementation ready; production deploy, paid Claude plan, and reviewer test account remain. Not submitted. |
| OpenAI Apps | OAuth implementation ready; production deploy, verified publisher, domain challenge, tool scan, and review tests remain. Not submitted. |
| Cursor | Cursor Directory submission is unpublished/hidden after a failed security scan and an admin re-run is pending. The official Marketplace uses a separate publisher application. Do not resubmit. |

## Security check

`campaign-swarm/mcp` is public as of 2026-11-15. Secret scanning and push
protection are enabled, and the open secret-scanning endpoint returns **0
alerts**. Code scanning has no analysis and Dependabot alerts are disabled. The
independent history scan below found no live credential. The public
`campaign-swarm/mcp-registry` fork has secret scanning enabled with **0 open
alerts**. GitHub notifications show 0 unread; the security log shows the
account-level `user.sign_in_from_unrecognized_device` / `user.new_device_used`
event and the Cursor Directory / GitHub CLI OAuth authorizations. That is a
device/OAuth review item, not a leaked-secret alert. No alert or session was
changed; secret scanning and push protection were enabled on `mcp`.

The public history is the source-only initial commit plus the release-content
and status commits; a full-history and working-tree scan for `csw_` keys,
GitHub/OpenAI/AWS/Slack/Google/SendGrid tokens, JWTs, and private-key blocks
found no high-risk credential. The test fixture values are synthetic. No `.env`
or credential file is tracked; `v1/creds/creds.txt` is outside the repository
and remains mode `600`.

## Safety model

The server authenticates every request at the door. Write tools require an
editor-or-higher key and create drafts, schedules, or approval items. No tool
publishes content, approves a human gate, runs SQL, or makes an arbitrary HTTP
request. OAuth access tokens are bound to the same API key and scope, so the
approval gate does not weaken when the client uses OAuth.
