# System Architecture

`task-aside` is a single-process, zero-dependency Node/Bun service combining HTTP/MCP/Telegram transports and a sequential background worker backed by Supabase Postgres/PostgREST and headless CLI agents (`agy`, `claude`, `codex`).

## Component Overview

```mermaid
flowchart LR
  Clients["HTTP, MCP & Telegram Clients"] --> Transports["Transports (http, mcp, telegram, worker)"]
  Transports --> Handlers["Handlers (task, health)"]
  Handlers --> Usecases["Usecases (task + event pub/sub)"]
  Usecases --> AgentSvc["Agent Service (agy, claude, codex)"]
  Usecases --> TaskRepo["Task Repository (Supabase REST & RPC)"]
  TaskRepo <--> Supabase[("Supabase public.tasks")]
  AgentSvc --> RunsDir["~/.task-aside/runs/"]
  Transports -.-> Settings["~/.task-aside/settings.json"]
  Transports -.-> LogsDir["~/.task-aside/logs/"]
```

## Layer & Storage Boundaries

| Area | Responsibility | Constraints |
| --- | --- | --- |
| `transports/` | HTTP routes, JSON-RPC MCP, Telegram long polling, worker loop | Calls `handlers/` only; never touches DB or agent CLIs |
| `handlers/` | Input validation, event subscription forwarding, typed errors | Transport-agnostic; calls `usecases/` only |
| `usecases/` | Task orchestration, cancel/retry, lease heartbeat, event pub/sub | Calls `services/` and `repositories/` only |
| `services/` | Policy checks, prompt rendering, headless CLI dispatch, artifact capture | No shell interpolation; writes run artifacts locally |
| `repositories/` | Supabase PostgREST + RPC queries and in-memory test adapter | Async boundary; single source of queue & result state |
| `~/.task-aside/` | Global `settings.json`, daily `logs/`, per-run `runs/` | Auto-created on startup; replaces project `.env` files |
| `public.tasks` | Distributed queue, state, `input_envelope`, and `result_envelope` | Atomic claim via `claim_next_task`; lease via `extend_task_lease` |

## Core Contracts & Config

- **Input Envelope (`v1`)**: Carries `schema`, OTel `metadata` (`trace_id`, `span_id`, timestamps), and `data` (`id`, `title`, `description`, `parent_id`, `priority`, and client-selected `execution` config).
- **Result Envelope (`v1` / `task_result`)**: Mirrors the input envelope shape with propagated `trace_id` and `parent_span_id`, plus `status`, effective `execution` details, Markdown `output`, token/cost `usage`, local `artifacts` paths, and structured `error`.
- **Telegram Settings**: Configured via `transports.telegram` and `telegram` (`bot_token`, `user_id`, `chat_id` paired via `task-aside auth telegram`, defaults, named `workspaces` aliases, polling timeout); Core and `public.tasks` store zero Telegram state.
- **Worker Policies**: Enforced per worker via `allowed_agents`, `default_permission_mode`, `max_permission_mode`, `allowed_cwd_roots`, and `default_timeout_ms`.

## Sequence Flows

| Document | Scope |
| --- | --- |
| [seq-task-intake.md](./seq-task-intake.md) | Creating, fetching, listing, cancelling, and retrying tasks over HTTP, MCP, and Telegram |
| [seq-worker-execution.md](./seq-worker-execution.md) | Polling, atomic claim, heartbeat, lifecycle events, CLI execution, and artifacts |
| [seq-recovery-and-hitl.md](./seq-recovery-and-hitl.md) | State machine, cancel/retry, lease expiry, shutdown, subtask breakdown, and HITL resume |
