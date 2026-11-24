import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createTraceContext } from "#src/utilities/otel.js";
import { redactSecrets } from "#src/utilities/redaction.js";
import { expandHomePath } from "#src/utilities/settings.js";
import { generateUuidV7 } from "#src/utilities/uuid.js";
import {
  isPlainObject,
  PERMISSION_MODE_RANK,
  TASK_RESULT_SCHEMA_TYPE,
  TASK_SCHEMA_VERSION,
} from "#src/utilities/validation.js";

const KILL_GRACE_MS = 5_000;

function numOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPathWithinRoot(targetRealPath, rootRealPath) {
  const rel = relative(rootRealPath, targetRealPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function emptyUsage() {
  return {
    input_tokens: null,
    output_tokens: null,
    total_cost_usd: null,
  };
}

/**
 * Render a structured Markdown prompt from a v1 task input envelope.
 */
export function buildTaskPrompt(
  taskEnvelope,
  { permissionMode, allowedWorkspaces, worktreeBranch = null } = {},
) {
  const data = taskEnvelope?.data ?? {};
  const metadata = taskEnvelope?.metadata ?? {};

  const lines = [
    "<!-- task-aside execution context -->",
    `- Task ID: ${data.id ?? "unknown"}`,
    `- Priority: ${data.priority ?? "P2"}`,
  ];

  if (data.parent_id) {
    lines.push(`- Parent Task ID: ${data.parent_id}`);
  }
  if (metadata.trace_id) {
    lines.push(`- Trace ID: ${metadata.trace_id}`);
  }
  if (worktreeBranch) {
    lines.push(`- Isolated Git Worktree Branch: ${worktreeBranch}`);
  }

  lines.push(
    "- Task Breakdown / HITL: If the task is too large, you may create child subtasks referencing `parent_id` set to this Task ID. If human clarification is needed, complete your response clearly with the open questions.",
  );

  if (Array.isArray(allowedWorkspaces) && allowedWorkspaces.length > 0) {
    lines.push(
      `- Workspace Boundary: Only read, modify, or execute commands inside the allowed workspace roots (and their subdirectories): ${allowedWorkspaces.join(", ")}.`,
    );
  }

  if (permissionMode === "read-only") {
    lines.push(
      "- Read-Only Constraint: Do not modify, create, or delete any files, and do not execute mutating commands.",
    );
  }

  lines.push("", `# ${data.title ?? "Untitled Task"}`, "", data.description ?? "");
  return lines.join("\n");
}

/**
 * Build headless CLI executable, argv array, stdin text, and enforcement descriptor.
 */
export function buildAgentCommand({
  agent,
  agentConfig = {},
  promptText,
  cwd,
  model = null,
  effort = null,
  permissionMode = "workspace",
  timeoutMs = 600_000,
  sessionId = null,
  lastMessagePath = null,
}) {
  if (agent === "agy") {
    const executable = agentConfig.executable || "agy";
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const args = [
      "--print",
      promptText,
      "--output-format",
      "json",
      "--print-timeout",
      `${timeoutSeconds}s`,
    ];

    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    if (sessionId) {
      args.push("--conversation", sessionId);
    }

    let enforcement;
    if (permissionMode === "full") {
      args.push("--dangerously-skip-permissions");
      enforcement = "full";
    } else if (permissionMode === "workspace") {
      args.push("--mode", "accept-edits", "--sandbox", "--dangerously-skip-permissions");
      enforcement = "sandbox";
    } else {
      args.push("--mode", "plan", "--sandbox");
      enforcement = "prompt-only";
    }

    return {
      executable,
      args,
      stdinText: null,
      enforcement,
    };
  }

  if (agent === "claude") {
    const executable = agentConfig.executable || "claude";
    const args = ["-p", "--output-format", "json"];

    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    let enforcement;
    if (permissionMode === "full") {
      args.push("--permission-mode", "bypassPermissions", "--permission-prompts", "none");
      enforcement = "full";
    } else if (permissionMode === "workspace") {
      args.push("--permission-mode", "acceptEdits", "--permission-prompts", "none");
      enforcement = "tool-policy";
    } else {
      args.push(
        "--tools",
        "Read,Glob,Grep",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
      );
      enforcement = "tool-policy";
    }

    return {
      executable,
      args,
      stdinText: promptText,
      enforcement,
    };
  }

  if (agent === "codex") {
    const executable = agentConfig.executable || "codex";
    const globalArgs = [];
    let enforcement;

    if (permissionMode === "full") {
      globalArgs.push("--dangerously-bypass-approvals-and-sandbox");
      enforcement = "full";
    } else if (permissionMode === "workspace") {
      globalArgs.push("-a", "never", "-s", "workspace-write");
      enforcement = "sandbox";
    } else {
      globalArgs.push("-a", "never", "-s", "read-only");
      enforcement = "sandbox";
    }

    const execArgs = sessionId
      ? ["exec", "resume", "--json"]
      : ["exec", "--cd", cwd, "--json"];

    if (lastMessagePath) {
      execArgs.push("--output-last-message", lastMessagePath);
    }
    if (model) {
      execArgs.push("--model", model);
    }
    if (effort) {
      execArgs.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    }
    if (agentConfig.skip_git_repo_check) {
      execArgs.push("--skip-git-repo-check");
    }

    if (sessionId) {
      execArgs.push(sessionId, "-");
    } else {
      execArgs.push("-");
    }

    return {
      executable,
      args: [...globalArgs, ...execArgs],
      stdinText: promptText,
      enforcement,
    };
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

function tryParseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { parsed: null, empty: true };
  }

  try {
    return { parsed: JSON.parse(trimmed), empty: false };
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return { parsed: JSON.parse(lines[i]), empty: false };
      } catch {
        // Keep scanning backwards for a valid JSON object
      }
    }
    return { parsed: null, empty: false };
  }
}

export function parseAgyOutput(rawStdout) {
  const { parsed, empty } = tryParseJson(rawStdout);
  if (empty) {
    return {
      text: null,
      sessionId: null,
      effectiveModel: null,
      usage: emptyUsage(),
      isError: false,
      errorMessage: null,
      parseError: false,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      text: rawStdout.trim() || null,
      sessionId: null,
      effectiveModel: null,
      usage: emptyUsage(),
      isError: false,
      errorMessage: null,
      parseError: true,
    };
  }

  const usageObj = isPlainObject(parsed.usage) ? parsed.usage : {};
  const modelUsageKeys = isPlainObject(parsed.modelUsage) ? Object.keys(parsed.modelUsage) : [];
  const isError = Boolean(
    parsed.is_error === true ||
      parsed.status === "error" ||
      parsed.status === "failed" ||
      parsed.type === "error",
  );
  const errorMessage =
    typeof parsed.error === "string"
      ? parsed.error
      : stringOrNull(parsed.error?.message) ??
        (isError ? stringOrNull(parsed.result ?? parsed.message) : null);

  return {
    text:
      stringOrNull(parsed.result) ??
      stringOrNull(parsed.response) ??
      stringOrNull(parsed.text) ??
      stringOrNull(parsed.output) ??
      stringOrNull(parsed.message),
    sessionId:
      stringOrNull(parsed.conversation_id) ??
      stringOrNull(parsed.conversationId) ??
      stringOrNull(parsed.session_id) ??
      stringOrNull(parsed.sessionId),
    effectiveModel:
      stringOrNull(parsed.model) ??
      stringOrNull(parsed.effective_model) ??
      stringOrNull(modelUsageKeys[0]),
    usage: {
      input_tokens: numOrNull(usageObj.input_tokens ?? usageObj.inputTokens),
      output_tokens: numOrNull(usageObj.output_tokens ?? usageObj.outputTokens),
      total_cost_usd: numOrNull(
        parsed.total_cost_usd ?? usageObj.total_cost_usd ?? parsed.cost_usd,
      ),
    },
    isError,
    errorMessage,
    parseError: false,
  };
}

export function parseClaudeOutput(rawStdout) {
  const { parsed, empty } = tryParseJson(rawStdout);
  if (empty) {
    return {
      text: null,
      sessionId: null,
      effectiveModel: null,
      usage: emptyUsage(),
      isError: false,
      errorMessage: null,
      parseError: false,
    };
  }

  let target = null;
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      if (isPlainObject(parsed[i]) && parsed[i].type === "result") {
        target = parsed[i];
        break;
      }
    }
    if (!target) {
      for (let i = parsed.length - 1; i >= 0; i -= 1) {
        if (isPlainObject(parsed[i])) {
          target = parsed[i];
          break;
        }
      }
    }
  } else if (isPlainObject(parsed)) {
    target = parsed;
  }

  if (!target) {
    return {
      text: rawStdout.trim() || null,
      sessionId: null,
      effectiveModel: null,
      usage: emptyUsage(),
      isError: false,
      errorMessage: null,
      parseError: true,
    };
  }

  const usageObj = isPlainObject(target.usage) ? target.usage : {};
  const modelUsageKeys = isPlainObject(target.modelUsage) ? Object.keys(target.modelUsage) : [];
  const isError = Boolean(
    target.is_error === true ||
      target.subtype === "error_during_execution" ||
      target.subtype === "error_max_turns" ||
      target.type === "error",
  );
  const firstArrayError =
    Array.isArray(target.errors) && target.errors.length > 0 ? String(target.errors[0]) : null;
  const errorMessage =
    firstArrayError ??
    (typeof target.error === "string"
      ? target.error
      : stringOrNull(target.error?.message)) ??
    (isError ? stringOrNull(target.result ?? target.message) : null);

  return {
    text: stringOrNull(target.result) ?? stringOrNull(target.text) ?? stringOrNull(target.message),
    sessionId: stringOrNull(target.session_id) ?? stringOrNull(target.sessionId),
    effectiveModel: stringOrNull(target.model) ?? stringOrNull(modelUsageKeys[0]),
    usage: {
      input_tokens: numOrNull(usageObj.input_tokens),
      output_tokens: numOrNull(usageObj.output_tokens),
      total_cost_usd: numOrNull(target.total_cost_usd ?? usageObj.total_cost_usd),
    },
    isError,
    errorMessage,
    parseError: false,
  };
}

export function parseCodexOutput(rawJsonl, lastMessageText = "") {
  const lines = rawJsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let sessionId = null;
  let effectiveModel = null;
  const usage = emptyUsage();
  let agentMessageFallback = null;
  let isError = false;
  let errorMessage = null;
  let validJsonCount = 0;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(event)) {
      continue;
    }
    validJsonCount += 1;

    sessionId =
      stringOrNull(event.thread_id) ??
      stringOrNull(event.session_id) ??
      sessionId;

    effectiveModel =
      stringOrNull(event.model) ??
      stringOrNull(event.msg?.model) ??
      effectiveModel;

    if (event.type === "item.completed" && isPlainObject(event.item)) {
      if (event.item.type === "agent_message" && typeof event.item.text === "string") {
        agentMessageFallback = event.item.text;
      }
    }

    if (event.type === "turn.completed" && isPlainObject(event.usage)) {
      usage.input_tokens = numOrNull(event.usage.input_tokens) ?? usage.input_tokens;
      usage.output_tokens = numOrNull(event.usage.output_tokens) ?? usage.output_tokens;
      usage.total_cost_usd = numOrNull(event.usage.total_cost_usd) ?? usage.total_cost_usd;
    }

    if (event.type === "turn.failed" || event.type === "error") {
      isError = true;
      errorMessage =
        stringOrNull(event.error?.message) ??
        stringOrNull(event.message) ??
        errorMessage;
    }
  }

  const trimmedLastMessage = typeof lastMessageText === "string" ? lastMessageText.trim() : "";
  const resolvedText =
    (trimmedLastMessage.length > 0 ? trimmedLastMessage : null) ??
    stringOrNull(agentMessageFallback);

  return {
    text: resolvedText,
    sessionId,
    effectiveModel,
    usage,
    isError,
    errorMessage,
    parseError: lines.length > 0 && validJsonCount === 0,
  };
}

function parseAgentOutput(agent, rawStdout, lastMessageText) {
  if (agent === "agy") {
    return parseAgyOutput(rawStdout);
  }
  if (agent === "claude") {
    return parseClaudeOutput(rawStdout);
  }
  if (agent === "codex") {
    return parseCodexOutput(rawStdout, lastMessageText);
  }
  return {
    text: rawStdout.trim() || null,
    sessionId: null,
    effectiveModel: null,
    usage: emptyUsage(),
    isError: false,
    errorMessage: null,
    parseError: true,
  };
}

function closeStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.writableEnded) {
      resolve();
      return;
    }
    stream.end(resolve);
  });
}

function summarizeStderr(stderr) {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed.split(/\r?\n/);
  return lines.slice(-5).join("\n").slice(0, 1000);
}

function runGitCommand(args, { cwd, spawnImpl = spawn } = {}) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawnImpl("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveRun({ code: null, stdout: "", stderr: "", error });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveRun({ code: null, stdout, stderr, error });
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveRun({ code, stdout, stderr, error: null });
    });
  });
}

/**
 * Headless agent execution service for agy, claude, and codex.
 */
export function createAgentService({
  workerConfig,
  allowedWorkspaces = [],
  secrets = [],
  spawnImpl = spawn,
  now = () => Date.now(),
  generateId = generateUuidV7,
  createTrace = createTraceContext,
  logger = console,
}) {
  function buildResultEnvelope({
    taskEnvelope,
    status,
    agent,
    requestedModel,
    effectiveModel,
    effort,
    cwd,
    permissionMode,
    enforcement,
    sessionId,
    worktree = null,
    exitCode,
    startedAtMs,
    finishedAtMs,
    outputText,
    usage,
    artifacts,
    error,
  }) {
    const taskData = taskEnvelope?.data ?? {};
    const taskMeta = taskEnvelope?.metadata ?? {};
    const { trace_id: traceId, span_id: spanId } = createTrace({
      traceId: taskMeta.trace_id ?? null,
    });
    const createdAt = new Date(finishedAtMs).toISOString();
    const safeOutputText = typeof outputText === "string" ? redactSecrets(outputText, secrets) : outputText;
    const safeError = error
      ? {
          ...error,
          message: typeof error.message === "string" ? redactSecrets(error.message, secrets) : error.message,
        }
      : null;

    return {
      schema: {
        version: TASK_SCHEMA_VERSION,
        type: TASK_RESULT_SCHEMA_TYPE,
      },
      metadata: {
        created_at: createdAt,
        updated_at: createdAt,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: taskMeta.span_id ?? null,
      },
      data: {
        id: generateId(finishedAtMs),
        task_id: taskData.id ?? null,
        parent_id: taskData.parent_id ?? null,
        status,
        execution: {
          agent,
          worker_id: workerConfig.worker_id,
          requested_model: requestedModel,
          effective_model: effectiveModel,
          effort,
          cwd,
          permission_mode: permissionMode,
          enforcement,
          session_id: sessionId,
          worktree,
          exit_code: exitCode,
          started_at: new Date(startedAtMs).toISOString(),
          finished_at: createdAt,
          duration_ms: Math.max(0, finishedAtMs - startedAtMs),
        },
        output: {
          format: "markdown",
          text: safeOutputText,
        },
        usage: usage ?? emptyUsage(),
        artifacts,
        error: safeError,
      },
    };
  }

  function writeResultFile(resultPath, resultEnvelope) {
    writeFileSync(resultPath, `${JSON.stringify(resultEnvelope, null, 2)}\n`, "utf8");
  }

  async function executeTask(taskEnvelope, { attempt = 1, signal } = {}) {
    const startedAtMs = now();
    const taskData = taskEnvelope?.data ?? {};
    const execReq = taskData.execution ?? {};
    const taskId = taskData.id ?? generateId(startedAtMs);
    const agent = execReq.agent;
    const agentConfig = workerConfig.agents?.[agent] ?? {};

    const requestedModel = execReq.model ?? agentConfig.default_model ?? null;
    const effort = execReq.effort ?? agentConfig.default_effort ?? null;
    const permissionMode = execReq.permission_mode ?? workerConfig.default_permission_mode;
    const timeoutMs = execReq.timeout_ms ?? workerConfig.default_timeout_ms;
    const requestedSessionId = execReq.session_id ?? null;
    const defaultCwd = Array.isArray(allowedWorkspaces) ? (allowedWorkspaces[0] ?? null) : null;
    const rawRequestedCwd = execReq.cwd;
    const requestedCwd =
      typeof rawRequestedCwd === "string" &&
      (rawRequestedCwd === "~" ||
        rawRequestedCwd.startsWith("~/") ||
        rawRequestedCwd.startsWith("~\\"))
        ? expandHomePath(rawRequestedCwd)
        : (rawRequestedCwd ?? defaultCwd);

    const runDirName = attempt > 1 ? `${taskId}-attempt-${attempt}` : taskId;
    const runDir = join(workerConfig.runs_dir, runDirName);
    mkdirSync(runDir, { recursive: true });

    const promptPath = join(runDir, "prompt.md");
    const resultPath = join(runDir, "result.json");
    const rawOutputPath = join(runDir, agent === "codex" ? "events.jsonl" : "raw-output.json");
    const lastMessagePath = agent === "codex" ? join(runDir, "last-message.md") : null;
    const logPath = join(runDir, "agent.log");

    const artifacts = {
      run_dir: runDir,
      prompt_file: promptPath,
      result_file: resultPath,
      raw_output_file: rawOutputPath,
      log_file: logPath,
    };

    const failPreSpawn = (code, category, message) => {
      const finishedAtMs = now();
      const resultEnvelope = buildResultEnvelope({
        taskEnvelope,
        status: "failed",
        agent,
        requestedModel,
        effectiveModel: null,
        effort,
        cwd: requestedCwd,
        permissionMode,
        enforcement: null,
        sessionId: requestedSessionId,
        exitCode: null,
        startedAtMs,
        finishedAtMs,
        outputText: null,
        usage: emptyUsage(),
        artifacts,
        error: { code, category, message },
      });
      writeResultFile(resultPath, resultEnvelope);
      return { status: "failed", resultEnvelope };
    };

    if (!workerConfig.allowed_agents.includes(agent)) {
      return failPreSpawn(
        "AGENT_NOT_ALLOWED",
        "permission",
        `Agent "${agent}" is not in worker.allowed_agents`,
      );
    }

    if (
      PERMISSION_MODE_RANK[permissionMode] >
      PERMISSION_MODE_RANK[workerConfig.max_permission_mode]
    ) {
      return failPreSpawn(
        "PERMISSION_EXCEEDED",
        "permission",
        `Requested permission_mode "${permissionMode}" exceeds worker.max_permission_mode "${workerConfig.max_permission_mode}"`,
      );
    }

    if (!Array.isArray(allowedWorkspaces) || allowedWorkspaces.length === 0) {
      return failPreSpawn(
        "CWD_NOT_ALLOWED",
        "permission",
        "No allowed_workspaces configured",
      );
    }

    if (!requestedCwd || !existsSync(requestedCwd)) {
      return failPreSpawn(
        "INVALID_CWD",
        "validation",
        `Working directory does not exist: ${requestedCwd}`,
      );
    }

    let resolvedCwd;
    try {
      const stat = statSync(requestedCwd);
      if (!stat.isDirectory()) {
        return failPreSpawn(
          "INVALID_CWD",
          "validation",
          `Working directory path is not a directory: ${requestedCwd}`,
        );
      }
      resolvedCwd = realpathSync(requestedCwd);
    } catch (error) {
      return failPreSpawn(
        "INVALID_CWD",
        "validation",
        `Unable to access working directory "${requestedCwd}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const allowed = allowedWorkspaces.some((root) => {
      if (!existsSync(root)) {
        return false;
      }
      try {
        return isPathWithinRoot(resolvedCwd, realpathSync(root));
      } catch {
        return false;
      }
    });

    if (!allowed) {
      return failPreSpawn(
        "CWD_NOT_ALLOWED",
        "permission",
        `Working directory "${resolvedCwd}" is outside allowed_workspaces`,
      );
    }

    let executionCwd = resolvedCwd;
    let worktreeInfo = null;
    if (execReq.worktree === true) {
      const topRes = await runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: resolvedCwd,
        spawnImpl,
      });
      if (topRes.error || topRes.code !== 0 || !topRes.stdout.trim()) {
        return failPreSpawn(
          "INVALID_WORKTREE",
          "validation",
          `Working directory "${resolvedCwd}" is not inside a git repository`,
        );
      }

      const repoRoot = realpathSync(topRes.stdout.trim());
      const headRes = await runGitCommand(["rev-parse", "--verify", "HEAD"], {
        cwd: repoRoot,
        spawnImpl,
      });
      if (headRes.error || headRes.code !== 0 || !headRes.stdout.trim()) {
        return failPreSpawn(
          "INVALID_WORKTREE",
          "validation",
          "Git repository has no commits (HEAD is unborn)",
        );
      }

      const baseCommit = headRes.stdout.trim();
      const relSubdir = relative(repoRoot, resolvedCwd);
      const shortId = String(taskId).replaceAll("-", "").slice(-12);
      const branch = `task-aside/${shortId}${attempt > 1 ? `-a${attempt}` : ""}`;
      const worktreeRoot = join(runDir, "worktree");

      const addRes = await runGitCommand(
        ["-C", repoRoot, "worktree", "add", "-b", branch, worktreeRoot, baseCommit],
        { cwd: repoRoot, spawnImpl },
      );
      if (addRes.error || addRes.code !== 0) {
        return failPreSpawn(
          "WORKTREE_ERROR",
          "environment",
          redactSecrets(
            `Failed to create git worktree: ${addRes.stderr.trim() || addRes.error?.message || "unknown error"}`,
            secrets,
          ),
        );
      }

      worktreeInfo = {
        repoRoot,
        root: worktreeRoot,
        branch,
        baseCommit,
      };
      executionCwd = relSubdir ? join(worktreeRoot, relSubdir) : worktreeRoot;
    }

    const promptWorkspaces = worktreeInfo
      ? [...allowedWorkspaces, worktreeInfo.root]
      : allowedWorkspaces;
    const promptText = buildTaskPrompt(taskEnvelope, {
      permissionMode,
      allowedWorkspaces: promptWorkspaces,
      worktreeBranch: worktreeInfo?.branch ?? null,
    });
    writeFileSync(promptPath, `${promptText}\n`, "utf8");

    const command = buildAgentCommand({
      agent,
      agentConfig,
      promptText,
      cwd: executionCwd,
      model: requestedModel,
      effort,
      permissionMode,
      timeoutMs,
      sessionId: requestedSessionId,
      lastMessagePath,
    });

    if (signal?.aborted) {
      let worktreeSummary = null;
      if (worktreeInfo) {
        await runGitCommand(
          ["-C", worktreeInfo.repoRoot, "worktree", "remove", "--force", worktreeInfo.root],
          { cwd: worktreeInfo.repoRoot, spawnImpl },
        );
        await runGitCommand(
          ["-C", worktreeInfo.repoRoot, "branch", "-D", worktreeInfo.branch],
          { cwd: worktreeInfo.repoRoot, spawnImpl },
        );
        worktreeSummary = {
          enabled: true,
          branch: worktreeInfo.branch,
          base_commit: worktreeInfo.baseCommit,
          path: null,
          cleaned_up: true,
          branch_kept: false,
          has_uncommitted_changes: false,
          commits_ahead: 0,
          changed_files: [],
          diff_stat: null,
        };
      }
      const finishedAtMs = now();
      const resultEnvelope = buildResultEnvelope({
        taskEnvelope,
        status: "interrupted",
        agent,
        requestedModel,
        effectiveModel: null,
        effort,
        cwd: executionCwd,
        permissionMode,
        enforcement: command.enforcement,
        sessionId: requestedSessionId,
        worktree: worktreeSummary,
        exitCode: null,
        startedAtMs,
        finishedAtMs,
        outputText: null,
        usage: emptyUsage(),
        artifacts,
        error: {
          code: "ABORTED",
          category: "infrastructure",
          message: "Worker shutdown aborted execution before spawn",
        },
      });
      writeResultFile(resultPath, resultEnvelope);
      return { status: "interrupted", resultEnvelope };
    }

    logger.log(
      `[agent] Spawning ${agent} task=${taskId} cwd=${executionCwd} permission=${permissionMode} timeoutMs=${timeoutMs}${worktreeInfo ? ` worktree=${worktreeInfo.branch}` : ""}`,
    );

    const rawOutStream = createWriteStream(rawOutputPath, { flags: "w" });
    const logStream = createWriteStream(logPath, { flags: "w" });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let exitCode = null;
    let exitSignal = null;

    await new Promise((resolveRun) => {
      let settled = false;
      let killTimer = null;
      let timeoutTimer = null;

      let child;
      try {
        child = spawnImpl(command.executable, command.args, {
          cwd: executionCwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        spawnError = error;
        resolveRun();
        return;
      }

      const terminateChild = () => {
        if (child.killed || settled) {
          return;
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore already exited child
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore
          }
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      };

      const onAbort = () => {
        aborted = true;
        terminateChild();
      };

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateChild();
      }, timeoutMs);
      timeoutTimer.unref?.();

      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stdout += text;
        rawOutStream.write(redactSecrets(text, secrets));
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderr += text;
        logStream.write(redactSecrets(text, secrets));
      });

      child.stdin?.on("error", () => {
        // Ignore EPIPE if child exits before reading full stdin
      });

      if (command.stdinText !== null && command.stdinText !== undefined) {
        child.stdin?.end(command.stdinText, "utf8");
      } else {
        child.stdin?.end();
      }

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        spawnError = error;
        logStream.write(`\n[spawn error] ${redactSecrets(error.message, secrets)}\n`);
        cleanup();
        resolveRun();
      });

      child.once("close", (code, sig) => {
        if (settled) {
          return;
        }
        settled = true;
        exitCode = code;
        exitSignal = sig;
        cleanup();
        resolveRun();
      });
    });

    await Promise.all([closeStream(rawOutStream), closeStream(logStream)]);

    const redactedStdout = redactSecrets(stdout, secrets);
    const redactedStderr = redactSecrets(stderr, secrets);
    if (stdout.length > 0 && redactedStdout !== stdout) {
      writeFileSync(rawOutputPath, redactedStdout, "utf8");
    }
    if (stderr.length > 0 && redactedStderr !== stderr) {
      const suffix = spawnError ? `\n[spawn error] ${redactSecrets(spawnError.message, secrets)}\n` : "";
      writeFileSync(logPath, `${redactedStderr}${suffix}`, "utf8");
    }

    const finishedAtMs = now();
    let lastMessageText =
      lastMessagePath && existsSync(lastMessagePath)
        ? readFileSync(lastMessagePath, "utf8")
        : "";
    if (lastMessageText.length > 0) {
      const redactedLastMessage = redactSecrets(lastMessageText, secrets);
      if (redactedLastMessage !== lastMessageText) {
        writeFileSync(lastMessagePath, redactedLastMessage, "utf8");
        lastMessageText = redactedLastMessage;
      }
    }
    const parsed = parseAgentOutput(agent, redactedStdout, lastMessageText);

    let worktreeSummary = null;
    if (worktreeInfo) {
      const statusRes = await runGitCommand(["-C", worktreeInfo.root, "status", "--porcelain"], {
        cwd: worktreeInfo.repoRoot,
        spawnImpl,
      });
      const changedFiles = statusRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      const hasUncommittedChanges = changedFiles.length > 0;

      const revRes = await runGitCommand(
        ["-C", worktreeInfo.root, "rev-list", "--count", `${worktreeInfo.baseCommit}..HEAD`],
        { cwd: worktreeInfo.repoRoot, spawnImpl },
      );
      const commitsAhead = Number.parseInt(revRes.stdout.trim(), 10) || 0;

      const diffRes = await runGitCommand(
        ["-C", worktreeInfo.root, "diff", "--stat", worktreeInfo.baseCommit],
        { cwd: worktreeInfo.repoRoot, spawnImpl },
      );
      const rawDiffStat = diffRes.stdout.trim();
      const diffStat = rawDiffStat ? redactSecrets(rawDiffStat, secrets).slice(0, 2000) : null;

      let cleanedUp = false;
      let branchKept = true;
      let retainedPath = worktreeInfo.root;

      if (!hasUncommittedChanges) {
        const removeRes = await runGitCommand(
          ["-C", worktreeInfo.repoRoot, "worktree", "remove", "--force", worktreeInfo.root],
          { cwd: worktreeInfo.repoRoot, spawnImpl },
        );
        if (!removeRes.error && removeRes.code === 0) {
          cleanedUp = true;
          retainedPath = null;
        }
        if (commitsAhead === 0) {
          const branchDelRes = await runGitCommand(
            ["-C", worktreeInfo.repoRoot, "branch", "-D", worktreeInfo.branch],
            { cwd: worktreeInfo.repoRoot, spawnImpl },
          );
          if (!branchDelRes.error && branchDelRes.code === 0) {
            branchKept = false;
          }
        }
      }

      worktreeSummary = {
        enabled: true,
        branch: worktreeInfo.branch,
        base_commit: worktreeInfo.baseCommit,
        path: retainedPath,
        cleaned_up: cleanedUp,
        branch_kept: branchKept,
        has_uncommitted_changes: hasUncommittedChanges,
        commits_ahead: commitsAhead,
        changed_files: changedFiles,
        diff_stat: diffStat,
      };
    }

    let status;
    let error = null;

    if (aborted) {
      status = "interrupted";
      error = {
        code: "ABORTED",
        category: "infrastructure",
        message: `Task interrupted during execution${exitSignal ? ` (signal ${exitSignal})` : ""}`,
      };
    } else if (timedOut) {
      status = "timeout";
      error = {
        code: "EXECUTION_TIMEOUT",
        category: "timeout",
        message: `Agent "${agent}" exceeded timeout of ${timeoutMs}ms`,
      };
    } else if (spawnError) {
      status = "failed";
      error = {
        code: spawnError.code === "ENOENT" ? "EXECUTABLE_NOT_FOUND" : "SPAWN_ERROR",
        category: "environment",
        message: spawnError.message,
      };
    } else if (exitCode !== 0 || parsed.isError) {
      status = "failed";
      const stderrSummary = summarizeStderr(redactedStderr);
      error = {
        code: parsed.isError ? "AGENT_REPORTED_ERROR" : "NON_ZERO_EXIT",
        category: "execution",
        message:
          parsed.errorMessage ??
          stderrSummary ??
          `Agent "${agent}" exited with code ${exitCode}`,
      };
    } else {
      status = "completed";
    }

    const resultEnvelope = buildResultEnvelope({
      taskEnvelope,
      status,
      agent,
      requestedModel,
      effectiveModel: parsed.effectiveModel,
      effort,
      cwd: executionCwd,
      permissionMode,
      enforcement: command.enforcement,
      sessionId: parsed.sessionId ?? requestedSessionId,
      worktree: worktreeSummary,
      exitCode,
      startedAtMs,
      finishedAtMs,
      outputText:
        parsed.text ??
        (status === "completed" && redactedStdout.trim() ? redactedStdout.trim() : null),
      usage: parsed.usage,
      artifacts,
      error,
    });

    writeResultFile(resultPath, resultEnvelope);
    return {
      status,
      resultEnvelope,
    };
  }

  return {
    executeTask,
  };
}
