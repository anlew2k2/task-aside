---
name: 0-task-aside
description: Use task-aside to create tasks via HTTP or MCP, check service health, and inspect logs.
---

# task-aside

Default local base URL: `http://127.0.0.1:3100` (exposes `/health`, `/tasks`, and `/mcp`).

## Health Check

```sh
curl -s http://127.0.0.1:3100/health
```

Returns service status, enabled transports (`http`, `mcp`, `worker`), and worker state (`running`, `busy`, `provider`, `queueId`, `totalCount`).

## Create a Task (HTTP `POST /tasks`)

```sh
curl -s -X POST http://127.0.0.1:3100/tasks \
  -H 'content-type: application/json' \
  -d '{
    "title": "Implement queue consumer",
    "description": "## Notes\n- Pull sequentially",
    "parent_id": null,
    "priority": "P1"
  }'
```

**Input fields:**
- `title` *(required)*: non-empty string
- `description` *(required)*: Markdown string
- `parent_id` *(optional)*: UUID v7 string or `null`
- `priority` *(required)*: `P0`, `P1`, `P2`, or `P3`

**Status codes:** `201` created, `400` invalid JSON or fields, `404` route not found or HTTP disabled, `502` upstream queue error.

## Create a Task (MCP `POST /mcp`)

```sh
# List available tools
curl -s http://127.0.0.1:3100/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call create_task
curl -s http://127.0.0.1:3100/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "create_task",
      "arguments": {
        "title": "Subtask via MCP",
        "description": "- Child work item",
        "parent_id": null,
        "priority": "P2"
      }
    }
  }'
```

Validation errors return JSON-RPC error `-32602`; queue errors return a tool result with `isError: true`.

## Task Response Envelope (`v1`)

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
    "description": "## Markdown body",
    "parent_id": null,
    "priority": "P1"
  }
}
```

## Logs

Logs rotate daily at `<LOG_DIR>/task-aside-YYYY-MM-DD.log` (default `./logs`), and the active log file path is printed on startup.
