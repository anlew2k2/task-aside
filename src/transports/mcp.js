import { NotFoundError, StorageError, ValidationError } from "../utilities/errors.js";
import { readJsonBody, sendEmpty, sendJson } from "../utilities/http.js";
import {
  isPlainObject,
  PERMISSION_MODES,
  SUPPORTED_AGENTS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "../utilities/validation.js";

const TOOLS = [
  {
    name: "create_task",
    description:
      "Create a task and enqueue it to Supabase for headless agent execution. Do not pass id; the service generates data.id, timestamps, and OTel trace metadata automatically.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Task title",
        },
        description: {
          type: "string",
          description: "Task description in Markdown format",
        },
        parent_id: {
          type: ["string", "null"],
          description: "Optional parent task UUID v7 or null",
        },
        priority: {
          type: "string",
          enum: TASK_PRIORITIES,
          description: "Task priority level",
        },
        execution: {
          type: "object",
          description: "Headless agent execution configuration selected by the client",
          properties: {
            agent: {
              type: "string",
              enum: SUPPORTED_AGENTS,
              description: "Target agent harness to execute the task",
            },
            model: {
              type: ["string", "null"],
              description: "Optional model ID override",
            },
            effort: {
              type: ["string", "null"],
              description: "Optional reasoning effort level",
            },
            cwd: {
              type: ["string", "null"],
              description: "Optional working directory path",
            },
            permission_mode: {
              type: ["string", "null"],
              enum: [...PERMISSION_MODES, null],
              description: "Optional permission policy (capped by worker max_permission_mode)",
            },
            timeout_ms: {
              type: ["integer", "null"],
              minimum: 1,
              description: "Optional execution timeout in milliseconds",
            },
            session_id: {
              type: ["string", "null"],
              description: "Optional previous agent session/conversation ID to resume",
            },
          },
          required: ["agent"],
          additionalProperties: false,
        },
      },
      required: ["title", "description", "priority", "execution"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task",
    description: "Fetch a task record and its execution result envelope by UUID v7 id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Task UUID v7",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tasks",
    description: "List tasks ordered by created_at descending with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: TASK_STATUSES,
          description: "Filter by task status",
        },
        agent: {
          type: "string",
          enum: SUPPORTED_AGENTS,
          description: "Filter by target agent",
        },
        parent_id: {
          type: ["string", "null"],
          description: "Filter by parent task UUID v7 or null for root tasks",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of tasks to return (default 50)",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Pagination offset (default 0)",
        },
      },
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
  logger = console,
}) {
  async function callTool(name, args, context = {}) {
    const input = args === undefined ? {} : args;

    try {
      switch (name) {
        case "create_task": {
          const task = await taskHandler.createTask(input, context);
          return formatToolResponse(task);
        }

        case "get_task": {
          const task = await taskHandler.getTask(input);
          return formatToolResponse(task);
        }

        case "list_tasks": {
          const result = await taskHandler.listTasks(input);
          return formatToolResponse(result);
        }

        default:
          throw new ValidationError(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof StorageError || error instanceof NotFoundError) {
        return formatToolResponse({ error: error.message, code: error.code }, true);
      }
      throw error;
    }
  }

  async function handleRpcMessage(message, context = {}) {
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
        logger.log(`[mcp] tools/call name=${params.name}`);
        const metaTraceparent =
          isPlainObject(params._meta) && typeof params._meta.traceparent === "string"
            ? params._meta.traceparent
            : null;
        const traceparent = metaTraceparent ?? context.traceparent ?? null;
        try {
          const result = await callTool(params.name, params.arguments, { traceparent });
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

    const requestContext = {
      traceparent: typeof req.headers.traceparent === "string" ? req.headers.traceparent : null,
    };

    if (Array.isArray(body)) {
      if (body.length === 0) {
        sendJson(res, 400, jsonRpcError(null, -32600, "Invalid Request"));
        return;
      }

      const responses = (
        await Promise.all(body.map((item) => handleRpcMessage(item, requestContext)))
      ).filter((item) => item !== null);

      if (responses.length === 0) {
        sendEmpty(res, 202);
        return;
      }

      sendJson(res, 200, responses);
      return;
    }

    const response = await handleRpcMessage(body, requestContext);
    if (response === null) {
      sendEmpty(res, 202);
      return;
    }

    sendJson(res, 200, response);
  }

  function handleHttpRequest(req, res) {
    if (req.method === "POST") {
      void handlePost(req, res).catch((error) => {
        logger.error(
          "[mcp] Unhandled error:",
          error instanceof Error ? error.message : String(error),
        );
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
