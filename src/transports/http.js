import { createServer } from "node:http";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * HTTP server transport routing `/health` to healthHandler and `/mcp` to mcpTransport.
 */
export function createHttpTransport({
  healthHandler,
  mcpTransport,
  getWorkerStatus,
}) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (pathname === "/health" && req.method === "GET") {
      void healthHandler
        .getHealth({ worker: getWorkerStatus?.() })
        .then((payload) => {
          sendJson(res, 200, payload);
        })
        .catch((error) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: error.message });
          }
        });
      return;
    }

    if (pathname === "/mcp") {
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
