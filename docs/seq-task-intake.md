# Sequence: Task Intake, Queries & Control

Covers creating tasks (`POST /tasks`, MCP `create_task`, Telegram Draft Card or `/run`), inspecting/listing tasks, cancelling (`POST /tasks/:id/cancel`, MCP `cancel_task`, `/cancel`), and retrying (`POST /tasks/:id/retry`, MCP `retry_task`, `/retry`).

## Intake & Control Flow

```mermaid
sequenceDiagram
  autonumber
  participant C as "HTTP / MCP / Telegram"
  participant T as "Transport"
  participant H as Task Handler
  participant U as Task Usecase
  participant R as Task Repository
  participant DB as "Supabase tasks"

  C->>T: Create task (or Telegram Draft Card / /run)
  T->>H: Forward plain payload + traceparent
  H->>H: Validate fields & supported agent (agy | claude | codex)
  H->>U: createTask(...)
  U->>U: Generate UUID v7, OTel trace/span, v1 envelope
  U->>R: create(input_envelope)
  R->>DB: Insert row (status = queued)
  DB-->>R: Persisted row
  U-->>T: Emit task.created & return v1 Input Envelope
  T-->>C: 201 Created / MCP result / Telegram queued card

  Note over C,DB: Read, Cancel & Retry Flows
  C->>T: Get, list, cancel, or retry task
  T->>H: Validate UUID v7 or query filters
  H->>U: getTask / listTasks / cancelTask / retryTask
  U->>R: Select or conditional PATCH / insert linked child
  R-->>C: Record, list, cancelled row, or new child task
```

## Intake & Control Rules

| Rule | Behavior |
| --- | --- |
| **Client-owned fields** | Client chooses `priority` (`P0`–`P3`), `execution.agent`, and optional `model`, `effort`, `cwd`, `permission_mode`, `timeout_ms`, `session_id` |
| **Telegram intake** | Paired single-owner DM (`user_id` + `chat_id`) opens a 1-tap Draft Card or enqueues via `/run`; unauthorized users/chats are ignored |
| **Server-generated fields** | Service generates `data.id` (UUID v7), UTC timestamps, and `trace_id`/`span_id` (propagating `traceparent` if present) |
| **Cancel & retry semantics** | `cancelTask` transitions `queued` or `running` to `cancelled`; `retryTask` enqueues a new task with `parent_id` from any terminal status |
| **Error mapping** | Invalid input returns `400`/`-32602`; missing ID returns `404`/tool error; invalid state transition returns `409`/tool error; DB failure returns `502` |
