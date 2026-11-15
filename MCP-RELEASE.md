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

## Production deployment

The hosted service is live with OAuth enabled. It runs from the manual checkout
at `/opt/campaign-swarm/mcp` under `campaign-swarm-mcp.service`, behind nginx on
`127.0.0.1:3101`. The deployed commit is `7b70335`. The unit reads the mode-600
`/opt/campaign-swarm/mcp/.env`, which now sets `MCP_PUBLIC_URL`,
`OAUTH_STATE_FILE=/var/lib/campaign-swarm/mcp-oauth.json`, and
`OAUTH_ENCRYPTION_KEY`. The state file is mode 600, owner `campaign`.

Both public discovery URLs return 200. A full production run passed DCR, S256
authorization, API-key consent, token exchange, OAuth MCP initialize/tools-list,
refresh rotation, and revocation. Direct `csw_...` bearer initialize/tools-list
also passed. A token issued before a real service restart was accepted
afterward, and a refresh token still worked after that restart. The temporary
E2E key was revoked and the test token state was cleared afterward.

The deployment is manual, as recorded in the project handover: archive the
committed source into `/opt/campaign-swarm/mcp`, install the frozen lockfile,
and restart only `campaign-swarm-mcp.service`. There is no repo deploy
workflow and no `.git` checkout on the host. The full reviewer pack is in
`v1/docs/MCP-CLIENT-SUBMISSIONS.md`.

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
`server.json`, logs in with `github-oidc`, and publishes. The first run on
2026-11-15 succeeded and published version `0.1.0`; the registry reports status
`active` and `isLatest: true`.

The validator warns that the current registry schema is `2025-12-11` and this
descriptor uses `2025-09-29`. The old schema is still accepted; migrate before
the next version publish if the registry drops support.

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
| mcpservers.org | **Live** at https://mcpservers.org/servers/campaignswarm-com. The page still shows the older 25-tool copy and “read-only until approved”; “Request update” was clicked again on 2026-11-15, changed to **Requested** and is disabled, while the public copy remains unchanged. No paid placement was purchased. |
| Glama | **Live and healthy** at https://glama.ai/mcp/connectors/com.campaignswarm.mcp/campaign-swarm. Ownership verified; public page reports Status Healthy, 35 tools, last tested 2026-11-15 16:45. A dedicated viewer key is configured under Admin → Test Profile → API Key → Bearer Authentication; its 16:45 test passed in 2,768 ms. The key is stored only in Glama, not in this repository. |
| Launch MCP | Submitted through the keyless REST API. Live readback returns `status: pending`, transport `hosted`, category `Productivity`, and no listing URL. No authenticated edit endpoint exists for a pending submission, so it was left intact rather than duplicated. |
| AgenticSkills | Submitted through the public MCP form; pending weekly triage. The public repo serves the full release copy. |
| Official MCP Registry | **Published** `io.github.campaign-swarm/mcp@0.1.0` on 2026-11-15 via GitHub OIDC. Registry status `active`, `publishedAt` `2026-11-15T05:04:50.296351Z`, search count 1. Publish run [43679498960](https://github.com/campaign-swarm/mcp/actions/runs/43679498960) succeeded; no device code, PAT, or registry token. |
| GitHub MCP Registry | Follows the official registry; the entry now exists. No separate form. |
| PulseMCP | Submissions paused since September 3, 2026; it imports the official registry when it reopens. The official entry now exists, so no separate submission is needed. |
| MCP Market | Submitted to the $0 Free Queue; API check returns `exists:false`; pending ~4–6 weeks. A duplicate re-submit on 2026-11-15 returned HTTP **409** `{"error":"This repository is already in our queue."}`, confirming the earlier submission is still queued, not lost. Paid upgrades ($29/$69) not purchased. |
| MCP.so | Account created under support@; signed-in “My submissions” shows 0 records. Both submission forms now expose only **Paid submission — $39 one-time** and **Pay and submit automatically**; an earlier free-plan API call returned `{"code":-1,"message":"Free submissions are currently paused"}`. No payment was made and no listing was created. |
| Docker MCP Catalog | PR #7137 is open and mergeable but `unstable`; ci.yaml run 43659671963 completed as `action_required` with 0 jobs and awaits a Docker maintainer’s approval. The separate test-credentials form was submitted on 2026-11-15 with PR #7137, support@campaignswarm.com, and a dedicated read-only key; Google Forms confirmed “Got it. We'll email you with a resolution.” No catalog listing exists yet. |
| Smithery | Sign-in, dashboard, /new, and /servers/new all show the October 31, 2026 shutdown notice; no submission path. |
| Claude Connectors | Account created 2026-11-15 under support@campaignswarm.com and signed in on the Free plan. `https://claude.ai/directory/manage` states **“Directory submissions need a paid plan”** and lists Pro/Max/Ultra/Team/Enterprise; no submission. User-only paid-plan decision plus reviewer test workspace/key. |
| OpenAI Apps | Account created 2026-11-15 under support@campaignswarm.com (name Dhruv, organization Campaign Swarm) and signed in at platform.openai.com/plugins. The plugin ZIP is built and validated at `v1/campaign-swarm-openai-plugin.zip` (portable manifest, one skill, four 512px icons, 5 positive / 3 negative cases). Upload is blocked by **“Complete identity verification”** -> **“Payment method required”**: a default payment method is required before upload. No plugin uploaded or submitted. |
| Cursor | Cursor Directory submission is unpublished/hidden. Repo payload repaired locally in commit `1cf8cbc` (unpushed) with schema-valid root `plugin.json`/`mcp.json` (`streamable-http`, OAuth, no placeholder); the rescan still returned `scan_status:error` with `flag_summary: "Cursor SDK startup failed: Invalid User API Key"` and `scan_run_id:null` at `2026-11-15T06:30:46.109+00:00`. This is Cursor’s scanner key failing, not the payload; only an admin re-run can clear it. Do not resubmit. |

The `support@campaignswarm.com` inbox was checked on 2026-11-15 and is not
reachable from this session: no mail tab was open, `mail.google.com` showed the
public Gmail marketing page with “Sign in”/“Create an account”, and
`v1/creds/creds.txt` contains no mailbox, IMAP, SMTP, or webmail credential.
The user supplied a fresh Claude magic link and OpenAI code on 2026-11-15; both
were accepted and both accounts were created. Claude is blocked by the paid-plan
requirement; OpenAI is blocked at upload by identity verification requiring a
default payment method. Neither listing is submitted.

Glama sent a $49/month Boost offer on 2026-11-15. It is paid advertising and was
not purchased; health checks and scoring remain independent.

## Security check

`campaign-swarm/mcp` is public as of 2026-11-15. Secret scanning and push
protection are enabled, and the open secret-scanning endpoint returns **0
alerts**. Code scanning has no analysis and Dependabot alerts are disabled. The
independent history scan below found no live credential. The public
`campaign-swarm/mcp-registry` fork has secret scanning enabled with **0 open
alerts**. GitHub notifications show 0 unread; the security log shows the
account-level `user.sign_in_from_unrecognized_device` / `user.new_device_used`
event and the Cursor Directory / GitHub CLI OAuth authorizations. The user
confirmed the review of that device/OAuth event on 2026-11-15; no alert or
session was changed, and secret scanning and push protection were enabled on
`mcp`.

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
