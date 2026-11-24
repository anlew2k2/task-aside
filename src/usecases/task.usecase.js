import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError,
} from "#src/utilities/errors.js";
import { createTraceContext } from "#src/utilities/otel.js";
import { redactSecrets } from "#src/utilities/redaction.js";
import { generateUuidV7 } from "#src/utilities/uuid.js";
import { TASK_RESULT_SCHEMA_TYPE, TASK_SCHEMA_VERSION } from "#src/utilities/validation.js";

function computeTaskRequestHash({ title, description, parent_id, priority, execution }) {
  const canonical = {
    title,
    description,
    parent_id: parent_id ?? null,
    priority,
    execution: {
      agent: execution.agent,
      model: execution.model ?? null,
      effort: execution.effort ?? null,
      cwd: execution.cwd ?? null,
      permission_mode: execution.permission_mode ?? null,
      timeout_ms: execution.timeout_ms ?? null,
      session_id: execution.session_id ?? null,
      worktree: Boolean(execution.worktree),
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Task business logic usecase.
 * Orchestrates task creation, Supabase persistence, sequential worker claiming, and headless execution.
 */
export function createTaskUsecase({
  taskRepository,
  agentService = null,
  executeTask = null,
  workerConfig,
  allowedWorkspaces = [],
  secrets = [],
  now = () => Date.now(),
  generateId = generateUuidV7,
  createTrace = createTraceContext,
  logger = console,
}) {
  const listeners = new Set();
  const activeRuns = new Map();

  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Task listener must be a function");
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function emitEvent(type, payload) {
    if (listeners.size === 0) {
      return;
    }
    const event = {
      type,
      timestamp: new Date(now()).toISOString(),
      ...payload,
    };
    for (const listener of Array.from(listeners)) {
      try {
        const result = listener(event);
        if (result && typeof result.catch === "function") {
          result.catch((error) => {
            logger.error(
              `[usecase] Task event listener error (${type}):`,
              error instanceof Error ? error.message : String(error),
            );
          });
        }
      } catch (error) {
        logger.error(
          `[usecase] Task event listener error (${type}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  const executor =
    executeTask ??
    ((taskEnvelope, context) => {
      if (!agentService) {
        throw new Error("Agent service is required when executeTask is not provided");
      }
      return agentService.executeTask(taskEnvelope, context);
    });

  function buildFallbackResultEnvelope({
    taskEnvelope,
    status,
    startedAtMs,
    finishedAtMs,
    error,
    outputText = null,
    workerIdOverride = undefined,
  }) {
    const taskData = taskEnvelope?.data ?? {};
    const taskMeta = taskEnvelope?.metadata ?? {};
    const execReq = taskData.execution ?? {};
    const { trace_id: traceId, span_id: spanId } = createTrace({
      traceId: taskMeta.trace_id ?? null,
    });
    const createdAt = new Date(finishedAtMs).toISOString();
    const safeOutputText =
      typeof outputText === "string" ? redactSecrets(outputText, secrets) : outputText;
    const safeError = error
      ? {
          ...error,
          message:
            typeof error.message === "string"
              ? redactSecrets(error.message, secrets)
              : error.message,
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
          agent: execReq.agent ?? null,
          worker_id: workerIdOverride !== undefined ? workerIdOverride : workerConfig.worker_id,
          requested_model: execReq.model ?? null,
          effective_model: null,
          effort: execReq.effort ?? null,
          cwd: execReq.cwd ?? allowedWorkspaces[0] ?? null,
          permission_mode: execReq.permission_mode ?? workerConfig.default_permission_mode ?? null,
          enforcement: null,
          session_id: execReq.session_id ?? null,
          worktree: null,
          exit_code: null,
          started_at: startedAtMs !== null ? new Date(startedAtMs).toISOString() : null,
          finished_at: createdAt,
          duration_ms: startedAtMs !== null ? Math.max(0, finishedAtMs - startedAtMs) : null,
        },
        output: {
          format: "markdown",
          text: safeOutputText,
        },
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        },
        artifacts: null,
        error: safeError,
      },
    };
  }

  async function enforceSubtaskLimits(parentId) {
    const maxDepth = workerConfig?.max_subtask_depth ?? 3;
    const maxSubtasksPerRoot = workerConfig?.max_subtasks_per_root ?? 20;

    let depth = 0;
    let currentId = parentId;
    let rootId = parentId;
    const visited = new Set();

    while (currentId) {
      if (visited.has(currentId)) {
        throw new ValidationError("Cycle detected in parent_id chain");
      }
      visited.add(currentId);
      const ancestor = await taskRepository.findById(currentId);
      if (!ancestor) {
        if (depth === 0) {
          throw new ValidationError(`Parent task not found: ${parentId}`);
        }
        break;
      }
      depth += 1;
      rootId = ancestor.id;
      if (depth > maxDepth) {
        throw new ValidationError(
          `Subtask depth ${depth} exceeds worker.max_subtask_depth (${maxDepth})`,
        );
      }
      currentId = ancestor.parent_id ?? null;
    }

    if (typeof taskRepository.countDescendants === "function") {
      const descendants = await taskRepository.countDescendants(rootId, {
        maxDepth: maxDepth + 2,
      });
      if (descendants >= maxSubtasksPerRoot) {
        throw new ValidationError(
          `Root task ${rootId} reached worker.max_subtasks_per_root (${maxSubtasksPerRoot})`,
        );
      }
    }
  }

  async function createTask({
    title,
    description,
    parent_id = null,
    priority,
    execution,
    idempotency_key = null,
    returnMeta = false,
    skipSubtaskLimits = false,
    traceparent = null,
    trace_id = null,
    span_id = null,
  }) {
    const requestHash = idempotency_key
      ? computeTaskRequestHash({ title, description, parent_id, priority, execution })
      : null;

    if (idempotency_key && typeof taskRepository.findByIdempotencyKey === "function") {
      const existing = await taskRepository.findByIdempotencyKey(idempotency_key);
      if (existing) {
        if (existing.request_hash === requestHash) {
          return returnMeta ? { task: existing.record.task, replayed: true } : existing.record.task;
        }
        throw new ConflictError(
          `Idempotency key "${idempotency_key}" already used with a different request payload`,
        );
      }
    }

    if (parent_id !== null && !skipSubtaskLimits) {
      await enforceSubtaskLimits(parent_id);
    }

    const nowMs = now();
    const isoTimestamp = new Date(nowMs).toISOString();
    const { trace_id: traceId, span_id: spanId } = createTrace({
      traceparent,
      traceId: trace_id,
      spanId: span_id,
    });

    const taskMessage = {
      schema: {
        version: TASK_SCHEMA_VERSION,
      },
      metadata: {
        created_at: isoTimestamp,
        updated_at: isoTimestamp,
        trace_id: traceId,
        span_id: spanId,
      },
      data: {
        id: generateId(nowMs),
        title,
        description,
        parent_id,
        priority,
        execution,
      },
    };

    let record;
    try {
      record = await taskRepository.create(taskMessage, {
        idempotencyKey: idempotency_key,
        requestHash,
      });
    } catch (error) {
      const isDuplicate =
        idempotency_key &&
        error instanceof StorageError &&
        (error.statusCode === 409 || error.details?.code === "23505");
      if (!isDuplicate || typeof taskRepository.findByIdempotencyKey !== "function") {
        throw error;
      }
      const existing = await taskRepository.findByIdempotencyKey(idempotency_key);
      if (existing && existing.request_hash === requestHash) {
        return returnMeta ? { task: existing.record.task, replayed: true } : existing.record.task;
      }
      throw new ConflictError(
        `Idempotency key "${idempotency_key}" already used with a different request payload`,
      );
    }

    logger.log(
      `[task] Enqueued task id=${taskMessage.data.id} agent=${execution.agent} priority=${priority} title=${JSON.stringify(title)} trace_id=${traceId} span_id=${spanId}`,
    );
    emitEvent("task.created", { record, task: taskMessage });

    return returnMeta ? { task: taskMessage, replayed: false } : taskMessage;
  }

  async function getTask(id) {
    const record = await taskRepository.findById(id);
    if (!record) {
      throw new NotFoundError(`Task not found: ${id}`);
    }
    return record;
  }

  async function listTasks(filters = {}) {
    const tasks = await taskRepository.findAll(filters);
    return {
      tasks,
      count: tasks.length,
    };
  }

  async function getStats() {
    const repoStats = await taskRepository.stats();
    return {
      ...repoStats,
      workerId: workerConfig.worker_id,
      allowedAgents: workerConfig.allowed_agents,
      allowedWorkspaces,
    };
  }

  function getCapabilities() {
    return {
      allowed_agents: [...workerConfig.allowed_agents],
      default_permission_mode: workerConfig.default_permission_mode,
      max_permission_mode: workerConfig.max_permission_mode,
      allowed_workspaces: [...allowedWorkspaces],
      default_timeout_ms: workerConfig.default_timeout_ms,
      max_subtask_depth: workerConfig.max_subtask_depth ?? 3,
      max_subtasks_per_root: workerConfig.max_subtasks_per_root ?? 20,
      worktree_supported: true,
    };
  }

  async function processNextTask({ signal } = {}) {
    const claimed = await taskRepository.claimNext({
      allowedAgents: workerConfig.allowed_agents,
      workerId: workerConfig.worker_id,
      leaseSeconds: workerConfig.lease_seconds,
      signal,
    });

    if (!claimed) {
      return { processed: false, task: null };
    }

    const startedAtMs = now();
    const taskId = claimed.id;
    const taskEnvelope = claimed.task;
    const title = taskEnvelope?.data?.title ?? "";
    const priority = claimed.priority;
    const agent = claimed.agent;
    const traceId = claimed.trace_id ?? taskEnvelope?.metadata?.trace_id ?? null;
    const spanId = taskEnvelope?.metadata?.span_id ?? null;

    logger.log(
      `[worker] Claimed task id=${taskId} agent=${agent} priority=${priority} title=${JSON.stringify(title)} attempt=${claimed.attempts} workerId=${workerConfig.worker_id} trace_id=${traceId} span_id=${spanId}`,
    );
    emitEvent("task.started", { record: claimed });

    const taskController = new AbortController();
    const runEntry = {
      controller: taskController,
      cancelled: false,
      cancelledLocally: false,
    };
    activeRuns.set(taskId, runEntry);

    const onWorkerAbort = () => {
      taskController.abort();
    };
    if (signal) {
      if (signal.aborted) {
        taskController.abort();
      } else {
        signal.addEventListener("abort", onWorkerAbort, { once: true });
      }
    }

    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || signal?.aborted || taskController.signal.aborted) {
        return;
      }
      heartbeatInFlight = true;
      void taskRepository
        .extendLease({
          taskId,
          workerId: workerConfig.worker_id,
          leaseSeconds: workerConfig.lease_seconds,
          attempt: claimed.attempts,
        })
        .then((extended) => {
          if (!extended && !signal?.aborted) {
            runEntry.cancelled = true;
            taskController.abort();
          }
        })
        .catch((error) => {
          logger.error(
            `[worker] Failed to extend lease for task id=${taskId}:`,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, workerConfig.heartbeat_interval_ms);
    heartbeatTimer.unref?.();

    let finalStatus = "completed";
    let resultEnvelope = null;
    let aborted = false;

    try {
      const outcome = await executor(taskEnvelope, {
        attempt: claimed.attempts,
        workerId: workerConfig.worker_id,
        signal: taskController.signal,
      });

      if (outcome && typeof outcome === "object" && outcome.resultEnvelope) {
        finalStatus = outcome.status ?? outcome.resultEnvelope?.data?.status ?? "completed";
        resultEnvelope = outcome.resultEnvelope;
      } else {
        const finishedAtMs = now();
        const text =
          typeof outcome === "string"
            ? outcome
            : outcome !== undefined && outcome !== null
              ? JSON.stringify(outcome, null, 2)
              : null;
        resultEnvelope = buildFallbackResultEnvelope({
          taskEnvelope,
          status: "completed",
          startedAtMs,
          finishedAtMs,
          error: null,
          outputText: text,
        });
      }

      if (!runEntry.cancelled && (finalStatus === "interrupted" || signal?.aborted)) {
        aborted = true;
        finalStatus = "interrupted";
      }
    } catch (error) {
      const finishedAtMs = now();
      aborted = !runEntry.cancelled && (error?.name === "AbortError" || Boolean(signal?.aborted));
      finalStatus = aborted ? "interrupted" : "failed";
      resultEnvelope = buildFallbackResultEnvelope({
        taskEnvelope,
        status: finalStatus,
        startedAtMs,
        finishedAtMs,
        error: {
          code: aborted ? "ABORTED" : error?.code ?? "UNEXPECTED_ERROR",
          category: aborted ? "infrastructure" : error?.category ?? "execution",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      clearInterval(heartbeatTimer);
      if (signal) {
        signal.removeEventListener("abort", onWorkerAbort);
      }
      activeRuns.delete(taskId);
    }

    if (runEntry.cancelled) {
      const latest = await taskRepository.findById(taskId).catch(() => null);
      if (!runEntry.cancelledLocally && latest?.status === "cancelled") {
        emitEvent("task.cancelled", { record: latest, previousStatus: "running" });
      }
      logger.log(
        `[worker] Task cancelled during execution id=${taskId} agent=${agent} trace_id=${traceId} span_id=${spanId}`,
      );
      return {
        processed: true,
        aborted: false,
        cancelled: true,
        task: taskEnvelope,
        status: "cancelled",
        result: latest?.result ?? null,
      };
    }

    const finishedAtIso =
      resultEnvelope?.data?.execution?.finished_at ?? new Date(now()).toISOString();

    let persisted;
    try {
      // Do not forward an aborted worker signal here so interrupted status always persists.
      persisted = await taskRepository.finishTask({
        taskId,
        workerId: workerConfig.worker_id,
        attempt: claimed.attempts,
        status: finalStatus,
        resultEnvelope,
        finishedAt: finishedAtIso,
      });
    } catch (finishError) {
      logger.error(
        `[worker] Failed to persist task result id=${taskId} status=${finalStatus}:`,
        finishError instanceof Error ? finishError.message : String(finishError),
      );
      if (aborted) {
        return {
          processed: false,
          aborted: true,
          task: taskEnvelope,
          status: finalStatus,
          result: resultEnvelope,
        };
      }
      throw finishError;
    }

    if (!persisted) {
      const latest = await taskRepository.findById(taskId).catch(() => null);
      if (latest?.status === "cancelled") {
        if (!runEntry.cancelledLocally) {
          emitEvent("task.cancelled", { record: latest, previousStatus: "running" });
        }
        return {
          processed: true,
          aborted: false,
          cancelled: true,
          task: taskEnvelope,
          status: "cancelled",
          result: latest.result ?? null,
        };
      }
    }

    const durationMs = Math.max(0, now() - startedAtMs);
    const resultFile = resultEnvelope?.data?.artifacts?.result_file ?? null;
    logger.log(
      `[worker] Finished task id=${taskId} agent=${agent} status=${finalStatus} durationMs=${durationMs} resultFile=${resultFile} trace_id=${traceId} span_id=${spanId}`,
    );
    emitEvent("task.finished", {
      record: persisted,
      status: finalStatus,
      result: resultEnvelope,
    });

    return {
      processed: !aborted,
      aborted,
      task: taskEnvelope,
      status: finalStatus,
      result: resultEnvelope,
    };
  }

  async function cancelTask(id) {
    const record = await taskRepository.findById(id);
    if (!record) {
      throw new NotFoundError(`Task not found: ${id}`);
    }
    if (record.status !== "queued" && record.status !== "running") {
      throw new ConflictError(
        `Task ${id} cannot be cancelled from status "${record.status}"`,
      );
    }

    const finishedAtMs = now();
    const startedAtMs = record.started_at ? Date.parse(record.started_at) : null;
    const resultEnvelope = buildFallbackResultEnvelope({
      taskEnvelope: record.task,
      status: "cancelled",
      startedAtMs,
      finishedAtMs,
      workerIdOverride: record.worker_id ?? null,
      error: {
        code: "CANCELLED",
        category: "user",
        message: "Task cancelled by user",
      },
    });

    const cancelled = await taskRepository.cancelTask({
      taskId: id,
      resultEnvelope,
      finishedAt: resultEnvelope.data.execution.finished_at,
    });
    if (!cancelled) {
      throw new ConflictError(`Task ${id} could not be cancelled (status changed)`);
    }

    const active = activeRuns.get(id);
    if (active) {
      active.cancelled = true;
      active.cancelledLocally = true;
      active.controller.abort();
    }

    logger.log(`[task] Cancelled task id=${id} previousStatus=${record.status}`);
    emitEvent("task.cancelled", { record: cancelled, previousStatus: record.status });
    return cancelled;
  }

  async function retryTask(id, { traceparent = null } = {}) {
    const record = await taskRepository.findById(id);
    if (!record) {
      throw new NotFoundError(`Task not found: ${id}`);
    }
    if (record.status === "queued" || record.status === "running") {
      throw new ConflictError(
        `Task ${id} cannot be retried while status is "${record.status}"`,
      );
    }

    const origData = record.task?.data ?? {};
    return createTask({
      title: origData.title,
      description: origData.description,
      parent_id: record.id,
      priority: origData.priority ?? record.priority,
      execution: structuredClone(origData.execution ?? { agent: record.agent }),
      skipSubtaskLimits: true,
      traceparent,
    });
  }

  return {
    createTask,
    getTask,
    listTasks,
    cancelTask,
    retryTask,
    getStats,
    getCapabilities,
    processNextTask,
    subscribe,
  };
}
