# Sequence: Task Intake & Queries

Covers creating tasks (`POST /tasks`, MCP `create_task`), inspecting a task (`GET /tasks/:id`, MCP `get_task`), and listing tasks (`GET /tasks`, MCP `list_tasks`).

## Intake & Query Flow

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant T as "HTTP / MCP Transport"
  participant H as Task Handler
  participant U as Task Usecase
  participant R as Task Repository
  participant DB as "Supabase tasks"

  C->>T: Create task (title, description, priority, execution, parent_id?)
  T->>H: Forward plain payload + traceparent
  H->>H: Validate fields & supported agent (agy | claude | codex)
  H->>U: createTask(...)
  U->>U: Generate UUID v7, OTel trace/span, v1 envelope
  U->>R: create(input_envelope)
  R->>DB: Insert row (status = queued)
  DB-->>R: Persisted row
  R-->>U: Task record
  U-->>T: v1 Input Envelope
  T-->>C: 201 Created / MCP result

  Note over C,DB: Read & List Flows
  C->>T: Get task by ID or list with filters
  T->>H: Validate UUID v7 or query filters
  H->>U: getTask(id) / listTasks(filters)
  U->>R: findById(id) / findAll(filters)
  R->>DB: Select from public.tasks
  DB-->>C: Task record with status & result_envelope (or 404 / error)
```

## Intake Rules

| Rule | Behavior |
| --- | --- |
| **Client-owned fields** | Client chooses `priority` (`P0`–`P3`), `execution.agent`, and optional `model`, `effort`, `cwd`, `permission_mode`, `timeout_ms`, `session_id` |
| **Server-generated fields** | Service always generates `data.id` (UUID v7), UTC timestamps, and `trace_id`/`span_id` (propagating `traceparent` if present) |
| **Allowlist boundary** | HTTP/MCP validates that `execution.agent` is a supported harness; worker-specific `allowed_agents` is enforced at claim time |
| **Error mapping** | Invalid input returns HTTP `400` / JSON-RPC `-32602`; missing ID returns `404` / MCP tool error; Supabase failure returns `502` / MCP tool error |
