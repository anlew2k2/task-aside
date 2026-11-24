import { StorageError } from "../utilities/errors.js";
import { TASK_STATUSES } from "../utilities/validation.js";

const PRIORITY_RANK = Object.freeze({
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
});

function emptyStatusCounts() {
  const counts = { total: 0 };
  for (const status of TASK_STATUSES) {
    counts[status] = 0;
  }
  return counts;
}

function mapRowToTaskRecord(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    parent_id: row.parent_id ?? null,
    priority: row.priority,
    agent: row.agent,
    status: row.status,
    worker_id: row.worker_id ?? null,
    attempts: row.attempts ?? 0,
    lease_expires_at: row.lease_expires_at ?? null,
    trace_id: row.trace_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    task: structuredClone(row.input_envelope),
    result: row.result_envelope ? structuredClone(row.result_envelope) : null,
  };
}

function extractSupabaseErrorMessage(payload, status) {
  if (payload && typeof payload === "object") {
    const parts = [payload.message, payload.details, payload.hint, payload.error_description, payload.error]
      .filter((part) => typeof part === "string" && part.trim() !== "");
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }
  return `HTTP ${status}`;
}

function buildExpiredLeaseEnvelope(record, nowIso) {
  const input = record.task;
  return {
    schema: {
      version: "v1",
      type: "task_result",
    },
    metadata: {
      created_at: nowIso,
      updated_at: nowIso,
      trace_id: record.trace_id ?? input?.metadata?.trace_id ?? null,
      span_id: null,
      parent_span_id: input?.metadata?.span_id ?? null,
    },
    data: {
      id: record.id,
      task_id: record.id,
      parent_id: record.parent_id ?? null,
      status: "interrupted",
      execution: {
        agent: record.agent,
        worker_id: record.worker_id ?? null,
        requested_model: input?.data?.execution?.model ?? null,
        effective_model: null,
        effort: input?.data?.execution?.effort ?? null,
        cwd: input?.data?.execution?.cwd ?? null,
        permission_mode: input?.data?.execution?.permission_mode ?? null,
        enforcement: null,
        session_id: input?.data?.execution?.session_id ?? null,
        exit_code: null,
        started_at: record.started_at ?? null,
        finished_at: nowIso,
        duration_ms:
          record.started_at !== null
            ? Math.max(0, Date.parse(nowIso) - Date.parse(record.started_at))
            : null,
      },
      output: {
        format: "markdown",
        text: null,
      },
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_cost_usd: null,
      },
      artifacts: null,
      error: {
        code: "LEASE_EXPIRED",
        category: "infrastructure",
        message: "Worker lease expired before completion",
      },
    },
  };
}

/**
 * Supabase PostgREST + Postgres RPC task repository.
 */
export function createSupabaseTaskRepository({
  url,
  publishableKey,
  schema = "public",
  table = "tasks",
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new StorageError("Fetch implementation is required for Supabase task repository");
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new StorageError("Supabase URL is required");
  }
  if (typeof publishableKey !== "string" || publishableKey.trim() === "") {
    throw new StorageError("Supabase publishable key is required");
  }

  const baseUrl = url.replace(/\/+$/, "");
  const encodedTable = encodeURIComponent(table);

  async function request(path, { method = "GET", headers = {}, body = undefined, signal } = {}) {
    const requestHeaders = {
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
      "content-type": "application/json",
      ...(schema !== "public"
        ? {
            "Accept-Profile": schema,
            "Content-Profile": schema,
          }
        : {}),
      ...headers,
    };

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new StorageError(
        `Supabase network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const detailMessage = extractSupabaseErrorMessage(payload, response.status);
      throw new StorageError(`Supabase request failed: ${detailMessage}`, {
        statusCode: response.status,
        details: payload,
      });
    }

    return payload;
  }

  async function create(taskEnvelope) {
    const row = {
      id: taskEnvelope.data.id,
      parent_id: taskEnvelope.data.parent_id ?? null,
      priority: taskEnvelope.data.priority,
      agent: taskEnvelope.data.execution.agent,
      status: "queued",
      input_envelope: taskEnvelope,
      trace_id: taskEnvelope.metadata.trace_id,
      created_at: taskEnvelope.metadata.created_at,
      updated_at: taskEnvelope.metadata.updated_at,
    };

    const payload = await request(`/rest/v1/${encodedTable}`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: row,
    });

    const created = Array.isArray(payload) ? payload[0] : payload;
    return mapRowToTaskRecord(created);
  }

  async function findById(id) {
    const payload = await request(
      `/rest/v1/${encodedTable}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
      { method: "GET" },
    );
    const row = Array.isArray(payload) ? payload[0] : payload;
    return mapRowToTaskRecord(row ?? null);
  }

  async function findAll({
    status = null,
    agent = null,
    parent_id = undefined,
    limit = 50,
    offset = 0,
  } = {}) {
    const params = new URLSearchParams();
    params.set("select", "*");
    params.set("order", "created_at.desc");
    params.set("limit", String(limit));
    params.set("offset", String(offset));

    if (status) {
      params.set("status", `eq.${status}`);
    }
    if (agent) {
      params.set("agent", `eq.${agent}`);
    }
    if (parent_id === null) {
      params.set("parent_id", "is.null");
    } else if (typeof parent_id === "string" && parent_id !== "") {
      params.set("parent_id", `eq.${parent_id}`);
    }

    const payload = await request(`/rest/v1/${encodedTable}?${params.toString()}`, {
      method: "GET",
    });

    return Array.isArray(payload) ? payload.map(mapRowToTaskRecord) : [];
  }

  async function claimNext({ allowedAgents, workerId, leaseSeconds = 120, signal } = {}) {
    const payload = await request("/rest/v1/rpc/claim_next_task", {
      method: "POST",
      body: {
        p_allowed_agents: allowedAgents,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      },
      signal,
    });

    const row = Array.isArray(payload) ? payload[0] : payload;
    return mapRowToTaskRecord(row ?? null);
  }

  async function extendLease({ taskId, workerId, leaseSeconds = 120 } = {}) {
    const payload = await request("/rest/v1/rpc/extend_task_lease", {
      method: "POST",
      body: {
        p_task_id: taskId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      },
    });
    return Boolean(payload);
  }

  async function finishTask({ taskId, workerId, status, resultEnvelope, finishedAt } = {}) {
    const params = new URLSearchParams();
    params.set("id", `eq.${taskId}`);
    params.set("worker_id", `eq.${workerId}`);

    const payload = await request(`/rest/v1/${encodedTable}?${params.toString()}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        status,
        result_envelope: resultEnvelope,
        lease_expires_at: null,
        finished_at: finishedAt,
        updated_at: finishedAt,
      },
    });

    const row = Array.isArray(payload) ? payload[0] : payload;
    return mapRowToTaskRecord(row ?? null);
  }

  async function deleteById(id) {
    await request(`/rest/v1/${encodedTable}?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async function stats() {
    const payload = await request(`/rest/v1/${encodedTable}?select=status`, {
      method: "GET",
    });
    const counts = emptyStatusCounts();
    if (Array.isArray(payload)) {
      for (const row of payload) {
        counts.total += 1;
        if (typeof row?.status === "string" && row.status in counts) {
          counts[row.status] += 1;
        }
      }
    }
    return {
      provider: "supabase",
      table,
      counts,
    };
  }

  return {
    create,
    findById,
    findAll,
    claimNext,
    extendLease,
    finishTask,
    deleteById,
    stats,
  };
}

/**
 * In-memory task repository matching the Supabase repository contract for unit/E2E tests.
 */
export function createInMemoryTaskRepository({ now = () => Date.now() } = {}) {
  const tasks = new Map();

  function cloneRecord(record) {
    return record ? structuredClone(record) : null;
  }

  async function create(taskEnvelope) {
    const record = {
      id: taskEnvelope.data.id,
      parent_id: taskEnvelope.data.parent_id ?? null,
      priority: taskEnvelope.data.priority,
      agent: taskEnvelope.data.execution.agent,
      status: "queued",
      worker_id: null,
      attempts: 0,
      lease_expires_at: null,
      trace_id: taskEnvelope.metadata.trace_id,
      created_at: taskEnvelope.metadata.created_at,
      updated_at: taskEnvelope.metadata.updated_at,
      started_at: null,
      finished_at: null,
      task: structuredClone(taskEnvelope),
      result: null,
    };
    tasks.set(record.id, record);
    return cloneRecord(record);
  }

  async function findById(id) {
    return cloneRecord(tasks.get(id) ?? null);
  }

  async function findAll({
    status = null,
    agent = null,
    parent_id = undefined,
    limit = 50,
    offset = 0,
  } = {}) {
    const filtered = Array.from(tasks.values())
      .filter((record) => {
        if (status && record.status !== status) {
          return false;
        }
        if (agent && record.agent !== agent) {
          return false;
        }
        if (parent_id === null && record.parent_id !== null) {
          return false;
        }
        if (typeof parent_id === "string" && parent_id !== "" && record.parent_id !== parent_id) {
          return false;
        }
        return true;
      })
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    return filtered.slice(offset, offset + limit).map(cloneRecord);
  }

  async function claimNext({ allowedAgents = [], workerId, leaseSeconds = 120 } = {}) {
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    for (const record of tasks.values()) {
      if (
        record.status === "running" &&
        record.lease_expires_at &&
        Date.parse(record.lease_expires_at) < nowMs
      ) {
        record.status = "interrupted";
        record.finished_at = nowIso;
        record.updated_at = nowIso;
        record.lease_expires_at = null;
        if (!record.result) {
          record.result = buildExpiredLeaseEnvelope(record, nowIso);
        }
      }
    }

    const candidates = Array.from(tasks.values())
      .filter((record) => record.status === "queued" && allowedAgents.includes(record.agent))
      .sort((a, b) => {
        const prioDiff = (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99);
        if (prioDiff !== 0) {
          return prioDiff;
        }
        return Date.parse(a.created_at) - Date.parse(b.created_at);
      });

    const next = candidates[0];
    if (!next) {
      return null;
    }

    const leaseMs = Math.max(leaseSeconds, 10) * 1000;
    next.status = "running";
    next.worker_id = workerId;
    next.attempts += 1;
    next.started_at = next.started_at ?? nowIso;
    next.updated_at = nowIso;
    next.lease_expires_at = new Date(nowMs + leaseMs).toISOString();

    return cloneRecord(next);
  }

  async function extendLease({ taskId, workerId, leaseSeconds = 120 } = {}) {
    const record = tasks.get(taskId);
    if (!record || record.status !== "running" || record.worker_id !== workerId) {
      return false;
    }
    const nowMs = now();
    const leaseMs = Math.max(leaseSeconds, 10) * 1000;
    record.lease_expires_at = new Date(nowMs + leaseMs).toISOString();
    record.updated_at = new Date(nowMs).toISOString();
    return true;
  }

  async function finishTask({ taskId, workerId, status, resultEnvelope, finishedAt } = {}) {
    const record = tasks.get(taskId);
    if (!record || record.worker_id !== workerId) {
      return null;
    }
    record.status = status;
    record.result = structuredClone(resultEnvelope);
    record.lease_expires_at = null;
    record.finished_at = finishedAt;
    record.updated_at = finishedAt;
    return cloneRecord(record);
  }

  async function deleteById(id) {
    tasks.delete(id);
  }

  async function stats() {
    const counts = emptyStatusCounts();
    for (const record of tasks.values()) {
      counts.total += 1;
      if (record.status in counts) {
        counts[record.status] += 1;
      }
    }
    return {
      provider: "in-memory",
      table: "tasks",
      counts,
    };
  }

  return {
    create,
    findById,
    findAll,
    claimNext,
    extendLease,
    finishTask,
    deleteById,
    stats,
  };
}
