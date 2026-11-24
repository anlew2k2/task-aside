import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createTraceContext } from "#src/utilities/otel.js";
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
export function buildTaskPrompt(taskEnvelope, { permissionMode } = {}) {
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

  lines.push(
    "- Task Breakdown / HITL: If the task is too large, you may create child subtasks referencing `parent_id` set to this Task ID. If human clarification is needed, complete your response clearly with the open questions.",
  );

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

/**
 * Headless agent execution service for agy, claude, and codex.
 */
export function createAgentService({
  workerConfig,
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
          exit_code: exitCode,
          started_at: new Date(startedAtMs).toISOString(),
          finished_at: createdAt,
          duration_ms: Math.max(0, finishedAtMs - startedAtMs),
        },
        output: {
          format: "markdown",
          text: outputText,
        },
        usage: usage ?? emptyUsage(),
        artifacts,
        error,
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
    const requestedCwd = execReq.cwd ?? workerConfig.default_cwd;

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

    if (Array.isArray(workerConfig.allowed_cwd_roots) && workerConfig.allowed_cwd_roots.length > 0) {
      const allowed = workerConfig.allowed_cwd_roots.some((root) => {
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
          `Working directory "${resolvedCwd}" is outside worker.allowed_cwd_roots`,
        );
      }
    }

    const promptText = buildTaskPrompt(taskEnvelope, { permissionMode });
    writeFileSync(promptPath, `${promptText}\n`, "utf8");

    const command = buildAgentCommand({
      agent,
      agentConfig,
      promptText,
      cwd: resolvedCwd,
      model: requestedModel,
      effort,
      permissionMode,
      timeoutMs,
      sessionId: requestedSessionId,
      lastMessagePath,
    });

    if (signal?.aborted) {
      const finishedAtMs = now();
      const resultEnvelope = buildResultEnvelope({
        taskEnvelope,
        status: "interrupted",
        agent,
        requestedModel,
        effectiveModel: null,
        effort,
        cwd: resolvedCwd,
        permissionMode,
        enforcement: command.enforcement,
        sessionId: requestedSessionId,
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
      `[agent] Spawning ${agent} task=${taskId} cwd=${resolvedCwd} permission=${permissionMode} timeoutMs=${timeoutMs}`,
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
          cwd: resolvedCwd,
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
        rawOutStream.write(chunk);
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderr += text;
        logStream.write(chunk);
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
        logStream.write(`\n[spawn error] ${error.message}\n`);
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

    const finishedAtMs = now();
    const lastMessageText =
      lastMessagePath && existsSync(lastMessagePath)
        ? readFileSync(lastMessagePath, "utf8")
        : "";
    const parsed = parseAgentOutput(agent, stdout, lastMessageText);

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
      const stderrSummary = summarizeStderr(stderr);
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
      cwd: resolvedCwd,
      permissionMode,
      enforcement: command.enforcement,
      sessionId: parsed.sessionId ?? requestedSessionId,
      exitCode,
      startedAtMs,
      finishedAtMs,
      outputText: parsed.text ?? (status === "completed" && stdout.trim() ? stdout.trim() : null),
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
