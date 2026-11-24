import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAgentCommand,
  createAgentService,
} from "#src/services/agent.service.js";
import { generateUuidV7 } from "#src/utilities/uuid.js";

function makeFakeCli(dir, filename, scriptBody) {
  const filePath = join(dir, filename);
  writeFileSync(filePath, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

function makeTaskEnvelope({
  id = generateUuidV7(),
  title = "Test task",
  description = "Do the work",
  parent_id = null,
  priority = "P1",
  execution = {},
} = {}) {
  const nowIso = "2026-11-24T12:00:00.000Z";
  return {
    schema: { version: "v1" },
    metadata: {
      created_at: nowIso,
      updated_at: nowIso,
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
    },
    data: {
      id,
      title,
      description,
      parent_id,
      priority,
      execution: {
        agent: "codex",
        model: null,
        effort: null,
        cwd: null,
        permission_mode: null,
        timeout_ms: null,
        session_id: null,
        ...execution,
      },
    },
  };
}

test("buildAgentCommand constructs expected headless flags for agy, claude, and codex", () => {
  const agyCmd = buildAgentCommand({
    agent: "agy",
    promptText: "hello",
    cwd: "/repo",
    model: "gemini-2.5-pro",
    effort: "high",
    permissionMode: "workspace",
    timeoutMs: 120_000,
    sessionId: "conv-1",
  });
  assert.equal(agyCmd.executable, "agy");
  assert.equal(agyCmd.stdinText, null);
  assert.equal(agyCmd.enforcement, "sandbox");
  assert.ok(agyCmd.args.includes("--conversation"));
  assert.ok(agyCmd.args.includes("conv-1"));
  assert.ok(agyCmd.args.includes("--mode"));

  const claudeCmd = buildAgentCommand({
    agent: "claude",
    promptText: "hello",
    cwd: "/repo",
    model: "sonnet",
    effort: "medium",
    permissionMode: "read-only",
    sessionId: "sess-1",
  });
  assert.equal(claudeCmd.executable, "claude");
  assert.equal(claudeCmd.stdinText, "hello");
  assert.equal(claudeCmd.args.includes("--no-session-persistence"), false);
  assert.ok(claudeCmd.args.includes("--resume"));
  assert.ok(claudeCmd.args.includes("sess-1"));
  assert.ok(claudeCmd.args.includes("Read,Glob,Grep"));

  const codexNew = buildAgentCommand({
    agent: "codex",
    agentConfig: { skip_git_repo_check: true },
    promptText: "hello",
    cwd: "/repo",
    model: "gpt-5",
    effort: "medium",
    permissionMode: "workspace",
    lastMessagePath: "/tmp/last.md",
  });
  assert.equal(codexNew.args[0], "-a");
  assert.equal(codexNew.args.includes("--ephemeral"), false);
  assert.ok(codexNew.args.includes("--cd"));
  assert.ok(codexNew.args.includes("--skip-git-repo-check"));

  const codexResume = buildAgentCommand({
    agent: "codex",
    promptText: "continue",
    cwd: "/repo",
    permissionMode: "full",
    sessionId: "thread-99",
    lastMessagePath: "/tmp/last.md",
  });
  assert.equal(codexResume.args[0], "--dangerously-bypass-approvals-and-sandbox");
  assert.equal(codexResume.args[1], "exec");
  assert.equal(codexResume.args[2], "resume");
  assert.equal(codexResume.args.includes("--cd"), false);
  assert.equal(codexResume.args.at(-2), "thread-99");
  assert.equal(codexResume.args.at(-1), "-");
});

test("createAgentService executes agy, claude, and codex fakes and writes artifacts + result.json", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repoDir = join(dir, "repo");
  const runsDir = join(dir, "runs");
  mkdirSync(repoDir, { recursive: true });

  const fakeAgy = makeFakeCli(
    dir,
    "fake-agy.mjs",
    `
    process.stderr.write("agy stderr log\\n");
    process.stdout.write(JSON.stringify({
      status: "completed",
      result: "# Agy Done\\nAll good.",
      conversation_id: "agy-conv-123",
      model: "gemini-3-pro",
      usage: { input_tokens: 10, output_tokens: 20 }
    }));
    `,
  );

  const fakeClaude = makeFakeCli(
    dir,
    "fake-claude.mjs",
    `
    let stdin = "";
    process.stdin.on("data", (d) => { stdin += d; });
    process.stdin.on("end", () => {
      process.stderr.write("claude stderr log\\n");
      process.stdout.write(JSON.stringify({
        type: "result",
        is_error: false,
        result: "Claude saw prompt length=" + stdin.length,
        session_id: "claude-sess-456",
        modelUsage: { "claude-sonnet": { inputTokens: 15 } },
        usage: { input_tokens: 15, output_tokens: 25 },
        total_cost_usd: 0.012
      }));
    });
    `,
  );

  const fakeCodex = makeFakeCli(
    dir,
    "fake-codex.mjs",
    `
    import { writeFileSync } from "node:fs";
    const idx = process.argv.indexOf("--output-last-message");
    const lastPath = idx >= 0 ? process.argv[idx + 1] : null;
    let stdin = "";
    process.stdin.on("data", (d) => { stdin += d; });
    process.stdin.on("end", () => {
      if (lastPath) writeFileSync(lastPath, "Codex final markdown\\nPrompt=" + stdin.includes("Codex task"), "utf8");
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-789" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }) + "\\n");
    });
    `,
  );

  const service = createAgentService({
    workerConfig: {
      worker_id: "test-worker",
      runs_dir: runsDir,
      allowed_agents: ["agy", "claude", "codex"],
      default_permission_mode: "workspace",
      max_permission_mode: "workspace",
      default_cwd: repoDir,
      allowed_cwd_roots: [repoDir],
      default_timeout_ms: 10_000,
      agents: {
        agy: { executable: fakeAgy, default_model: null, default_effort: null },
        claude: { executable: fakeClaude, default_model: null, default_effort: null },
        codex: { executable: fakeCodex, default_model: null, default_effort: null, skip_git_repo_check: true },
      },
    },
    logger: { log() {}, error() {} },
  });

  const agyRes = await service.executeTask(
    makeTaskEnvelope({ title: "Agy task", execution: { agent: "agy" } }),
  );
  assert.equal(agyRes.status, "completed");
  assert.equal(agyRes.resultEnvelope.schema.type, "task_result");
  assert.equal(agyRes.resultEnvelope.metadata.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(agyRes.resultEnvelope.metadata.parent_span_id, "00f067aa0ba902b7");
  assert.equal(agyRes.resultEnvelope.data.execution.session_id, "agy-conv-123");
  assert.equal(agyRes.resultEnvelope.data.execution.effective_model, "gemini-3-pro");
  assert.equal(agyRes.resultEnvelope.data.output.text, "# Agy Done\nAll good.");
  assert.equal(existsSync(agyRes.resultEnvelope.data.artifacts.result_file), true);
  assert.equal(existsSync(agyRes.resultEnvelope.data.artifacts.prompt_file), true);
  assert.match(readFileSync(agyRes.resultEnvelope.data.artifacts.log_file, "utf8"), /agy stderr/);

  const claudeRes = await service.executeTask(
    makeTaskEnvelope({ title: "Claude task", execution: { agent: "claude" } }),
  );
  assert.equal(claudeRes.status, "completed");
  assert.equal(claudeRes.resultEnvelope.data.execution.session_id, "claude-sess-456");
  assert.equal(claudeRes.resultEnvelope.data.usage.total_cost_usd, 0.012);
  assert.match(claudeRes.resultEnvelope.data.output.text, /Claude saw prompt length=/);

  const codexRes = await service.executeTask(
    makeTaskEnvelope({ title: "Codex task", execution: { agent: "codex" } }),
  );
  assert.equal(codexRes.status, "completed");
  assert.equal(codexRes.resultEnvelope.data.execution.session_id, "codex-thread-789");
  assert.equal(codexRes.resultEnvelope.data.usage.input_tokens, 100);
  assert.match(codexRes.resultEnvelope.data.output.text, /Codex final markdown/);
  assert.match(codexRes.resultEnvelope.data.artifacts.raw_output_file, /events\.jsonl$/);
});

test("createAgentService handles policy rejections, non-zero exit, timeout, and AbortSignal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-agent-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const allowedRoot = join(dir, "allowed");
  const outsideDir = join(dir, "outside");
  const runsDir = join(dir, "runs");
  mkdirSync(allowedRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const failCli = makeFakeCli(
    dir,
    "fail-cli.mjs",
    `
    process.stderr.write("fatal: boom\\n");
    process.exit(2);
    `,
  );

  const slowCli = makeFakeCli(
    dir,
    "slow-cli.mjs",
    `
    setInterval(() => {}, 1000);
    `,
  );

  const service = createAgentService({
    workerConfig: {
      worker_id: "test-worker",
      runs_dir: runsDir,
      allowed_agents: ["claude", "codex"],
      default_permission_mode: "workspace",
      max_permission_mode: "workspace",
      default_cwd: allowedRoot,
      allowed_cwd_roots: [allowedRoot],
      default_timeout_ms: 5_000,
      agents: {
        agy: { executable: "agy", default_model: null, default_effort: null },
        claude: { executable: failCli, default_model: null, default_effort: null },
        codex: { executable: slowCli, default_model: null, default_effort: null, skip_git_repo_check: true },
      },
    },
    logger: { log() {}, error() {} },
  });

  // 1. Disallowed agent
  const notAllowed = await service.executeTask(
    makeTaskEnvelope({ execution: { agent: "agy" } }),
  );
  assert.equal(notAllowed.status, "failed");
  assert.equal(notAllowed.resultEnvelope.data.error.code, "AGENT_NOT_ALLOWED");
  assert.equal(existsSync(notAllowed.resultEnvelope.data.artifacts.result_file), true);

  // 2. Permission ceiling exceeded
  const permExceeded = await service.executeTask(
    makeTaskEnvelope({ execution: { agent: "claude", permission_mode: "full" } }),
  );
  assert.equal(permExceeded.status, "failed");
  assert.equal(permExceeded.resultEnvelope.data.error.code, "PERMISSION_EXCEEDED");

  // 3. CWD outside allowed_cwd_roots
  const cwdBlocked = await service.executeTask(
    makeTaskEnvelope({ execution: { agent: "claude", cwd: outsideDir } }),
  );
  assert.equal(cwdBlocked.status, "failed");
  assert.equal(cwdBlocked.resultEnvelope.data.error.code, "CWD_NOT_ALLOWED");

  // 4. Non-zero exit
  const nonZero = await service.executeTask(
    makeTaskEnvelope({ execution: { agent: "claude" } }),
  );
  assert.equal(nonZero.status, "failed");
  assert.equal(nonZero.resultEnvelope.data.execution.exit_code, 2);
  assert.match(nonZero.resultEnvelope.data.error.message, /fatal: boom/);

  // 5. Timeout
  const timedOut = await service.executeTask(
    makeTaskEnvelope({ execution: { agent: "codex", timeout_ms: 80 } }),
  );
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.resultEnvelope.data.error.code, "EXECUTION_TIMEOUT");

  // 6. AbortSignal -> interrupted
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  const aborted = await service.executeTask(
    makeTaskEnvelope({ execution: { agent: "codex", timeout_ms: 5_000 } }),
    { signal: ac.signal },
  );
  assert.equal(aborted.status, "interrupted");
  assert.equal(aborted.resultEnvelope.data.error.code, "ABORTED");
});
