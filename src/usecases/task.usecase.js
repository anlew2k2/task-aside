import { NotFoundError } from "#src/utilities/errors.js";
import { createTraceContext } from "#src/utilities/otel.js";
import { generateUuidV7 } from "#src/utilities/uuid.js";
import { TASK_RESULT_SCHEMA_TYPE, TASK_SCHEMA_VERSION } from "#src/utilities/validation.js";

/**
 * Task business logic usecase.
 * Orchestrates task creation, Supabase persistence, sequential worker claiming, and headless execution.
 */
export function createTaskUsecase({
  taskRepository,
  agentService = null,
  executeTask = null,
  workerConfig,
  now = () => Date.now(),
  generateId = generateUuidV7,
  createTrace = createTraceContext,
  logger = console,
}) {
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
  }) {
    const taskData = taskEnvelope?.data ?? {};
    const taskMeta = taskEnvelope?.metadata ?? {};
    const execReq = taskData.execution ?? {};
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
          agent: execReq.agent ?? null,
          worker_id: workerConfig.worker_id,
          requested_model: execReq.model ?? null,
          effective_model: null,
          effort: execReq.effort ?? null,
          cwd: execReq.cwd ?? workerConfig.default_cwd ?? null,
          permission_mode: execReq.permission_mode ?? workerConfig.default_permission_mode ?? null,
          enforcement: null,
          session_id: execReq.session_id ?? null,
          exit_code: null,
          started_at: new Date(startedAtMs).toISOString(),
          finished_at: createdAt,
          duration_ms: Math.max(0, finishedAtMs - startedAtMs),
        },
        output: {
          format: "markdown",
          text: outputText,
        },
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        },
        artifacts: null,
        error,
      },
    };
  }

  async function createTask({
    title,
    description,
    parent_id = null,
    priority,
    execution,
    traceparent = null,
    trace_id = null,
    span_id = null,
  }) {
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

    await taskRepository.create(taskMessage);
    logger.log(
      `[task] Enqueued task id=${taskMessage.data.id} agent=${execution.agent} priority=${priority} title=${JSON.stringify(title)} trace_id=${traceId} span_id=${spanId}`,
    );

    return taskMessage;
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

    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || signal?.aborted) {
        return;
      }
      heartbeatInFlight = true;
      void taskRepository
        .extendLease({
          taskId,
          workerId: workerConfig.worker_id,
          leaseSeconds: workerConfig.lease_seconds,
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
        signal,
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

      if (finalStatus === "interrupted" || signal?.aborted) {
        aborted = true;
        finalStatus = "interrupted";
      }
    } catch (error) {
      const finishedAtMs = now();
      aborted = error?.name === "AbortError" || Boolean(signal?.aborted);
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
    }

    const finishedAtIso =
      resultEnvelope?.data?.execution?.finished_at ?? new Date(now()).toISOString();

    try {
      // Do not forward an aborted worker signal here so interrupted status always persists.
      await taskRepository.finishTask({
        taskId,
        workerId: workerConfig.worker_id,
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

    const durationMs = Math.max(0, now() - startedAtMs);
    const resultFile = resultEnvelope?.data?.artifacts?.result_file ?? null;
    logger.log(
      `[worker] Finished task id=${taskId} agent=${agent} status=${finalStatus} durationMs=${durationMs} resultFile=${resultFile} trace_id=${traceId} span_id=${spanId}`,
    );

    return {
      processed: !aborted,
      aborted,
      task: taskEnvelope,
      status: finalStatus,
      result: resultEnvelope,
    };
  }

  return {
    createTask,
    getTask,
    listTasks,
    getStats,
    processNextTask,
  };
}
