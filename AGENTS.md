# AGENTS.md

Architectural and organizational guidelines for `task-aside`.

## Project Goals

- Zero runtime dependencies, zero `devDependencies`, no build step.
- Pure ESM JavaScript (`"type": "module"`) compatible with Node.js (`>=18`) and Bun (`npx task-aside`, `bunx --bun task-aside`).
- Single process exposing **1 MCP/HTTP server** and **1 sequential background worker** backed by Supabase and headless CLI agents (`agy`, `claude`, `codex`).

## Layered Architecture (`src/`)

```text
transports/  -->  handlers/  -->  usecases/  -->  services/
                                             -->  repositories/
(all layers) -->  utilities/
src/index.js  =   Composition root (wires dependencies via DI; no business logic)
```

### Layer Responsibilities

- `src/transports/` (`http.js`, `mcp.js`, `worker.js`): Protocol, HTTP/JSON-RPC parsing, and background polling loop. Transports may **only** call `handlers/` directly (and coordinate with sibling transports).
- `src/handlers/` (`task.handler.js`, `health.handler.js`): Transport-agnostic entry points and input validation. One handler can serve multiple transports (HTTP, MCP, Worker). Handlers may **only** call `usecases/` directly.
- `src/usecases/` (`task.usecase.js`): Business logic and orchestration. Usecases may **only** call `services/` and `repositories/` directly.
- `src/services/` (`agent.service.js`): Headless agent CLI dispatch (`agy`, `claude`, `codex`), prompt rendering, artifact capture, and result envelope normalization.
- `src/repositories/` (`task.repository.js`): Data persistence and queue claiming via Supabase PostgREST/RPC (plus in-memory test adapter).
- `src/utilities/` (`errors.js`, `http.js`, `logger.js`, `otel.js`, `package-info.js`, `settings.js`, `uuid.js`, `validation.js`): Shared pure helpers, global settings loader, and typed errors used across layers.
- `src/index.js`: Composition root that instantiates repositories, services, usecases, handlers, and transports via dependency injection and manages startup/shutdown.

### Dependency Matrix

| Layer | Allowed Direct Dependencies | Forbidden Imports / Calls |
| --- | --- | --- |
| `transports/` | `handlers/`, `utilities/`, sibling `transports/`, `node:*` | `usecases/`, `services/`, `repositories/` |
| `handlers/` | `usecases/`, `utilities/`, `node:*` | `transports/`, `services/`, `repositories/` |
| `usecases/` | `services/`, `repositories/`, `utilities/`, `node:*` | `transports/`, `handlers/` |
| `services/` | `utilities/`, external CLI processes/clients, `node:*` | `transports/`, `handlers/`, `usecases/`, `repositories/` |
| `repositories/` | `utilities/`, DB/storage drivers, `node:*` | `transports/`, `handlers/`, `usecases/`, `services/` |
| `utilities/` | `node:*` | All other `src/` layers |

## Code Organization Rules

1. **Wire via Dependency Injection (`src/index.js`)**: Export `create*` factories from each layer and pass downstream dependencies as arguments rather than importing concrete implementations across layers.
2. **Keep `handlers/` Transport-Agnostic**: Accept plain JavaScript objects, validate via `utilities/validation.js`, and throw typed `AppError` subclasses from `utilities/errors.js` (`ValidationError`, `NotFoundError`). Never pass HTTP `req`/`res` or JSON-RPC envelopes into handlers or usecases.
3. **Keep `services/` and `repositories/` Async**: All service and repository methods must return Promises (`async`).
4. **Runtime Compatibility**: Use standard `node:*` built-in modules supported by both Node.js and Bun. Do not use JSON import attributes (`with { type: "json" }`); read `package.json` via `src/utilities/package-info.js`.
5. **Global Configuration**: Store configuration, logs, and run artifacts under `~/.task-aside/` (`~/.task-aside/settings.json`) rather than `.env` files.
6. **Subpath Imports**: Use the `#src/*` subpath import alias (`"./src/*"` in `package.json`) with explicit `.js` extensions for internal imports across `bin/`, `src/`, and `test/`.

## Live Docs Maintenance

Keep `docs/` synchronized whenever architecture, protocols, or runtime behavior change. Every file in `docs/` must stay high-level (~50–85 lines), scannable (Mermaid diagrams plus short tables or bullets), and **must never embed source code, SQL, full JSON payloads, or CLI flag dumps**.

| If You Change | Update |
| --- | --- |
| Layers, transports, `settings.json`, `~/.task-aside/` layout, or DB schema overview | `docs/architecture.md` |
| HTTP `/tasks` routes, MCP tools, intake validation, or envelope fields | `docs/seq-task-intake.md` |
| Worker polling, `claim_next_task` / `extend_task_lease`, agent dispatch, policy gates, or run artifacts | `docs/seq-worker-execution.md` |
| Task statuses, error/timeout/shutdown/lease-expiry rules, `parent_id` breakdown, or `session_id` resume | `docs/seq-recovery-and-hitl.md` |
