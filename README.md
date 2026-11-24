# task-aside

Minimal, zero-dependency CLI exposing **1 HTTP/MCP server** and **1 sequential background worker** backed by Supabase Postgres/PostgREST, executing tasks via headless agent CLIs (`agy`, `claude`, `codex`), ready to run directly with Node or Bun.

## Global Settings (`~/.task-aside/settings.json`)

On startup, `task-aside` reads `~/.task-aside/settings.json` (or the path passed via `-c, --config`). If the file does not exist, it is created automatically with defaults (`0o600`). Logs, per-run artifacts, and settings all live under `~/.task-aside/` by default.

Key groups in `~/.task-aside/settings.json`:

- `server`: `{ "host": "127.0.0.1", "port": 3100 }`
- `transports`: `{ "http": true, "mcp": true, "worker": true, "telegram": false }`
- `allowed_workspaces`: Required non-empty array of allowed workspace root paths (all subdirectories are permitted; the first entry is used as the default working directory when a task omits `execution.cwd`, and interactive CLI startup prompts you to enter at least one path—such as `~`—if empty)
- `supabase`: `{ "url": "https://<project>.supabase.co", "publishable_key": "<key>", "schema": "public", "table": "tasks" }`
- `telegram`:
  - `bot_token`: Telegram Bot API token (required when `transports.telegram` is `true`)
  - `user_id`: Paired Telegram sender user ID (set automatically by `task-aside auth telegram`)
  - `chat_id`: Paired Telegram private chat ID (set automatically by `task-aside auth telegram`)
  - `default_agent`: Default agent for Telegram intake (`null` falls back to first allowed worker agent)
  - `default_priority`: Default task priority (`"P0"`–`"P3"`, default: `"P1"`)
  - `poll_timeout_seconds`: Long-polling timeout in seconds (`1`–`50`, default: `25`)
  - `api_base_url`: Bot API base URL (default: `"https://api.telegram.org"`)
- `logging`: `{ "dir": "~/.task-aside/logs" }`
- `worker`:
  - `worker_id`: Optional worker identifier (`null` defaults to `<hostname>-<pid>`)
  - `poll_interval_ms`: Minimum sequential polling interval (default: `1000`)
  - `poll_max_interval_ms`: Maximum adaptive backoff polling interval when idle (default: `30000`)
  - `lease_seconds`: Task claim lease duration in seconds (default: `120`)
  - `heartbeat_interval_ms`: Lease extension interval in ms (default: `30000`)
  - `runs_dir`: Per-run artifact directory (default: `"~/.task-aside/runs"`)
  - `allowed_agents`: Worker agent allowlist (default: `["agy", "claude", "codex"]`)
  - `default_permission_mode`: Default permission policy (`"read-only" | "workspace" | "full"`, default: `"workspace"`)
  - `max_permission_mode`: Maximum permission policy ceiling allowed by this worker (default: `"workspace"`)
  - `default_timeout_ms`: Default execution timeout in ms (default: `600000`)
  - `max_subtask_depth`: Maximum `parent_id` nesting depth for new subtasks (default: `3`)
  - `max_subtasks_per_root`: Maximum total descendants per root task (default: `20`)
  - `agents`: Per-agent CLI overrides (`agy`, `claude`, `codex` executables, `default_model`/`default_effort` defaulting to `null` to defer to each CLI harness's own defaults, and `codex.skip_git_repo_check`)

## Supabase Schema

Apply `migrations/000001-init-schema.sql` to your Supabase Postgres database before running. It provisions `public.tasks`, `idempotency_key` deduplication, and the `claim_next_task`, attempt-fenced `extend_task_lease`, and `get_task_stats` RPC functions.

## Run

```bash
npx task-aside
# or with Bun
bunx --bun task-aside
```

Local run without installing:

```bash
node ./bin/task-aside.js
# or via make (uses bun dev)
make dev
```

## Options & Commands

- `task-aside mcp [-c <path>]` — Start intake-only STDIO MCP transport (JSON-RPC over stdin/stdout; logs go to files only)
- `task-aside doctor [-c <path>]` — Verify `settings.json`, workspaces, writable directories, Supabase RPCs, and agent binaries
- `task-aside auth telegram [-c <path>]` — Pair your Telegram `user_id` and `chat_id` using a 5-minute `/auth <token>` handshake and enable `transports.telegram`
- `-c, --config <path>` — Path to `settings.json` (default: `~/.task-aside/settings.json`)
- `-p, --port <port>` — HTTP/MCP port (overrides `settings.json` `server.port`)
- `-H, --host <host>` — Bind host (overrides `settings.json` `server.host`)
- `-h, --help` — Show help
- `-v, --version` — Show version

## Task Message Format (`v1`)

Both HTTP (`POST /tasks`) and MCP (`create_task`) validate input, persist the `v1` envelope to Supabase, and return:

```json
{
  "schema": {
    "version": "v1"
  },
  "metadata": {
    "created_at": "2025-11-24T12:23:49.000Z",
    "updated_at": "2025-11-24T12:23:49.000Z",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "00f067aa0ba902b7"
  },
  "data": {
    "id": "01935e8b-0000-7000-8000-000000000000",
    "title": "Task title",
    "description": "## Markdown details",
    "parent_id": null,
    "priority": "P1",
    "execution": {
      "agent": "codex",
      "model": null,
      "effort": "medium",
      "cwd": null,
      "permission_mode": "workspace",
      "timeout_ms": null,
      "session_id": null,
      "worktree": false
    }
  }
}
```

> Both HTTP (`POST /tasks`, via body `idempotency_key` or `Idempotency-Key` header) and MCP (`create_task`) support optional `idempotency_key` deduplication (`200` replay on identical payload, `409` on mismatch). Setting `execution.worktree: true` isolates execution inside a temporary `git worktree` under `~/.task-aside/runs/<id>/worktree`.

## Task Result Envelope (`v1` / `task_result`)

When the worker finishes (or fails/times out/is interrupted), it writes `~/.task-aside/runs/<task_id>/result.json` and persists `result_envelope` to Supabase:

```json
{
  "schema": {
    "version": "v1",
    "type": "task_result"
  },
  "metadata": {
    "created_at": "2025-11-24T12:25:10.000Z",
    "updated_at": "2025-11-24T12:25:10.000Z",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "1a2b3c4d5e6f7a8b",
    "parent_span_id": "00f067aa0ba902b7"
  },
  "data": {
    "id": "01935e8c-0000-7000-8000-000000000000",
    "task_id": "01935e8b-0000-7000-8000-000000000000",
    "parent_id": null,
    "status": "completed",
    "execution": {
      "agent": "codex",
      "worker_id": "host-1234",
      "requested_model": null,
      "effective_model": "gpt-5",
      "effort": "medium",
      "cwd": "/path/to/repo",
      "permission_mode": "workspace",
      "enforcement": "sandbox",
      "session_id": "thread_123",
      "exit_code": 0,
      "started_at": "2025-11-24T12:23:50.000Z",
      "finished_at": "2025-11-24T12:25:10.000Z",
      "duration_ms": 80000
    },
    "output": {
      "format": "markdown",
      "text": "Completed the task."
    },
    "usage": {
      "input_tokens": 1200,
      "output_tokens": 350,
      "total_cost_usd": null
    },
    "artifacts": {
      "run_dir": "~/.task-aside/runs/01935e8b-0000-7000-8000-000000000000",
      "prompt_file": "~/.task-aside/runs/01935e8b-0000-7000-8000-000000000000/prompt.md",
      "result_file": "~/.task-aside/runs/01935e8b-0000-7000-8000-000000000000/result.json",
      "raw_output_file": "~/.task-aside/runs/01935e8b-0000-7000-8000-000000000000/events.jsonl",
      "log_file": "~/.task-aside/runs/01935e8b-0000-7000-8000-000000000000/agent.log"
    },
    "error": null
  }
}
```

## Endpoints & MCP Tools

```bash
curl -s http://127.0.0.1:3100/health

curl -s -X POST http://127.0.0.1:3100/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Demo task","description":"**Markdown** body","parent_id":null,"priority":"P1","execution":{"agent":"codex"}}'

curl -s 'http://127.0.0.1:3100/tasks?status=completed&limit=20'
curl -s http://127.0.0.1:3100/tasks/<uuid-v7>
curl -s -X POST http://127.0.0.1:3100/tasks/<uuid-v7>/cancel
curl -s -X POST http://127.0.0.1:3100/tasks/<uuid-v7>/retry
```

Built-in MCP tools:

- `create_task` — create a task (`title`, `description`, `priority`, `execution`, optional `parent_id`, `idempotency_key`, `execution.worktree`); returns `poll_after_ms`
- `get_task` — fetch a task by `id`; truncates `result.data.output.text` at 6000 chars unless `full_output: true`, includes `poll_after_ms` while active, and flags `untrusted_output: true`
- `list_tasks` — list compact task summaries (`id`, `title`, `status`, `priority`, `agent`, `parent_id`, timestamps) with optional `status`, `agent`, `parent_id`, `limit`, `offset` filters
- `cancel_task` — cancel a `queued` or `running` task by `id`
- `retry_task` — enqueue a new task linked via `parent_id` from a terminal task by `id`
- `get_capabilities` — inspect allowed agents, permission ceiling, `allowed_workspaces`, subtask limits, and worktree support

Telegram commands (when `transports.telegram` is enabled):

- Plain text opens a 1-tap Draft Card to adjust agent or priority before running
- Swipe-reply to any task card, completion notification, or `.md` attachment to resume or follow up
- `/run <prompt>`, `/list [status]`, `/task <id>`, `/cancel <id>`, `/retry <id>`, `/use`, `/health`, `/help`

## Test

```bash
npm test
# Run live Supabase integration test using ~/.task-aside/settings.json
npm run test:live
```

## Documentation

High-level architecture and sequence flows live in `docs/`:

- [Architecture Overview](./docs/architecture.md)
- [Task Intake & Queries](./docs/seq-task-intake.md)
- [Telegram Pairing, Control & Notifications](./docs/seq-telegram.md)
- [Worker Execution](./docs/seq-worker-execution.md)
- [Recovery, Breakdown & HITL](./docs/seq-recovery-and-hitl.md)

## Layout

See [AGENTS.md](./AGENTS.md) for strict layer dependency rules and live documentation maintenance.

```text
bin/task-aside.js    CLI entrypoint
docs/                High-level architecture and sequence docs
migrations/          Supabase Postgres schema and RPC migrations
src/index.js         Composition root (DI wiring)
src/transports/      HTTP, MCP, Telegram, and background worker transports
src/handlers/        Transport-agnostic entry points
src/usecases/        Business logic
src/services/        Headless agent harness service (agy, claude, codex)
src/repositories/    Supabase PostgREST/RPC & in-memory task repositories
src/utilities/       Shared utilities, settings, UUID v7, logger, and errors
test/                Zero-dependency node:test suite
```

## Release

No build step required:

```bash
# Preview release checks and commands without mutating git, npm, or GitHub
DRY_RUN=1 make release

# Run full release flow (tags current version if untagged, or bumps patch by default)
make release

# Explicit version bump (patch | minor | major | ...)
make release BUMP=patch
```
