# task-aside

Minimal, zero-dependency CLI exposing **1 MCP HTTP port** and **1 background worker**, ready to run directly with Node or Bun.

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

- `-p, --port <port>` — MCP HTTP port (default: `PORT` env var or `3100`)
- `-H, --host <host>` — Bind host (default: `HOST` env var or `127.0.0.1`)
- `-h, --help` — Show help
- `-v, --version` — Show version

## Layout

See [AGENTS.md](./AGENTS.md) for strict layer dependency rules.

```text
bin/task-aside.js    CLI entrypoint
src/index.js         Composition root (DI wiring)
src/transports/      HTTP, MCP, and background worker transports
src/handlers/        Transport-agnostic entry points
src/usecases/        Business logic
src/services/        External integrations (e.g. Cloudflare Queue)
src/repositories/    Data/database adapters (e.g. SQLite SQL / SQLite KV)
src/utilities/       Shared utilities and errors
```

## Quick Check

```bash
curl -s http://127.0.0.1:3100/health

curl -s http://127.0.0.1:3100/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Built-in MCP tools:

- `enqueue_task` — enqueue a task (`name`, optional `payload`) for the background worker
- `get_task` — inspect task status and result by `id`
- `list_tasks` — inspect worker status and all tasks

## Release

No build step required:

```bash
npm publish
```
