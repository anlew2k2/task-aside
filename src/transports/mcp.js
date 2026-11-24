import { NotFoundError, ValidationError } from "../utilities/errors.js";
import { isPlainObject } from "../utilities/validation.js";

const MAX_BODY_BYTES = 1_048_576;

const TOOLS = [
  {
    name: "enqueue_task",
    description: "Enqueue a task for the background worker to process.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the background task",
        },
        payload: {
          type: "object",
          description: "Optional JSON payload for the task",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task",
    description: "Get the current status and result of a background task by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Task ID returned by enqueue_task",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tasks",
    description: "List all background tasks and current worker status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: "2.0", id, error };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, extraHeaders);
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        const err = new Error("Request body too large");
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error("Parse error");
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

function formatToolResponse(data, isError = false) {
  const response = {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };

  if (isError) {
    response.isError = true;
  }

  return response;
}

/**
 * Streamable HTTP MCP transport calling only task handlers.
 */
export function createMcpTransport({
  taskHandler,
  version,
  protocolVersion = "2025-03-26",
  getWorkerStatus,
}) {
  async function callTool(name, args) {
    const input = args === undefined ? {} : args;

    switch (name) {
      case "enqueue_task": {
        const task = await taskHandler.enqueueTask(input);
        return formatToolResponse(task);
      }

      case "get_task": {
        try {
          const task = await taskHandler.getTask(input);
          return formatToolResponse(task);
        } catch (error) {
          if (error instanceof NotFoundError) {
            return formatToolResponse({ error: error.message }, true);
          }
          throw error;
        }
      }

      case "list_tasks": {
        if (!isPlainObject(input)) {
          throw new ValidationError("Tool arguments must be an object");
        }
        const summary = await taskHandler.listTasks({
          worker: getWorkerStatus?.(),
        });
        return formatToolResponse(summary);
      }

      default:
        throw new ValidationError(`Unknown tool: ${name}`);
    }
  }

  async function handleRpcMessage(message) {
    if (
      !isPlainObject(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      message.method.length === 0
    ) {
      const id = isPlainObject(message) && message.id !== undefined ? message.id : null;
      return jsonRpcError(id, -32600, "Invalid Request");
    }

    const { id, method, params } = message;
    if (id === undefined) {
      return null;
    }

    switch (method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "task-aside",
            version,
          },
        });

      case "ping":
        return jsonRpcResult(id, {});

      case "tools/list":
        return jsonRpcResult(id, { tools: TOOLS });

      case "tools/call": {
        if (!isPlainObject(params) || typeof params.name !== "string") {
          return jsonRpcError(id, -32602, 'Invalid params: "name" is required');
        }
        try {
          const result = await callTool(params.name, params.arguments);
          return jsonRpcResult(id, result);
        } catch (error) {
          if (error instanceof ValidationError) {
            return jsonRpcError(id, -32602, error.message);
          }
          throw error;
        }
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  async function handlePost(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error.statusCode === 413) {
        sendJson(res, 413, jsonRpcError(null, -32600, "Payload Too Large"));
        return;
      }
      sendJson(res, 400, jsonRpcError(null, -32700, "Parse error"));
      return;
    }

    if (Array.isArray(body)) {
      if (body.length === 0) {
        sendJson(res, 400, jsonRpcError(null, -32600, "Invalid Request"));
        return;
      }

      const responses = (await Promise.all(body.map(handleRpcMessage))).filter(
        (item) => item !== null,
      );

      if (responses.length === 0) {
        sendEmpty(res, 202);
        return;
      }

      sendJson(res, 200, responses);
      return;
    }

    const response = await handleRpcMessage(body);
    if (response === null) {
      sendEmpty(res, 202);
      return;
    }

    sendJson(res, 200, response);
  }

  function handleHttpRequest(req, res) {
    if (req.method === "POST") {
      void handlePost(req, res).catch((error) => {
        if (!res.headersSent) {
          sendJson(res, 500, jsonRpcError(null, -32603, error.message));
        }
      });
      return;
    }

    if (req.method === "DELETE") {
      sendEmpty(res, 204);
      return;
    }

    sendEmpty(res, 405, { allow: "POST, DELETE" });
  }

  return {
    handleHttpRequest,
  };
}
