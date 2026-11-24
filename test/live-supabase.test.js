import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseTaskRepository } from "#src/repositories/task.repository.js";
import { createTraceContext } from "#src/utilities/otel.js";
import { loadSettings } from "#src/utilities/settings.js";
import { generateUuidV7 } from "#src/utilities/uuid.js";

const skipLiveReason =
  process.env.RUN_LIVE_TESTS === "1"
    ? false
    : "Set RUN_LIVE_TESTS=1 to run live Supabase integration tests";

test(
  "Live Supabase: create -> claimNext -> extendLease -> finishTask -> findById -> findAll",
  { skip: skipLiveReason, timeout: 30_000 },
  async (t) => {
    const { settings } = loadSettings({ createIfMissing: false, requireSupabase: true });
    const repo = createSupabaseTaskRepository({
      url: settings.supabase.url,
      publishableKey: settings.supabase.publishable_key,
      schema: settings.supabase.schema,
      table: settings.supabase.table,
    });

    const taskId = generateUuidV7();
    const workerId = `live-test-worker-${Date.now()}`;
    const nowIso = new Date().toISOString();
    const trace = createTraceContext();

    t.after(async () => {
      try {
        await repo.deleteById(taskId);
      } catch {
        // Ignore cleanup failure
      }
    });

    const envelope = {
      schema: { version: "v1" },
      metadata: {
        created_at: nowIso,
        updated_at: nowIso,
        trace_id: trace.trace_id,
        span_id: trace.span_id,
      },
      data: {
        id: taskId,
        title: `live-supabase-test-${Date.now()}`,
        description: "Live repository smoke test",
        parent_id: null,
        priority: "P0",
        execution: {
          agent: "codex",
          model: null,
          effort: null,
          cwd: null,
          permission_mode: "workspace",
          timeout_ms: null,
          session_id: null,
        },
      },
    };

    const idempotencyKey = `live-idem-${Date.now()}`;
    const requestHash = "live-hash-1";
    const created = await repo.create(envelope, { idempotencyKey, requestHash });
    assert.equal(created.id, taskId);
    assert.equal(created.status, "queued");

    const byIdem = await repo.findByIdempotencyKey(idempotencyKey);
    assert.ok(byIdem);
    assert.equal(byIdem.record.id, taskId);
    assert.equal(byIdem.request_hash, requestHash);

    const claimed = await repo.claimNext({
      allowedAgents: ["codex"],
      workerId,
      leaseSeconds: 60,
    });
    assert.ok(claimed);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.worker_id, workerId);
    assert.equal(claimed.attempts, 1);

    const staleExtend = await repo.extendLease({
      taskId: claimed.id,
      workerId,
      leaseSeconds: 120,
      attempt: 999,
    });
    assert.equal(staleExtend, false);

    const extended = await repo.extendLease({
      taskId: claimed.id,
      workerId,
      leaseSeconds: 120,
      attempt: claimed.attempts,
    });
    assert.equal(extended, true);

    const resultEnvelope = {
      schema: { version: "v1", type: "task_result" },
      metadata: {
        created_at: nowIso,
        updated_at: nowIso,
        trace_id: trace.trace_id,
        span_id: trace.span_id,
        parent_span_id: trace.span_id,
      },
      data: {
        id: generateUuidV7(),
        task_id: claimed.id,
        parent_id: null,
        status: "completed",
        execution: {
          agent: claimed.agent,
          worker_id: workerId,
          requested_model: null,
          effective_model: null,
          effort: null,
          cwd: null,
          permission_mode: "workspace",
          enforcement: "sandbox",
          session_id: null,
          worktree: null,
          exit_code: 0,
          started_at: nowIso,
          finished_at: nowIso,
          duration_ms: 10,
        },
        output: { format: "markdown", text: "Live test ok" },
        usage: { input_tokens: null, output_tokens: null, total_cost_usd: null },
        artifacts: null,
        error: null,
      },
    };

    const finished = await repo.finishTask({
      taskId: claimed.id,
      workerId,
      attempt: claimed.attempts,
      status: "completed",
      resultEnvelope,
      finishedAt: new Date().toISOString(),
    });
    assert.equal(finished.status, "completed");

    const fetched = await repo.findById(claimed.id);
    assert.equal(fetched.status, "completed");
    assert.equal(fetched.result.data.output.text, "Live test ok");

    const listed = await repo.findAll({ status: "completed", limit: 20, summary: true });
    const summaryItem = listed.find((item) => item.id === claimed.id);
    assert.ok(summaryItem);
    assert.equal(summaryItem.title, envelope.data.title);

    const liveStats = await repo.stats();
    assert.equal(liveStats.provider, "supabase");
    assert.equal(typeof liveStats.counts.total, "number");
    assert.ok("oldest_queued_age_ms" in liveStats);
  },
);
