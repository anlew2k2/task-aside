import { createServer } from "node:http";
import { NotFoundError, StorageError, ValidationError } from "../utilities/errors.js";
import { readJsonBody, sendEmpty, sendJson } from "../utilities/http.js";

/**
 * HTTP server transport routing `/health`, `/tasks`, `/tasks/:id`, and `/mcp`.
 */
export function createHttpTransport({
  healthHandler,
  taskHandler = null,
  mcpTransport = null,
  enableHttp = true,
  enableMcp = true,
  getWorkerStatus,
  transports,
  logger = console,
}) {
  function handleTaskError(res, error) {
    if (error instanceof ValidationError) {
      sendJson(res, 400, { error: error.message, code: error.code });
      return true;
    }
    if (error instanceof NotFoundError) {
      sendJson(res, 404, { error: error.message, code: error.code });
      return true;
    }
    if (error instanceof StorageError) {
      sendJson(res, 502, { error: error.message, code: error.code });
      return true;
    }
    return false;
  }

  async function handleCreateTask(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error.statusCode === 413) {
        sendJson(res, 413, {
          error: "Payload Too Large",
          code: "PAYLOAD_TOO_LARGE",
        });
        return;
      }
      sendJson(res, 400, {
        error: "Invalid JSON body",
        code: "PARSE_ERROR",
      });
      return;
    }

    try {
      const traceparent =
        typeof req.headers.traceparent === "string" ? req.headers.traceparent : null;
      const task = await taskHandler.createTask(body, { traceparent });
      sendJson(res, 201, task);
    } catch (error) {
      if (!handleTaskError(res, error)) {
        throw error;
      }
    }
  }

  async function handleListTasks(url, res) {
    const params = url.searchParams;
    const rawParentId = params.get("parent_id");
    let parent_id;
    if (rawParentId === "null") {
      parent_id = null;
    } else if (rawParentId !== null && rawParentId !== "") {
      parent_id = rawParentId;
    }

    try {
      const result = await taskHandler.listTasks({
        status: params.get("status") ?? undefined,
        agent: params.get("agent") ?? undefined,
        parent_id,
        limit: params.get("limit") ?? undefined,
        offset: params.get("offset") ?? undefined,
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (!handleTaskError(res, error)) {
        throw error;
      }
    }
  }

  async function handleGetTask(rawId, res) {
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      sendJson(res, 400, { error: "Invalid task ID encoding", code: "VALIDATION_ERROR" });
      return;
    }

    try {
      const record = await taskHandler.getTask({ id });
      sendJson(res, 200, record);
    } catch (error) {
      if (!handleTaskError(res, error)) {
        throw error;
      }
    }
  }

  function catchAsyncError(res, promise) {
    void promise.catch((error) => {
      logger.error(
        "[http] Unhandled error:",
        error instanceof Error ? error.message : String(error),
      );
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
          code: "INTERNAL_ERROR",
        });
      }
    });
  }

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;
    res.once("finish", () => {
      logger.log(
        `[http] ${req.method} ${pathname} ${res.statusCode} (${Date.now() - startedAt}ms)`,
      );
    });

    if (pathname === "/health" && req.method === "GET") {
      void healthHandler
        .getHealth({ worker: getWorkerStatus?.(), transports })
        .then((payload) => {
          sendJson(res, 200, payload);
        })
        .catch((error) => {
          logger.error(
            "[http] Unhandled error:",
            error instanceof Error ? error.message : String(error),
          );
          if (!res.headersSent) {
            sendJson(res, 500, { error: error.message });
          }
        });
      return;
    }

    if (pathname === "/tasks" && enableHttp && taskHandler) {
      if (req.method === "POST") {
        catchAsyncError(res, handleCreateTask(req, res));
        return;
      }
      if (req.method === "GET") {
        catchAsyncError(res, handleListTasks(requestUrl, res));
        return;
      }
      sendEmpty(res, 405, { allow: "GET, POST" });
      return;
    }

    const taskByIdMatch = /^\/tasks\/([^/]+)$/.exec(pathname);
    if (taskByIdMatch && enableHttp && taskHandler) {
      if (req.method === "GET") {
        catchAsyncError(res, handleGetTask(taskByIdMatch[1], res));
        return;
      }
      sendEmpty(res, 405, { allow: "GET" });
      return;
    }

    if (pathname === "/mcp" && enableMcp && mcpTransport) {
      mcpTransport.handleHttpRequest(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  });

  function listen({ host = "127.0.0.1", port = 3100 } = {}) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("error", onError);
        reject(error);
      };

      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        const formattedHost = host.includes(":") ? `[${host}]` : host;
        resolve({
          host,
          port: boundPort,
          url: `http://${formattedHost}:${boundPort}`,
        });
      });
    });
  }

  function close() {
    if (!server.listening) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeAllConnections?.();
    });
  }

  return {
    server,
    listen,
    close,
  };
}
