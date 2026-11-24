# Sequence: Recovery, Breakdown & HITL

Covers task terminal states, failure, cancellation, retry, lease-expiry handling, graceful shutdown, subtask decomposition via `parent_id`, and session continuation via `session_id` or Telegram Reply-to-Resume.

## Task State Machine

```mermaid
stateDiagram-v2
  [*] --> queued: Created via HTTP, MCP, or Telegram
  queued --> running: Claimed by matching worker
  queued --> cancelled: User cancel
  running --> completed: Agent exit 0 without reported error
  running --> failed: Policy rejection, spawn error, or non-zero exit
  running --> timeout: Outer execution timeout exceeded
  running --> interrupted: Worker shutdown signal or expired lease
  running --> cancelled: User cancel (local or via heartbeat)
  completed --> [*]
  failed --> [*]
  timeout --> [*]
  interrupted --> [*]
  cancelled --> [*]
```

## Subtask Breakdown & HITL Resume

```mermaid
sequenceDiagram
  autonumber
  participant Parent as Parent Agent Run
  participant Core as "HTTP / MCP / Telegram"
  participant DB as "Supabase tasks"
  participant Human as "Human / Orchestrator"
  participant Worker as Worker

  opt Task too large -> decompose
    Parent->>Core: Create child task with parent_id = current task_id
    Core->>DB: Enqueue child task (status = queued)
  end
  Parent-->>DB: Complete run (persist session_id in result_envelope)
  Human->>Core: Inspect result or swipe-reply in Telegram
  Core->>Core: Parse UUID v7 from replied message & load original task
  Core->>DB: Enqueue follow-up with parent_id + inherited execution & session_id
  Worker->>DB: Claim follow-up task and resume previous agent session
```

## Failure, Cancel & Recovery Semantics

| Scenario | Final Status | Replay Policy & Notes |
| --- | --- | --- |
| **Pre-spawn policy failure** | `failed` | Writes `result.json` with `permission` or `validation` error; no automatic retry |
| **CLI non-zero / spawn error** | `failed` | Never auto-replayed after spawn; human-triggered `retry` creates a new linked task |
| **Outer timeout exceeded** | `timeout` | Sends `SIGTERM` (5s `SIGKILL` fallback) and persists `EXECUTION_TIMEOUT` |
| **Graceful shutdown (`SIGINT`/`SIGTERM`)** | `interrupted` | Aborts child process and persists `interrupted` without aborting DB write |
| **Worker crash (lease expired)** | `interrupted` | Next `claim_next_task` call transitions stale `running` rows to `interrupted` (`LEASE_EXPIRED`) |
| **Human cancellation / Retry** | `cancelled` | `cancel` aborts active run and locks status; `retry` creates a fresh child row via `parent_id` |
