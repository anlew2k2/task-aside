# task-aside

Minimal, zero-dependency CLI exposing **1 HTTP/MCP server** and **1 sequential background worker** backed by Cloudflare Queues, ready to run directly with Node or Bun.

## Configuration

Set the required Cloudflare Queue environment variables (or place them in `.env`):

- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID
- `CLOUDFLARE_API_TOKEN` — API token with Queues Read & Write permissions
- `CLOUDFLARE_TASKS_QUEUE_ID` — Cloudflare Queue ID for tasks
- `CLOUDFLARE_API_BASE_URL` *(optional)* — Defaults to `https://api.cloudflare.com/client/v4`
- `CLOUDFLARE_VISIBILITY_TIMEOUT_MS` *(optional)* — Pull lease timeout in ms (default: `30000`)
- `HOST` *(optional)* — HTTP/MCP bind host (default: `127.0.0.1`; overridden by `-H, --host`)
- `PORT` *(optional)* — HTTP/MCP bind port (default: `3100`; overridden by `-p, --port`)
- `ENABLE_HTTP` *(optional)* — Enable HTTP `/tasks` endpoint (`true`/`false`, default: `true`)
- `ENABLE_MCP` *(optional)* — Enable MCP `/mcp` endpoint (`true`/`false`, default: `true`)
- `ENABLE_WORKER` *(optional)* — Enable background queue worker (`true`/`false`, default: `true`)
- `LOG_DIR` *(optional)* — Directory for daily-rotated log files (`task-aside-YYYY-MM-DD.log`, default: `./logs`)

## Run

```bash
npx task-aside
# or with Bun
bunx --bun task-aside
```

Local run without installing:

```bash
node ./bin/task-aside.js
```

## Options

- `-p, --port <port>` — HTTP/MCP port (default: `PORT` env var or `3100`)
- `-H, --host <host>` — Bind host (default: `HOST` env var or `127.0.0.1`)
- `-h, --help` — Show help
- `-v, --version` — Show version

## Task Message Format (`v1`)

Both HTTP (`POST /tasks`) and MCP (`create_task`) validate input, enqueue the `v1` envelope onto Cloudflare Queue, and return:

```json
{
  "schema": {
    "version": "v1"
  },
  "metadata": {
    "created_at": "2025-11-24T12:23:49.000Z",
    "updated_at": "2025-11-24T12:23:49.000Z"
  },
  "data": {
    "id": "01935e8b-0000-7000-8000-000000000000",
    "title": "Task title",
    "description": "## Markdown details",
    "parent_id": null,
    "priority": "P1"
  }
}
```

- `data.id`: Server-generated UUID v7
- `data.title`: Non-empty string
- `data.description`: String (Markdown)
- `data.parent_id`: UUID v7 string or `null`
- `data.priority`: One of `P0`, `P1`, `P2`, `P3`
- `metadata.created_at`, `metadata.updated_at`: ISO 8601 UTC timestamp

## Endpoints & MCP Tools

```bash
curl -s http://127.0.0.1:3100/health

curl -s -X POST http://127.0.0.1:3100/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Demo task","description":"**Markdown** body","parent_id":null,"priority":"P1"}'

curl -s http://127.0.0.1:3100/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Built-in MCP tool:

- `create_task` — create a task (`title`, `description`, optional `parent_id`, `priority`) and push it to Cloudflare Queue

## Background Worker

The worker polls Cloudflare Queue (`batch_size: 1`) and processes messages sequentially one at a time. The current worker implementation sleeps for 5 seconds per message, logs the task payload, and acknowledges the message.

## Test

```bash
npm test
# Run live Cloudflare Queue integration test using .env
npm run test:live
```

## Layout

See [AGENTS.md](./AGENTS.md) for strict layer dependency rules.

```text
bin/task-aside.js    CLI entrypoint
src/index.js         Composition root (DI wiring)
src/transports/      HTTP, MCP, and background worker transports
src/handlers/        Transport-agnostic entry points
src/usecases/        Business logic
src/services/        External integrations (Cloudflare Queue)
src/repositories/    Data/database adapters
src/utilities/       Shared utilities, UUID v7, env, logger, and errors
test/                Zero-dependency node:test suite
```

## Release

No build step required:

```bash
npm publish
```
