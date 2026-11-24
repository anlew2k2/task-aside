# Sequence: Recovery, Breakdown & HITL

Covers task terminal states, failure, cancellation, retry, attempt fencing, lease-expiry handling, graceful shutdown, subtask guardrails, and session continuation via `session_id` or Telegram Swipe-Reply.

## 1. Task State Machine

```mermaid
stateDiagram-v2
  [*] --> queued: Created (HTTP, MCP, STDIO, Telegram)
  queued --> running: Claimed by worker
  queued --> cancelled: User cancel
  running --> completed: Exit 0 without error
  running --> failed: Policy, spawn, or non-zero exit
  running --> timeout: Outer timeout exceeded
  running --> interrupted: Shutdown or expired lease
  running --> cancelled: User cancel (local or heartbeat)
  completed --> [*]
  failed --> [*]
  timeout --> [*]
  interrupted --> [*]
  cancelled --> [*]
```

## 2. Agent Subtask Breakdown

```mermaid
sequenceDiagram
  autonumber
  participant P as Parent Agent Run
  participant Core as "HTTP / MCP"
  participant DB as "Supabase tasks"

  P->>Core: Create child task with parent_id = current task_id
  Core->>DB: Validate depth <= max_subtask_depth & count < max_subtasks_per_root
  Core->>DB: Enqueue child task (status = queued)
```

## 3. HITL Session Resume

```mermaid
sequenceDiagram
  autonumber
  participant H as "Human / Orchestrator"
  participant Core as "API / Telegram"
  participant DB as "Supabase tasks"
  participant W as Worker

  DB-->>H: Completed task persists session_id in result_envelope
  H->>Core: Inspect result or swipe-reply in Telegram
  Core->>DB: Extract UUID v7, load original task & enqueue follow-up (parent_id + session_id)
  W->>DB: Claim follow-up & resume previous agent session
```

## Failure, Cancel & Recovery Semantics

| Scenario | Final Status | Replay Policy & Notes |
| --- | --- | --- |
| **Pre-spawn policy / worktree failure** | `failed` | Writes redacted `result.json` with `permission`, `validation`, or `environment` error; no auto-retry |
| **CLI non-zero / spawn error** | `failed` | Never auto-replayed after spawn; human-triggered `retry` creates a new linked task |
| **Outer timeout exceeded** | `timeout` | Sends `SIGTERM` (5s `SIGKILL` fallback) and persists `EXECUTION_TIMEOUT` |
| **Graceful shutdown (`SIGINT`/`SIGTERM`)** | `interrupted` | Aborts child process and persists `interrupted` without aborting DB write |
| **Worker crash / stale attempt** | `interrupted` | `claim_next_task` expires stale leases; `attempts` fencing stops stale workers overwriting newer runs |
| **Subtask limits & Retry** | `queued` / `cancelled` | `createTask` enforces `max_subtask_depth` and `max_subtasks_per_root`; `retryTask` is exempt so retries never fail on depth |
