# Sequence: Recovery, Breakdown & HITL

Covers task terminal states, failure and lease-expiry handling, graceful shutdown, subtask decomposition via `parent_id`, and session continuation via `session_id`.

## Task State Machine

```mermaid
stateDiagram-v2
  [*] --> queued: Created via HTTP or MCP
  queued --> running: Claimed by matching worker
  running --> completed: Agent exit 0 without reported error
  running --> failed: Policy rejection, spawn error, or non-zero exit
  running --> timeout: Outer execution timeout exceeded
  running --> interrupted: Worker shutdown signal or expired lease
  completed --> [*]
  failed --> [*]
  timeout --> [*]
  interrupted --> [*]
```

## Subtask Breakdown & HITL Resume

```mermaid
sequenceDiagram
  autonumber
  participant Parent as Parent Agent Run
  participant MCP as "MCP Server (/mcp)"
  participant DB as "Supabase tasks"
  participant Client as "Human / Orchestrator"
  participant Worker as Worker

  opt Task too large -> decompose
    Parent->>MCP: Call create_task with parent_id = current task_id
    MCP->>DB: Enqueue child task (status = queued)
  end
  Parent-->>DB: Complete run (persist session_id in result_envelope)
  Client->>MCP: Call get_task to inspect result & open questions
  Client->>MCP: Call create_task with parent_id and execution.session_id
  Worker->>DB: Claim follow-up task
  Worker->>Worker: Resume previous agent session using session_id
```

## Failure & Recovery Semantics

| Scenario | Final Status | Replay Policy & Notes |
| --- | --- | --- |
| **Pre-spawn policy failure** | `failed` | Writes `result.json` with error category `permission` or `validation`; no retry |
| **CLI non-zero / spawn error** | `failed` | Never blindly replayed after spawn to protect workspace from partial edits |
| **Outer timeout exceeded** | `timeout` | Sends `SIGTERM` (5s `SIGKILL` fallback) and persists `EXECUTION_TIMEOUT` |
| **Graceful shutdown (`SIGINT`/`SIGTERM`)** | `interrupted` | Aborts child process and persists `interrupted` without forwarding abort signal to DB write |
| **Worker crash (lease expired)** | `interrupted` | Next `claim_next_task` call transitions stale `running` rows to `interrupted` (`LEASE_EXPIRED`) |
