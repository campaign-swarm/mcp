import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS, bearerFrom, canWrite, keyShaped } from "./index.ts";

test("the tool surface is the documented one", () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "apply_performance_learnings",
    "check_post_delivery",
    "compose_post",
    "create_content_item",
    "create_planner_campaign",
    "create_post_draft",
    "create_project",
    "delete_post_draft",
    "edit_published_post",
    "execute_content_plan",
    "get_ad_campaign_details",
    "get_ads_overview",
    "get_channel_capabilities",
    "get_content_assets",
    "get_data_catalogue",
    "get_llm_status",
    "get_page_summary",
    "get_performance_digest",
    "get_plan_and_usage",
    "get_planner_campaign",
    "get_planner_quality",
    "get_planner_stage",
    "get_post_draft",
    "get_post_performance",
    "get_publish_attempts",
    "get_publish_settings",
    "get_swarm_activity",
    "get_top_posts",
    "list_comments",
    "list_planner_campaigns",
    "list_plans",
    "list_post_drafts",
    "list_projects",
    "list_publish_queue",
    "list_schedules",
    "list_social_accounts",
    "manage_publish_queue",
    "pause_ad_campaign",
    "reply_to_comment",
    "retry_planner_stage",
    "run_publish_queue",
    "schedule_post_from_draft",
    "start_planner_campaign",
    "submit_post_draft",
    "test_llm_provider",
    "update_ad_budget",
    "update_content_asset",
    "update_plan_brief",
    "update_post_draft",
    "update_schedule",
  ]);
});

test("no human approval or raw-update escape hatches are exposed", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const forbidden of [
    "campaign_update",
    "set_stage_status",
    "set_gate_approved",
    "run_sql",
    "http_fetch",
    "approve_stage",
    "approve_content",
    "approve_post",
    "reject_post",
    "retract_post",
    "publish_post",
    "set_approval_policy",
  ]) {
    assert.equal(names.has(forbidden), false, `${forbidden} must not be an MCP tool`);
  }
});

test("tool names are snake_case and unique", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^[a-z0-9_]+$/, `${name} should be snake_case`);
  }
});

test("planner creation requires the supported language list", () => {
  const planner = TOOLS.find((tool) => tool.name === "create_planner_campaign");
  assert.ok(planner, "create_planner_campaign must exist");
  assert.throws(() =>
    planner.schema.parse({ name: "Naati Ninja", intake_data: { objective: "book consults" } })
  );
  assert.doesNotThrow(() =>
    planner.schema.parse({
      name: "Naati Ninja",
      intake_data: { objective: "book consults", languages: ["Hindi", "Punjabi"] },
    })
  );
});

test("every tool has a description and a schema", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
    assert.ok(tool.title.length > 0, `${tool.name} needs a title`);
    assert.ok(tool.schema, `${tool.name} needs an input schema`);
  }
});

test("write tools are gated by role", () => {
  assert.equal(canWrite("viewer"), false);
  assert.equal(canWrite("member"), false);
  assert.equal(canWrite("editor"), true);
  assert.equal(canWrite("admin"), true);
  assert.equal(canWrite("owner"), true);
});

test("the key is read out of the bearer header", () => {
  assert.equal(bearerFrom({ authorization: "Bearer csw_abc" }), "csw_abc");
  assert.equal(bearerFrom({ Authorization: "csw_abc" }), "csw_abc");
  assert.equal(bearerFrom({}), "");
});

test("only csw_ keys reach the API", () => {
  assert.equal(keyShaped("csw_0123456789abcdef"), true);
  assert.equal(keyShaped("csw_not-a-real-key"), false);
  assert.equal(keyShaped("Bearer csw_0123456789abcdef"), false);
  assert.equal(keyShaped(""), false);
});

test("queue management never exposes a retract", () => {
  const queue = TOOLS.find((tool) => tool.name === "manage_publish_queue");
  assert.ok(queue, "manage_publish_queue must exist");
  assert.throws(() => queue.schema.parse({ queue_id: "q", action: "retract" }));
  assert.doesNotThrow(() => queue.schema.parse({ queue_id: "q", action: "cancel" }));
  assert.doesNotThrow(() =>
    queue.schema.parse({
      queue_id: "q",
      action: "reschedule",
      scheduled_for: "2030-01-01T09:00:00Z",
    })
  );
});

test("the write tools are the ones that change something", () => {
  const write = TOOLS.filter((t) => t.write).map((t) => t.name);
  assert.deepEqual(write.sort(), [
    "apply_performance_learnings",
    "check_post_delivery",
    "compose_post",
    "create_content_item",
    "create_planner_campaign",
    "create_post_draft",
    "create_project",
    "delete_post_draft",
    "edit_published_post",
    "execute_content_plan",
    "manage_publish_queue",
    "pause_ad_campaign",
    "reply_to_comment",
    "retry_planner_stage",
    "run_publish_queue",
    "schedule_post_from_draft",
    "start_planner_campaign",
    "submit_post_draft",
    "test_llm_provider",
    "update_ad_budget",
    "update_content_asset",
    "update_plan_brief",
    "update_post_draft",
    "update_schedule",
  ]);
});
