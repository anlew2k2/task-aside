import { createServer } from "node:http";
import { QueueError, ValidationError } from "../utilities/errors.js";
import { readJsonBody, sendEmpty, sendJson } from "../utilities/http.js";

/**
 * HTTP server transport routing `/health`, `/tasks`, and `/mcp` based on enabled transports.
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
      const task = await taskHandler.createTask(body);
      sendJson(res, 201, task);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(res, 400, { error: error.message, code: error.code });
        return;
      }
      if (error instanceof QueueError) {
        sendJson(res, 502, { error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  }

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
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
      if (req.method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }

      void handleCreateTask(req, res).catch((error) => {
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
