/**
 * Campaign Swarm MCP server.
 *
 * Speaks MCP over streamable HTTP. Every call is authenticated with an org API
 * key (`csw_…`) — the same keys the dashboard issues — and is forwarded to the
 * FastAPI BFF, which resolves the org, the role and the audit trail.
 *
 * Read tools work on any key. Write tools need an editor key; anything that
 * speaks publicly or spends money creates an approval item instead of acting
 * silently. Approving, rejecting and retracting are dashboard-only on purpose.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { installOAuth } from "./oauth.ts";

const PORT = Number(process.env.MCP_PORT ?? 3101);
const API_BASE = (process.env.INTERNAL_API_URL ?? "http://localhost:8000").replace(
  /\/$/,
  ""
);
const CELL_ID = process.env.CELL_ID ?? "";
// In a shared local stack the cell API does not own the control-plane agency
// record. Allow branding to resolve from the control plane while tool calls stay
// on the cell API; production leaves this equal to INTERNAL_API_URL.
const BRANDING_BASE = (process.env.BRANDING_API_URL ?? API_BASE).replace(/\/$/, "");

/**
 * Cell branding for user-visible MCP text. The control plane owns the identity;
 * this process only mirrors it. When a cell is unconfigured, the documented
 * local fallback is used and `configured` stays false.
 */
const BRAND = {
  name: "Campaign Swarm",
  supportEmail: "support@campaignswarm.com",
  domain: null as string | null,
  configured: false,
};

async function refreshBranding(): Promise<void> {
  if (!CELL_ID) return;
  try {
    const res = await fetch(
      `${BRANDING_BASE}/api/cell/branding?cell_id=${encodeURIComponent(CELL_ID)}`
    );
    if (!res.ok) return;
    const body = (await res.json()) as {
      name?: string;
      support_email?: string;
      custom_domain?: string | null;
      configured?: boolean;
    };
    if (body.name?.trim()) BRAND.name = body.name.trim();
    if (body.support_email?.trim()) BRAND.supportEmail = body.support_email.trim();
    BRAND.domain = body.custom_domain ?? null;
    BRAND.configured = Boolean(body.configured);
  } catch {
    // Keep the documented fallback; never borrow another cell's identity.
  }
}

// ── upstream client ────────────────────────────────────────────────────────

export type Caller = { orgId: string; role: string; keyPrefix: string };

export class ApiError extends Error {
  status: number;
  /** Plan-limit telemetry when the API refused on a quota (429/403). */
  limit: {
    code?: string;
    metric?: string;
    plan?: string;
    used?: number;
    limit?: number | null;
    reset_at?: string | null;
    retry_after?: number | null;
    upgrade?: { plan?: string | null; name?: string } | null;
  } | null;

  constructor(message: string, status: number, body?: any) {
    super(message);
    this.status = status;
    // The API answers a limit with the same envelope every time; keeping it on
    // the error lets the agent tell the user *when* it resets and what fixes it,
    // instead of only repeating "429".
    this.limit = body?.metric ? { ...body } : null;
  }
}

/** Forward a request to the API with the caller's key, and read the org/role back. */
async function api(
  caller: Caller,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {}
): Promise<any> {
  const url = new URL(`${API_BASE}/api/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${caller.keyPrefix}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const message =
      body?.error ?? body?.detail ?? `The API returned ${res.status}`;
    throw new ApiError(
      typeof message === "string" ? message : JSON.stringify(message).slice(0, 200),
      res.status,
      body
    );
  }
  return body;
}

/** Resolve the caller from their key, and check their role. */
export async function authenticate(
  key: string
): Promise<Caller> {
  if (!key || !key.startsWith("csw_")) {
    throw new ApiError(`A ${BRAND.name} API key is required`, 401);
  }
  const res = await fetch(`${API_BASE}/api/keys/verify`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new ApiError("That API key was not accepted", 401);
  }
  const body = (await res.json()) as { org_id?: string; role?: string };
  return {
    orgId: body.org_id ?? "",
    role: body.role ?? "viewer",
    keyPrefix: key,
  };
}

export function canWrite(role: string): boolean {
  return ["editor", "admin", "owner"].includes(role);
}

// ── tools ──────────────────────────────────────────────────────────────────

type ToolHandler = (caller: Caller, args: any) => Promise<string>;

type ToolSpec = {
  name: string;
  title: string;
  description: string;
  write: boolean;
  schema: z.ZodTypeAny;
  handler: ToolHandler;
};

const iso = (value?: string | null) =>
  value ? new Date(value).toISOString() : "unknown date";

export const TOOLS: ToolSpec[] = [
  {
    name: "list_social_accounts",
    title: "List connected accounts",
    description:
      "Connected Facebook pages, Instagram business accounts and Threads profiles, with tracking state and last sync.",
    write: false,
    schema: z.object({}).passthrough(),
    handler: async (caller) => {
      const body = await api(caller, "social/accounts");
      const rows = (body.social_accounts ?? []).map((a: any) => ({
        id: a.id,
        platform: a.platform,
        name: a.name,
        handle: a.handle,
        posting_identity: a.posting_identity,
        identity_label: a.identity_label,
        tracking_enabled: a.tracking_enabled,
        last_synced_at: iso(a.last_synced_at),
      }));
      return JSON.stringify({ accounts: rows }, null, 2);
    },
  },
  {
    name: "get_page_summary",
    title: "Page summary",
    description:
      "Followers, reach, impressions and profile views for one account over a window.",
    write: false,
    schema: z.object({
      account_id: z.string().describe("The social account id"),
      days: z.number().int().min(1).max(365).default(28),
    }),
    handler: async (caller, args) => {
      const [account, metrics] = await Promise.all([
        api(caller, `social/accounts/${args.account_id}`),
        api(caller, "social/metrics", {
          query: { account_id: args.account_id, days: String(args.days ?? 28) },
        }),
      ]);
      return JSON.stringify(
        {
          account: {
            id: account.account?.id,
            name: account.account?.name,
            platform: account.account?.platform,
          },
          metrics: account.account?.metrics,
          series: (metrics.metrics ?? []).map((m: any) => ({
            date: m.metric_date,
            followers: m.followers,
            reach: m.reach,
            impressions: m.impressions,
          })),
        },
        null,
        2
      );
    },
  },
  {
    name: "get_top_posts",
    title: "Top published posts",
    description: "Published posts with their reach and engagement metrics.",
    write: false,
    schema: z.object({
      account_id: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    handler: async (caller, args) => {
      const query: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.account_id) query.account_id = args.account_id;
      const body = await api(caller, "social/posts", { query });
      return JSON.stringify({ posts: body.posts ?? [] }, null, 2);
    },
  },
  {
    name: "list_comments",
    title: "List comments",
    description:
      "Comments and mentions awaiting a reply, with their status (new, replied, hidden, ignored).",
    write: false,
    schema: z.object({
      account_id: z.string().optional(),
      status: z.string().optional().describe("new | replied | hidden | ignored"),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    handler: async (caller, args) => {
      const query: Record<string, string> = { limit: String(args.limit ?? 30) };
      if (args.account_id) query.account_id = args.account_id;
      if (args.status) query.status = args.status;
      const body = await api(caller, "social/comments", { query });
      return JSON.stringify(
        {
          comments: (body.comments ?? []).map((c: any) => ({
            id: c.id,
            author: c.author_name ?? c.author_handle,
            text: c.text,
            status: c.status,
            posted_at: iso(c.posted_at),
          })),
        },
        null,
        2
      );
    },
  },
  {
    name: "get_ads_overview",
    title: "Ads overview",
    description:
      "Meta ads spend, ROAS, campaign count and pending approvals for the workspace.",
    write: false,
    schema: z.object({}).passthrough(),
    handler: async (caller) => {
      const body = await api(caller, "ads/overview");
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "get_ad_campaign_details",
    title: "Ad campaign details",
    description: "One ad campaign with pacing, spend, ROAS and current state.",
    write: false,
    schema: z.object({
      campaign_id: z.string().describe("The ad campaign id"),
    }),
    handler: async (caller, args) => {
      const body = await api(caller, "ads/campaigns");
      const row = (body.campaigns ?? []).find(
        (c: any) => c.id === args.campaign_id
      );
      if (!row) {
        throw new ApiError(`No ad campaign with id ${args.campaign_id}`, 404);
      }
      return JSON.stringify(row, null, 2);
    },
  },
  {
    name: "list_plans",
    title: "List content plans",
    description:
      "Content plans (the basis of every asset) with their status and grounding.",
    write: false,
    schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    handler: async (caller, args) => {
      const body = await api(caller, "content/plans", {
        query: { limit: String(args.limit ?? 20) },
      });
      return JSON.stringify(
        {
          plans: (body.plans ?? []).map((p: any) => ({
            id: p.id,
            name: p.name,
            objective: p.objective,
            status: p.status,
            platforms: p.platforms,
            project_id: p.project_id ?? null,
            // False means generated copy has no brand profile to stay inside of.
            brand_grounded: p.brand_grounded ?? false,
            context_summary: p.context_summary,
            grounded_sources: p.grounded_sources,
          })),
        },
        null,
        2
      );
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    description:
      "Projects (a product or client) that scope chats, brand profiles and content. Includes the brand brief agents are briefed from.",
    write: false,
    schema: z.object({}).passthrough(),
    handler: async (caller) => {
      const body = await api(caller, "projects");
      const projects = (body.projects ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
        website: p.website,
        status: p.status,
        channels: (p.channels ?? []).map((c: any) => ({
          id: c.id,
          platform: c.platform,
          name: c.name,
        })),
        brand: p.brand
          ? {
              what_it_is: p.brand.what_it_is,
              icp: p.brand.icp,
              tone: p.brand.tone,
              region: p.brand.region,
              banned_claims: p.brand.banned_claims,
            }
          : null,
      }));
      return JSON.stringify({ projects }, null, 2);
    },
  },
  {
    name: "create_project",
    title: "Create a brand project",
    description:
      "Create a project (a product or client) and optionally link its social accounts and brand brief. Content plans written for this project are grounded in these facts; it does not create or publish content.",
    write: true,
    schema: z.object({
      name: z.string().min(1).max(160),
      website: z.string().url().optional(),
      channel_ids: z.array(z.string()).max(15).optional(),
      brand: z
        .object({
          what_it_is: z.string().max(400).optional(),
          offer: z.string().max(300).optional(),
          icp: z.string().max(400).optional(),
          tone: z.string().max(240).optional(),
          region: z.string().max(80).optional(),
          price_point: z.string().max(120).optional(),
          proof: z.array(z.string().max(280)).max(8).optional(),
          banned_claims: z.array(z.string().max(280)).max(8).optional(),
          languages: z.array(z.string().max(280)).max(6).optional(),
        })
        .passthrough()
        .optional(),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot create projects", 403);
      }
      const body: Record<string, unknown> = { name: args.name };
      if (args.website) body.website = args.website;
      if (args.channel_ids) body.channel_ids = args.channel_ids;
      if (args.brand) body.brand = args.brand;
      const created = await api(caller, "projects", { method: "POST", body });
      return JSON.stringify(
        {
          ...created,
          next: "Create a content plan with this project_id, then execute it through the content swarm.",
        },
        null,
        2
      );
    },
  },
  {
    name: "get_plan_and_usage",
    title: "Plan, limits and usage",
    description:
      "The workspace plan, every limit it sets and what has been used this window (requests/min, posts and AI credits per month, brands, profiles, seats). Read this before telling a user they cannot do something — a 429 names the metric it refused; this names the reset time and the plan that would allow it.",
    write: false,
    schema: z.object({}).passthrough(),
    handler: async (caller) => {
      const body = await api(caller, "billing");
      return JSON.stringify(
        {
          plan: body.plan?.id,
          name: body.plan?.name,
          status: body.subscription?.status,
          paid: body.is_paid,
          renews_at: body.subscription?.current_period_end ?? null,
          cancels_at_period_end: body.subscription?.cancel_at_period_end ?? false,
          limits: body.limits,
          usage: body.usage,
          upgrade_to: body.upgrade
            ? { plan: body.upgrade.plan, price_usd: body.upgrade.monthly_usd }
            : null,
        },
        null,
        2
      );
    },
  },
  {
    name: "get_performance_digest",
    title: "What has worked",
    description:
      "Measured post performance with sample sizes: findings, top posts, plan deltas and the prompt block content generation uses. Read this before proposing new content so the advice is grounded in this workspace's numbers.",
    write: false,
    schema: z.object({
      days: z.number().int().min(1).max(365).default(30),
      plan_id: z.string().optional().describe("Restrict to one plan"),
    }),
    handler: async (caller, args) => {
      const query: Record<string, string> = { days: String(args.days ?? 30) };
      if (args.plan_id) query.plan_id = args.plan_id;
      const body = await api(caller, "insights/digest", { query });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "get_post_performance",
    title: "Post engagement curve",
    description:
      "Every metric capture for one published post (1h/24h/72h/7d/30d), attributed to its plan and content item. Platforms without a measurable API return status 'unsupported' rather than a zero.",
    write: false,
    schema: z.object({
      queue_id: z.string().describe("The publish queue row id"),
    }),
    handler: async (caller, args) => {
      const body = await api(caller, `insights/posts/${args.queue_id}`);
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "list_schedules",
    title: "List autopilot schedules",
    description:
      "Recurring schedules that post a plan's content: cadence, timezone, approval mode, next run and how many runs so far.",
    write: false,
    schema: z.object({}).passthrough(),
    handler: async (caller) => {
      const body = await api(caller, "schedules");
      return JSON.stringify(
        {
          schedules: (body.schedules ?? []).map((s: any) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            plan_id: s.plan_id,
            cadence: s.cadence,
            times: s.times,
            timezone: s.timezone,
            approval_mode: s.approval_mode,
            next_run_at: s.next_run_at,
            runs: s.runs_count,
            coverage: s.coverage,
          })),
        },
        null,
        2
      );
    },
  },
  {
    name: "list_publish_queue",
    title: "List the publish queue",
    description:
      "Scheduled and published posts with approval state, account, time and content item. Read this before scheduling so a new item does not collide with an existing queue row.",
    write: false,
    schema: z.object({
      status: z.string().optional(),
      account_id: z.string().optional(),
      plan_id: z.string().optional(),
      platform: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    handler: async (caller, args) => {
      const query: Record<string, string> = { limit: String(args.limit ?? 50) };
      for (const key of ["status", "account_id", "plan_id", "platform"] as const) {
        if (args[key]) query[key] = String(args[key]);
      }
      const body = await api(caller, "publish/queue", { query });
      const items = (body.items ?? []).map((row: any) => ({
        id: row.id,
        status: row.status,
        platform: row.platform,
        scheduled_for: row.scheduled_for,
        published_at: row.published_at,
        external_post_id: row.external_post_id,
        permalink: row.permalink,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        content_item_id: row.content_item_id,
        plan_id: row.plan_id,
        social_account_id: row.social_account_id,
        caption: row.caption,
        // Provider/Graph details stay in the internal audit trail. MCP callers
        // get the queue state and a safe attention flag, not raw Meta errors.
        needs_attention: row.status === "needs_attention" || row.status === "failed",
        approval: row.approval,
      }));
      return JSON.stringify(
        { items, counts: body.counts ?? {}, total: body.total ?? items.length },
        null,
        2
      );
    },
  },
  {
    name: "get_content_assets",
    title: "Content assets",
    description:
      "Assets the swarm produced (image, video, copy, email) with their plan, status and prompt.",
    write: false,
    schema: z.object({
      plan_id: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    handler: async (caller, args) => {
      const query: Record<string, string> = { limit: String(args.limit ?? 30) };
      if (args.plan_id) query.plan_id = args.plan_id;
      const body = await api(caller, "content/items", { query });
      return JSON.stringify(
        {
          assets: (body.items ?? []).map((i: any) => ({
            id: i.id,
            type: i.type,
            status: i.status,
            plan_id: i.plan_id,
            account_id: i.social_account_id,
            caption: i.caption,
            prompt: i.prompt_used ?? i.prompt,
            storyboard: i.storyboard,
          })),
        },
        null,
        2
      );
    },
  },
  {
    name: "get_data_catalogue",
    title: "Data catalogue",
    description:
      "The datasets this workspace can ground a plan in — sources, row counts, and the facts the agents are briefed with.",
    write: false,
    schema: z.object({}).passthrough(),
    handler: async (caller) => {
      const body = await api(caller, "data/catalogue/summary");
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "get_swarm_activity",
    title: "Swarm activity",
    description: "What the agents have been doing — the inter-agent transcript.",
    write: false,
    schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    handler: async (caller, args) => {
      const body = await api(caller, "swarm/activity", {
        query: { limit: String(args.limit ?? 20) },
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "list_planner_campaigns",
    title: "List strategy campaigns",
    description:
      "The 12-stage Campaign Studio strategy runs in this workspace, with status and current stage. Read this before creating content so the plan is linked to a real strategy.",
    write: false,
    schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    handler: async (caller, args) => {
      const body = await api(caller, "campaigns");
      const rows = (Array.isArray(body) ? body : []).slice(0, args.limit ?? 20).map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        current_stage: c.current_stage,
        mode: c.mode,
        created_at: c.created_at,
        completed_at: c.completed_at,
      }));
      return JSON.stringify({ campaigns: rows }, null, 2);
    },
  },
  {
    name: "get_planner_campaign",
    title: "Get a strategy campaign",
    description:
      "One 12-stage plan with stage statuses and a quality summary. Use get_planner_stage for a stage artifact and get_planner_quality for the gate verdict.",
    write: false,
    schema: z.object({ campaign_id: z.string().min(1) }),
    handler: async (caller, args) => {
      const c = await api(caller, `campaigns/${args.campaign_id}`);
      const stages: Record<string, any> = {};
      for (const [name, stage] of Object.entries(c.stages ?? {})) {
        const s = stage as any;
        stages[name] = {
          status: s.status,
          error: s.error,
          started_at: s.started_at,
          completed_at: s.completed_at,
        };
      }
      return JSON.stringify(
        {
          id: c.id,
          name: c.name,
          description: c.description,
          mode: c.mode,
          status: c.status,
          current_stage: c.current_stage,
          intake_data: c.intake_data,
          created_at: c.created_at,
          started_at: c.started_at,
          completed_at: c.completed_at,
          stages,
          quality: c.stages?.quality_gate?.result ?? null,
        },
        null,
        2
      );
    },
  },
  {
    name: "get_planner_stage",
    title: "Get a stage artifact",
    description:
      "The full result of one stage: segmentation, personas, brief, journey, outlook, creative, quality_gate, simulation or monitoring. This is how an agent reads the planner's actual output.",
    write: false,
    schema: z.object({
      campaign_id: z.string().min(1),
      stage: z.enum([
        "intake", "segmentation", "data_profile", "personas", "brief", "schema",
        "journey", "outlook", "creative", "quality_gate", "simulation", "monitoring",
      ]),
    }),
    handler: async (caller, args) => {
      const c = await api(caller, `campaigns/${args.campaign_id}`);
      const stage = c.stages?.[args.stage];
      if (!stage) throw new ApiError(`Stage ${args.stage} was not found on this campaign`, 404);
      return JSON.stringify({ campaign_id: args.campaign_id, stage: args.stage, ...stage }, null, 2);
    },
  },
  {
    name: "get_planner_quality",
    title: "Get the quality gate",
    description:
      "The blocking quality gate for a strategy campaign: passed, score, launch recommendation and violations. A campaign is not launch-ready unless passed is true; this tool never approves it.",
    write: false,
    schema: z.object({ campaign_id: z.string().min(1) }),
    handler: async (caller, args) => {
      const c = await api(caller, `campaigns/${args.campaign_id}`);
      const gate = c.stages?.quality_gate ?? null;
      const result = gate?.result ?? {};
      return JSON.stringify(
        {
          campaign_id: c.id,
          campaign_status: c.status,
          gate_status: gate?.status ?? "pending",
          passed: Boolean(result.passed),
          overall_quality_score: result.overall_quality_score ?? null,
          launch_recommendation: result.launch_recommendation ?? null,
          violations: result.violations ?? [],
          checks_performed: result.checks_performed ?? [],
          can_launch: c.status === "completed" && Boolean(result.passed),
        },
        null,
        2
      );
    },
  },
  {
    name: "create_planner_campaign",
    title: "Create a strategy campaign",
    description:
      "Create a 12-stage Campaign Studio plan from a brief. It does not start or spend tokens until start_planner_campaign is called. Human approval and publishing remain outside MCP.",
    write: true,
    schema: z.object({
      name: z.string().min(1).max(255),
      description: z.string().max(2000).optional(),
      mode: z.enum(["auto", "manual"]).default("auto"),
      intake_data: z
        .object({
          // The gate can only reject a persona in an unsupported language if
          // the brief names the supported set. Requiring it here keeps the
          // language check from being inert on an MCP-created run.
          languages: z.array(z.string().min(1)).min(1),
        })
        .passthrough()
        .describe(
          "The campaign brief. languages is required: objective, target_audience, channels, budget, monthly_budget, product_url, region, languages, product_facts, constraints, conversion."
        ),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) throw new ApiError("This key cannot create campaigns", 403);
      const body = await api(caller, "campaigns", {
        method: "POST",
        body: {
          name: args.name,
          description: args.description,
          mode: args.mode ?? "auto",
          autostart: false,
          intake_data: args.intake_data ?? {},
        },
      });
      return JSON.stringify(
        {
          ...body,
          next: "Call start_planner_campaign with this id. Nothing has run yet.",
        },
        null,
        2
      );
    },
  },
  {
    name: "start_planner_campaign",
    title: "Start a strategy campaign",
    description:
      "Start the 12 stages for an existing draft. This spends model tokens. It does not approve a stage, bypass the quality gate, or publish anything.",
    write: true,
    schema: z.object({ campaign_id: z.string().min(1) }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) throw new ApiError("This key cannot run campaigns", 403);
      const body = await api(caller, `campaigns/${args.campaign_id}/start`, { method: "POST" });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "retry_planner_stage",
    title: "Retry a failed stage",
    description:
      "Retry a stage that failed, including a quality_gate that blocked the campaign. Only failed stages can be retried; this cannot set a status or force a pass.",
    write: true,
    schema: z.object({
      campaign_id: z.string().min(1),
      stage: z.enum([
        "intake", "segmentation", "data_profile", "personas", "brief", "schema",
        "journey", "outlook", "creative", "quality_gate", "simulation", "monitoring",
      ]),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) throw new ApiError("This key cannot retry stages", 403);
      const body = await api(caller, `campaigns/${args.campaign_id}/stages/${args.stage}/retry`, {
        method: "POST",
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "reply_to_comment",
    title: "Reply to a comment",
    description:
      "Post a reply to a comment on one of your posts. Creates the reply on the platform and records it in the inbox.",
    write: true,
    schema: z.object({
      comment_id: z.string().describe("The comment id"),
      text: z.string().min(1).max(2000).describe("The reply text"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError(
          "This key cannot write — use an editor key to reply to comments",
          403
        );
      }
      const body = await api(caller, `social/comments/${args.comment_id}/reply`, {
        method: "POST",
        body: { text: args.text },
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "create_post_draft",
    title: "Create a content plan",
    description:
      "Create a content plan so the swarm can produce assets for it. Nothing is published by this tool.",
    write: true,
    schema: z.object({
      name: z.string().min(1).max(120),
      objective: z.string().min(1).max(2000),
      target_audience: z.string().optional(),
      platforms: z
        .array(z.enum(["instagram", "facebook", "threads", "linkedin", "reddit"]))
        .optional(),
      // The strategy run this content plan belongs to. Required: scheduling
      // through MCP is refused for unlinked plans, which would bypass the gate.
      strategy_campaign_id: z.string().min(1).describe("The 12-stage planner campaign this content comes from"),
      // The brand the copy is written for. Defaults to the workspace's only
      // project when there is one; without it, generation has no brand facts.
      project_id: z.string().optional(),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot create plans", 403);
      }
      const body = await api(caller, "content/plans", {
        method: "POST",
        body: {
          name: args.name,
          objective: args.objective,
          target_audience: args.target_audience,
          platforms: args.platforms,
          strategy_campaign_id: args.strategy_campaign_id,
          project_id: args.project_id,
        },
      });
      return JSON.stringify(
        { ...body, next: "Run the swarm from the planner to produce the assets." },
        null,
        2
      );
    },
  },
  {
    name: "execute_content_plan",
    title: "Run the content swarm",
    description:
      "Execute a linked content plan through the real content swarm: planner brief, copy, image, video storyboard, email and compliance review. This spends AI credits and creates draft/approved assets; it does not publish anything.",
    write: true,
    schema: z.object({
      plan_id: z.string().min(1).describe("The content plan to execute"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot execute plans", 403);
      }
      const body = await api(caller, `content/plans/${args.plan_id}/execute`, {
        method: "POST",
      });
      return JSON.stringify(
        {
          ok: body.ok,
          plan_id: body.plan_id,
          status: body.status,
          brand: body.brand,
          items: (body.items ?? []).map((item: any) => ({
            id: item.id,
            type: item.type,
            status: item.status,
            platform: item.platform,
            social_account_id: item.social_account_id,
            caption: item.caption,
            result_url: item.result_url,
            error: item.error,
          })),
          messages: body.messages ?? [],
          brief: body.brief,
          next: "Approve the chosen asset, then schedule it with schedule_post_from_draft.",
        },
        null,
        2
      );
    },
  },
  {
    name: "update_plan_brief",
    title: "Update a plan brief",
    description:
      "Rewrite the brief a plan's agents work from: objective, audience, platforms, and the dense context pack (summary/position/claims). This changes what the planner would produce next; it does not regenerate assets on its own.",
    write: true,
    schema: z.object({
      plan_id: z.string(),
      name: z.string().min(1).max(120).optional(),
      objective: z.string().min(1).max(2000).optional(),
      target_audience: z.string().max(2000).optional(),
      platforms: z
        .array(z.enum(["instagram", "facebook", "threads", "linkedin", "reddit"]))
        .optional(),
      context_summary: z
        .string()
        .max(4000)
        .optional()
        .describe("The position in dense prose — what every asset is briefed from"),
      context_position: z.string().max(4000).optional(),
      claims: z
        .array(z.string().max(300))
        .optional()
        .describe("3–5 factual statements the assets may make"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot edit plans", 403);
      }
      const body: Record<string, unknown> = {};
      for (const key of [
        "name",
        "objective",
        "target_audience",
        "platforms",
        "context_summary",
        "context_position",
      ]) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      if (args.claims !== undefined) body.context_claims = args.claims;
      if (Object.keys(body).length === 0) {
        throw new ApiError("Nothing to update — pass at least one field", 400);
      }
      const updated = await api(caller, `content/plans/${args.plan_id}`, {
        method: "PATCH",
        body,
      });
      return JSON.stringify(updated, null, 2);
    },
  },
  {
    name: "create_content_item",
    title: "Write an asset onto a plan",
    description:
      "Create a copy/image/email asset with the text you supply, attached to an existing plan. This is the override path: the planner does not write the copy, but the asset still inherits the plan's brief. Nothing is published.",
    write: true,
    schema: z.object({
      plan_id: z.string(),
      caption: z.string().min(1).max(63206).describe("The post text itself"),
      type: z
        .enum(["copy", "image", "video", "email", "carousel"])
        .default("copy"),
      hashtags: z.array(z.string().max(80)).max(30).optional(),
      social_account_id: z.string().optional(),
      status: z.enum(["draft", "approved"]).default("draft"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot create assets", 403);
      }
      const body = await api(caller, "content/items", {
        method: "POST",
        body: {
          plan_id: args.plan_id,
          caption: args.caption,
          type: args.type ?? "copy",
          hashtags: args.hashtags,
          social_account_id: args.social_account_id,
          status: args.status ?? "draft",
        },
      });
      return JSON.stringify(
        {
          ...body,
          next: "Schedule it with schedule_post_from_draft. It is not published yet.",
        },
        null,
        2
      );
    },
  },
  {
    name: "update_content_asset",
    title: "Edit an asset",
    description:
      "Change an existing asset's caption, hashtags or review status (draft/approved/rejected). Use this to correct generated copy instead of regenerating it.",
    write: true,
    schema: z.object({
      item_id: z.string(),
      caption: z.string().max(63206).optional(),
      hashtags: z.array(z.string().max(80)).max(30).optional(),
      status: z
        .enum(["draft", "approved", "rejected"])
        .optional()
        .describe("Human review decision for this asset"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot edit assets", 403);
      }
      const body: Record<string, unknown> = {};
      for (const key of ["caption", "hashtags", "status"] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      if (Object.keys(body).length === 0) {
        throw new ApiError("Nothing to update — pass caption, hashtags or status", 400);
      }
      const updated = await api(caller, `content/items/${args.item_id}`, {
        method: "PATCH",
        body,
      });
      return JSON.stringify(updated, null, 2);
    },
  },
  {
    name: "schedule_post_from_draft",
    title: "Schedule a draft",
    description:
      "Put an approved asset in the publish queue for a given account and time. Creates a queue item a human can still cancel.",
    write: true,
    schema: z.object({
      content_item_id: z.string(),
      social_account_id: z.string(),
      scheduled_for: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp; omit to publish on the next pass"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot schedule posts", 403);
      }
      const body = await api(caller, "publish/queue", {
        method: "POST",
        body: {
          content_item_id: args.content_item_id,
          social_account_id: args.social_account_id,
          ...(args.scheduled_for ? { scheduled_for: args.scheduled_for } : {}),
        },
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "compose_post",
    title: "Compose a post directly",
    description:
      "Create a post without a plan or campaign: caption and/or already-uploaded media, one channel, now or at a time. Submitting puts it in the approval queue — nothing publishes without a human decision. Use list_post_drafts to find drafts and their queue state.",
    write: true,
    schema: z.object({
      social_account_id: z
        .string()
        .min(1)
        .describe("The channel to post from (see list_social_accounts)"),
      caption: z.string().max(10000).optional().describe("The post text"),
      media_asset_id: z
        .string()
        .optional()
        .describe(
          "An image/video already uploaded to this workspace (see get_content_assets). Media is optional."
        ),
      project_id: z.string().optional().describe("Brand to scope the post to"),
      scheduled_for: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp; omit to publish as soon as it is approved"),
      publish_now: z
        .boolean()
        .optional()
        .describe("Ignored when scheduled_for is set. Approval still applies."),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot compose posts", 403);
      }
      if (!args.caption?.trim() && !args.media_asset_id) {
        throw new ApiError("Give the post a caption or a media_asset_id", 400);
      }
      const draft = await api(caller, "post-drafts", {
        method: "POST",
        body: {
          caption: args.caption,
          social_account_id: args.social_account_id,
          project_id: args.project_id,
          source: "mcp",
        },
      });
      if (args.media_asset_id) {
        await api(caller, `post-drafts/${draft.id}`, {
          method: "PATCH",
          body: { media_asset_id: args.media_asset_id },
        });
      }
      const submitted = await api(caller, `post-drafts/${draft.id}/submit`, {
        method: "POST",
        body: args.scheduled_for && !args.publish_now
          ? { scheduled_for: args.scheduled_for }
          : {},
      });
      return JSON.stringify(
        {
          draft_id: draft.id,
          queue_id: submitted.queue?.id ?? null,
          approval_id: submitted.approval_id ?? null,
          status: submitted.status,
          next: submitted.approval_id
            ? "A human must approve it in the dashboard before it publishes."
            : "The publisher will pick it up on its next pass.",
        },
        null,
        2
      );
    },
  },
  {
    name: "list_post_drafts",
    title: "List composed posts",
    description:
      "Manual posts made from the composer, with their queue and approval state. These are not plan assets.",
    write: false,
    schema: z.object({
      status: z
        .enum(["draft", "ready", "queued", "published", "failed"])
        .optional()
        .describe("Filter by draft state"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    handler: async (caller, args) => {
      const query: Record<string, string> = {};
      if (args.status) query.status = args.status;
      query.limit = String(args.limit ?? 20);
      const body = await api(caller, "post-drafts", { query });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "get_post_draft",
    title: "Read one composed post",
    description:
      "One composer draft with its media, queue row and approval state. Use it before editing so the change is made against the record that exists.",
    write: false,
    schema: z.object({ draft_id: z.string().min(1) }),
    handler: async (caller, args) => {
      const body = await api(caller, `post-drafts/${args.draft_id}`);
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "update_post_draft",
    title: "Edit a composed post",
    description:
      "Change a draft's words, channel, brand, media or Reddit fields. A queued draft is locked — its queue row already holds the copy an approver is reading — so cancel that row first. Editing never publishes.",
    write: true,
    schema: z.object({
      draft_id: z.string().min(1),
      caption: z.string().max(10000).optional(),
      social_account_id: z
        .string()
        .optional()
        .describe("Move the draft to another channel (see list_social_accounts)"),
      project_id: z
        .string()
        .nullable()
        .optional()
        .describe("Brand to scope it to; null clears it"),
      media_asset_id: z
        .string()
        .nullable()
        .optional()
        .describe("Attach an uploaded asset, or null to remove the media"),
      title: z.string().max(300).optional().describe("Reddit only"),
      subreddit: z.string().max(100).optional().describe("Reddit only"),
      visibility: z.string().max(20).optional(),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot edit drafts", 403);
      }
      const { draft_id, ...fields } = args;
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined)
      );
      if (!Object.keys(body).length) {
        throw new ApiError("Give at least one field to change", 400);
      }
      const updated = await api(caller, `post-drafts/${draft_id}`, {
        method: "PATCH",
        body,
      });
      return JSON.stringify(updated, null, 2);
    },
  },
  {
    name: "delete_post_draft",
    title: "Delete a composed post",
    description:
      "Remove a draft that has not been queued. A queued or published one has to be cancelled or retracted in the dashboard first, so a live post is never deleted from here.",
    write: true,
    schema: z.object({ draft_id: z.string().min(1) }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot delete drafts", 403);
      }
      const body = await api(caller, `post-drafts/${args.draft_id}`, {
        method: "DELETE",
      });
      return JSON.stringify(body ?? { ok: true, draft_id: args.draft_id }, null, 2);
    },
  },
  {
    name: "submit_post_draft",
    title: "Send a draft for approval",
    description:
      "Queue an existing draft exactly as it stands, now or at a time. It always lands in the human approval inbox — approving it is a dashboard decision and is deliberately not exposed here.",
    write: true,
    schema: z.object({
      draft_id: z.string().min(1),
      scheduled_for: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp; omit to publish as soon as it is approved"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot submit drafts", 403);
      }
      const body = await api(caller, `post-drafts/${args.draft_id}/submit`, {
        method: "POST",
        body: args.scheduled_for ? { scheduled_for: args.scheduled_for } : {},
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "manage_publish_queue",
    title: "Cancel, reschedule or retry a queued post",
    description:
      "Change a queued post without deciding its approval: cancel it, move its time, or retry one that failed. Rescheduling a pending post leaves it pending, so it never skips the human decision, and a live post has to be retracted in the dashboard — retract is deliberately not a tool.",
    write: true,
    schema: z.object({
      queue_id: z
        .string()
        .min(1)
        .describe("The queue row (see list_publish_queue)"),
      action: z.enum(["cancel", "reschedule", "retry"]),
      scheduled_for: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp; required for reschedule"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot change the queue", 403);
      }
      if (args.action === "reschedule" && !args.scheduled_for) {
        throw new ApiError("scheduled_for is required to reschedule", 400);
      }
      const body: Record<string, unknown> = { action: args.action };
      if (args.scheduled_for) body.scheduled_for = args.scheduled_for;
      const result = await api(caller, `publish/queue/${args.queue_id}`, {
        method: "PATCH",
        body,
      });
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "run_publish_queue",
    title: "Publish due posts now",
    description:
      "Run one publisher pass immediately instead of waiting for the timer. It publishes anything already approved and due; it never approves a pending post.",
    write: true,
    schema: z.object({}),
    handler: async (caller) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot run the publisher", 403);
      }
      return JSON.stringify(
        await api(caller, "publish/run", { method: "POST" }),
        null,
        2
      );
    },
  },
  {
    name: "get_publish_attempts",
    title: "Attempt history for a queued post",
    description:
      "Every publish attempt for one queue row with its time and result — read this to explain a failure before retrying.",
    write: false,
    schema: z.object({
      queue_id: z.string().min(1).describe("The publish queue row id"),
    }),
    handler: async (caller, args) => {
      const body = await api(caller, `publish/attempts/${args.queue_id}`);
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "edit_published_post",
    title: "Edit a live post's caption",
    description:
      "Replace the words on a post that is already live, where the platform allows it (Facebook today). This is an edit, not a republish: external id, permalink and publication time stand. A channel that cannot edit answers with the reason and the retract-and-repost path.",
    write: true,
    schema: z.object({
      queue_id: z
        .string()
        .min(1)
        .describe("The published queue row (see list_publish_queue)"),
      caption: z.string().min(1).max(10000),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot edit published posts", 403);
      }
      const body = await api(caller, `publish/queue/${args.queue_id}/edit`, {
        method: "POST",
        body: { caption: args.caption },
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "check_post_delivery",
    title: "Check published posts are still live",
    description:
      "Ask each platform whether this workspace's published posts still exist. A post is called removed only when the platform is conclusive (404 or Graph 803) or when its own publication window was fully enumerated without it; anything less is reported as unreadable, never as deleted.",
    write: true,
    schema: z.object({}),
    handler: async (caller) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot run a delivery check", 403);
      }
      const body = await api(caller, "publish/reconcile", { method: "POST" });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "get_channel_capabilities",
    title: "What each channel can do",
    description:
      "Per-channel capabilities, scopes and what still needs a platform review — the same catalogue the Channel Capabilities page shows.",
    write: false,
    schema: z.object({}),
    handler: async (caller) => {
      const body = await api(caller, "social/channels/capabilities");
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "get_publish_settings",
    title: "Publishing limits per channel",
    description:
      "Caption budgets, accepted post kinds and the reason when a channel is limited. Read it before composing so a post is not refused after the fact.",
    write: false,
    schema: z.object({}),
    handler: async (caller) => {
      const body = await api(caller, "publish/settings");
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "get_llm_status",
    title: "Which model is answering",
    description:
      "The configured text provider, model and gateway host — never the key. Owners and admins only.",
    write: false,
    schema: z.object({}),
    handler: async (caller) => {
      const body = await api(caller, "llm/status");
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "test_llm_provider",
    title: "Test the model provider",
    description:
      "Make one tiny completion against the configured gateway to prove it answers. Owners only; the probe bypasses workspace metering and never returns the key.",
    write: true,
    schema: z.object({}),
    handler: async (caller) => {
      if (caller.role !== "owner") {
        throw new ApiError(
          "Only the workspace owner can test the model provider",
          403
        );
      }
      return JSON.stringify(
        await api(caller, "llm/test", { method: "POST" }),
        null,
        2
      );
    },
  },
  {
    name: "update_ad_budget",
    title: "Propose an ad budget change",
    description:
      "Propose a budget change (max ±30% per call, reason required). It becomes an approval item — it never changes the budget silently.",
    write: true,
    schema: z.object({
      campaign_id: z.string(),
      daily_budget: z.number().positive(),
      reason: z.string().min(1).max(500),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot change ads", 403);
      }
      const body = await api(caller, `ads/campaigns/${args.campaign_id}/budget`, {
        method: "POST",
        body: { daily_budget: args.daily_budget, reason: args.reason },
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "pause_ad_campaign",
    title: "Pause an ad campaign",
    description:
      "Propose pausing an ad campaign. The change is queued for approval, not applied silently.",
    write: true,
    schema: z.object({
      campaign_id: z.string(),
      reason: z.string().min(1).max(500),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot change ads", 403);
      }
      const body = await api(caller, `ads/campaigns/${args.campaign_id}/pause`, {
        method: "POST",
        body: { reason: args.reason },
      });
      return JSON.stringify(body, null, 2);
    },
  },
  {
    name: "apply_performance_learnings",
    title: "Apply what works to a plan",
    description:
      "Write the workspace's current measured findings (engagement rate, CTR, format, slot, hook) into a plan's brief, so every asset that plan produces next is briefed from evidence. Refuses below the minimum sample instead of inventing a pattern. This changes the brief; it does not regenerate existing assets.",
    write: true,
    schema: z.object({
      plan_id: z.string().describe("The plan whose future content should learn from results"),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe("Measurement window in days"),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot edit plans", 403);
      }
      const body = await api(caller, "insights/apply", {
        method: "POST",
        body: { plan_id: args.plan_id, days: args.days ?? 30 },
      });
      return JSON.stringify(
        {
          ...body,
          next: "The next generation run for this plan will cite these findings. Existing assets are unchanged.",
        },
        null,
        2
      );
    },
  },
  {
    name: "update_schedule",
    title: "Edit, pause or resume a schedule",
    description:
      "Change an autopilot schedule: cadence, times, days, timezone, approval mode, run cap, stop rule, or status (active/paused/finished). Editing re-arms the next slot; pausing stops future slots without touching posts already queued.",
    write: true,
    schema: z.object({
      schedule_id: z.string(),
      name: z.string().min(1).max(160).optional(),
      cadence: z.enum(["daily", "weekdays", "weekly", "custom"]).optional(),
      times: z
        .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
        .min(1)
        .max(6)
        .optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).optional(),
      timezone: z.string().optional().describe("IANA zone, e.g. Australia/Melbourne"),
      approval_mode: z.enum(["review", "auto"]).optional(),
      max_runs: z.number().int().positive().nullable().optional(),
      stop_rule: z
        .object({
          below: z.number().min(0).max(1),
          after_posts: z.number().int().min(1).optional(),
          min_posts: z.number().int().min(3).optional(),
        })
        .nullable()
        .optional(),
      status: z.enum(["active", "paused", "finished"]).optional(),
      paused_reason: z.string().max(500).optional(),
    }),
    handler: async (caller, args) => {
      if (!canWrite(caller.role)) {
        throw new ApiError("This key cannot manage schedules", 403);
      }
      const body: Record<string, unknown> = {};
      for (const key of [
        "name",
        "cadence",
        "times",
        "weekdays",
        "timezone",
        "approval_mode",
        "max_runs",
        "stop_rule",
        "status",
        "paused_reason",
      ] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      if (Object.keys(body).length === 0) {
        throw new ApiError("Nothing to update — pass at least one field", 400);
      }
      const updated = await api(caller, `schedules/${args.schedule_id}`, {
        method: "PATCH",
        body,
      });
      return JSON.stringify(updated, null, 2);
    },
  },
];

// ── server ─────────────────────────────────────────────────────────────────

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "campaign-swarm", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema as any,
        // Let the client tell a read from a change before it calls anything:
        // hosts use this for auto-approval policies and UI badges.
        annotations: tool.write
          ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
          : { readOnlyHint: true, idempotentHint: true },
      },
      async (args: any, extra: any) => {
        const headersIn = (extra?.requestInfo?.headers ?? {}) as Record<string, string>;
        const raw = String(
          headersIn.authorization ?? headersIn.Authorization ?? ""
        )
          .replace(/^Bearer\s+/i, "")
          .trim();
        try {
          const caller = await authenticate(raw);
          const text = await tool.handler(caller, args ?? {});
          return { content: [{ type: "text" as const, text }] };
        } catch (err: any) {
          const message = err?.message ?? "The tool call failed";
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
          };
        }
      }
    );
  }

  return server;
}

/** The key out of an `Authorization: Bearer …` header, or "". */
export function bearerFrom(headers: Record<string, unknown>): string {
  const raw = String(headers.authorization ?? headers.Authorization ?? "");
  return raw.replace(/^Bearer\s+/i, "").trim();
}

/** Cheap shape check before a key is worth a round trip to the API. */
export function keyShaped(key: string): boolean {
  return /^csw_[0-9a-f]{8,}$/.test(key);
}

async function main() {
  await refreshBranding();
  const app = express();
  // nginx terminates TLS and proxies from loopback. Trust only that hop so the
  // OAuth rate limiter sees the real client address without trusting arbitrary
  // X-Forwarded-For values from the internet.
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "2mb" }));

  // OAuth 2.1 for Claude/OpenAI sits in front of the same hosted endpoint. It
  // is enabled only when OAUTH_ENCRYPTION_KEY is configured; API-key clients
  // keep working either way.
  const oauth = installOAuth(app, authenticate);

  // Every MCP request must carry the org key, and it must be a real one.
  //
  // Without this gate an unauthenticated harness still gets a 200 and reads the
  // tool catalogue, and a mistyped key only shows up as `isError` text inside a
  // tool result — far from the config that caused it. A 401 at the door is what
  // every hosted MCP server does, and it is what makes Claude Code / Cursor /
  // VS Code say "unauthorized" instead of silently running with no data.
  app.use("/mcp", async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== "POST") return next();
    const reject = (status: number, message: string) => {
      let challenge = `Bearer realm="${BRAND.name}"`;
      if (oauth.enabled) {
        challenge += `, resource_metadata="${oauth.prmUrl}", scope="mcp:tools"`;
      }
      res.setHeader("WWW-Authenticate", challenge);
      res.status(status).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: null,
      });
    };
    const key = bearerFrom(req.headers as Record<string, unknown>);
    if (!key) {
      return reject(
        401,
        `This MCP server needs a ${BRAND.name} API key. Create one in Settings → API keys and send it as \`Authorization: Bearer csw_…\`, or authorize this client with OAuth.`
      );
    }

    // Existing API-key clients keep the direct path.
    if (key.startsWith("csw_")) {
      if (!keyShaped(key)) return reject(401, "That API key was not accepted");
      try {
        await authenticate(key);
      } catch (err) {
        if (err instanceof ApiError) return reject(err.status === 403 ? 403 : 401, err.message);
        // The API is unreachable: say so rather than pretending the key is bad.
        return reject(503, `${BRAND.name} could not be reached to verify that key`);
      }
      return next();
    }

    if (!oauth.enabled || !oauth.bearer) {
      return reject(401, "OAuth is not configured on this server yet.");
    }

    // OAuth access tokens are opaque and map to an encrypted API key in the
    // server-side authorization store. Validate that key again before use, then
    // hand the MCP transport the API key it already knows how to forward.
    return oauth.bearer(req, res, () => {
      void (async () => {
        let opened: { apiKey: string; orgId: string; role: string };
        try {
          opened = oauth.openUserId!((req as any).auth?.userId ?? "");
        } catch {
          return reject(401, "That authorization is no longer valid.");
        }
        try {
          await authenticate(opened.apiKey);
        } catch (err) {
          if (err instanceof ApiError) {
            return reject(err.status === 403 ? 403 : 401, err.message);
          }
          return reject(503, `${BRAND.name} could not be reached to verify that authorization`);
        }
        req.headers.authorization = `Bearer ${opened.apiKey}`;
        next();
      })();
    });
  });

  // Stateless streamable HTTP: a fresh server + transport per request, so the
  // server never depends on a session being reused.
  app.post("/mcp", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error("mcp request failed:", err?.stack ?? err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: String(err?.message ?? err) },
          id: null,
        });
      }
    } finally {
      // Close in the background: a failure here must not turn a served response
      // into a 500.
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  });

  // Express 5 turns a rejected handler into an empty 500 — log it properly.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("mcp handler error:", err?.stack ?? err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: String(err?.message ?? err) },
        id: null,
      });
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      error: "Use POST for MCP requests — this server is streamable HTTP.",
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      branding: {
        name: BRAND.name,
        support_email: BRAND.supportEmail,
        custom_domain: BRAND.domain,
        configured: BRAND.configured,
      },
      tools: TOOLS.length,
      read_tools: TOOLS.filter((t) => !t.write).length,
      write_tools: TOOLS.filter((t) => t.write).length,
      oauth: oauth.enabled
        ? {
            enabled: true,
            issuer: oauth.issuer,
            resource: oauth.resource.href,
            scopes: ["mcp:tools"],
          }
        : { enabled: false },
    });
  });

  // Bind to loopback by default: nginx terminates TLS in front, and org API
  // keys must never cross the network in clear text on a raw port.
  const HOST = process.env.MCP_HOST ?? "127.0.0.1";
  app.listen(PORT, HOST, () => {
    console.log(`${BRAND.name} MCP server listening on ${HOST}:${PORT}/mcp`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
