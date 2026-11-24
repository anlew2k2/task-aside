import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  SUPPORTED_AGENTS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
} from "#src/utilities/validation.js";

export const TELEGRAM_BOT_COMMANDS = Object.freeze([
  { command: "run", description: "Create and queue a task immediately" },
  { command: "list", description: "List recent tasks (optional status)" },
  { command: "task", description: "Inspect task details by ID" },
  { command: "cancel", description: "Cancel a queued or running task" },
  { command: "retry", description: "Retry a finished or failed task" },
  { command: "use", description: "Switch active agent, priority, or workspace" },
  { command: "health", description: "Check worker and queue status" },
  { command: "help", description: "Show usage instructions" },
]);

const UUID_V7_FIND_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const MAX_DRAFTS = 100;
const MAX_TASK_CARDS = 500;
const INLINE_OUTPUT_LIMIT = 3200;
const EXCERPT_LIMIT = 1500;
const TELEGRAM_MESSAGE_LIMIT = 4096;

const STATUS_BADGES = Object.freeze({
  queued: "🕒 queued",
  running: "⚙️ running",
  completed: "✅ completed",
  failed: "❌ failed",
  timeout: "⏱ timeout",
  interrupted: "⚠️ interrupted",
  cancelled: "🛑 cancelled",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncateText(value, maxLen) {
  const str = String(value ?? "");
  if (str.length <= maxLen) {
    return str;
  }
  if (maxLen <= 3) {
    return str.slice(0, maxLen);
  }
  return `${str.slice(0, maxLen - 3)}...`;
}

function buildTitle(prompt) {
  const firstLine = String(prompt ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncateText(firstLine || "Telegram task", 80);
}

function makeMarkdownFilename(title, taskId) {
  const slug = String(title ?? "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const shortId = String(taskId ?? "").slice(0, 8) || "output";
  return `${slug || "task"}-${shortId}.md`;
}

function extractTaskIdFromMessage(message) {
  if (!message) {
    return null;
  }
  const source = `${message.text ?? ""}\n${message.caption ?? ""}`;
  const match = UUID_V7_FIND_REGEX.exec(source);
  return match ? match[0].toLowerCase() : null;
}

function setBoundedMap(map, key, value, maxSize) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function sanitizeToken(text, token) {
  const str = String(text ?? "");
  return token ? str.replaceAll(token, "[REDACTED]") : str;
}

function timingSafeTokenMatch(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") {
    return false;
  }
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

async function callTelegramApi({
  fetchImpl,
  apiBaseUrl,
  botToken,
  method,
  payload,
  signal,
}) {
  const endpoint = `${apiBaseUrl}/bot${botToken}/${method}`;
  const isFormData = typeof FormData !== "undefined" && payload instanceof FormData;

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: isFormData ? undefined : { "content-type": "application/json" },
      body: isFormData ? payload : JSON.stringify(payload ?? {}),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    const msg = sanitizeToken(error instanceof Error ? error.message : String(error), botToken);
    throw new Error(`Telegram ${method} network error: ${msg}`);
  }

  const rawText = await response.text();
  let parsed = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok || !parsed?.ok) {
    const description = sanitizeToken(
      parsed?.description ?? `HTTP ${response.status}`,
      botToken,
    );
    const err = new Error(`Telegram ${method} failed: ${description}`);
    err.statusCode = response.status;
    throw err;
  }

  return parsed.result;
}

function cycleNext(items, current) {
  if (!items.length) {
    return null;
  }
  const idx = items.indexOf(current);
  if (idx === -1) {
    return items[0];
  }
  return items[(idx + 1) % items.length];
}

function cycleWorkspace(workspaceNames, current) {
  const options = [null, ...workspaceNames];
  const idx = options.indexOf(current ?? null);
  if (idx === -1) {
    return options[0];
  }
  return options[(idx + 1) % options.length];
}

function formatDurationMs(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = Math.round(durationMs / 100) / 10;
  return `${seconds}s`;
}

/**
 * Built-in zero-dependency Telegram Bot API long-polling transport.
 * Calls only `taskHandler` and `healthHandler`.
 */
export function createTelegramTransport({
  taskHandler,
  healthHandler,
  telegramConfig,
  workerConfig,
  getWorkerStatus,
  transports,
  fetchImpl = globalThis.fetch,
  retryDelayMs = 2_000,
  logger = console,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch implementation is required for Telegram transport");
  }

  const botToken = telegramConfig.bot_token;
  const apiBaseUrl = telegramConfig.api_base_url.replace(/\/+$/, "");
  const pollTimeoutSeconds = telegramConfig.poll_timeout_seconds ?? 25;
  const authorizedUserId = telegramConfig.user_id ? String(telegramConfig.user_id) : null;
  const authorizedChatId = telegramConfig.chat_id ? String(telegramConfig.chat_id) : null;
  const workspaces = telegramConfig.workspaces ?? {};
  const workspaceNames = Object.keys(workspaces);
  const availableAgents =
    Array.isArray(workerConfig?.allowed_agents) && workerConfig.allowed_agents.length > 0
      ? workerConfig.allowed_agents
      : SUPPORTED_AGENTS;

  const activeDefaults = {
    agent: availableAgents.includes(telegramConfig.default_agent)
      ? telegramConfig.default_agent
      : availableAgents[0],
    priority: telegramConfig.default_priority ?? "P1",
    workspace: telegramConfig.default_workspace ?? null,
  };

  const drafts = new Map();
  const taskCards = new Map();
  const taskWorkQueues = new Map();

  let running = false;
  let pollController = null;
  let pollPromise = null;
  let unsubscribeEvents = null;
  let updateOffset = 0;

  function enqueueTaskWork(taskId, fn) {
    const previous = taskWorkQueues.get(taskId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(fn)
      .catch((error) => {
        logger.error(
          `[telegram] Failed processing notification for task id=${taskId}:`,
          sanitizeToken(error instanceof Error ? error.message : String(error), botToken),
        );
      })
      .finally(() => {
        if (taskWorkQueues.get(taskId) === next) {
          taskWorkQueues.delete(taskId);
        }
      });
    taskWorkQueues.set(taskId, next);
    return next;
  }

  function isAuthorized(userId, chatId) {
    if (!authorizedUserId || !authorizedChatId) {
      return false;
    }
    return (
      userId !== undefined &&
      userId !== null &&
      chatId !== undefined &&
      chatId !== null &&
      String(userId) === authorizedUserId &&
      String(chatId) === authorizedChatId
    );
  }

  async function callApi(method, payload, { signal } = {}) {
    return callTelegramApi({
      fetchImpl,
      apiBaseUrl,
      botToken,
      method,
      payload,
      signal,
    });
  }

  async function sendMessage({
    chatId,
    text,
    replyMarkup = undefined,
    disableNotification = false,
    replyToMessageId = undefined,
  }) {
    const body = {
      chat_id: chatId,
      text: truncateText(text, TELEGRAM_MESSAGE_LIMIT),
      parse_mode: "HTML",
      disable_notification: disableNotification,
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    if (replyToMessageId !== undefined) {
      body.reply_to_message_id = replyToMessageId;
    }
    return callApi("sendMessage", body);
  }

  async function editMessageText({ chatId, messageId, text, replyMarkup = undefined }) {
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: truncateText(text, TELEGRAM_MESSAGE_LIMIT),
      parse_mode: "HTML",
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    try {
      return await callApi("editMessageText", body);
    } catch (error) {
      if (/message is not modified/i.test(error?.message ?? "")) {
        return null;
      }
      throw error;
    }
  }

  async function sendDocument({
    chatId,
    filename,
    content,
    caption,
    disableNotification = true,
  }) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("disable_notification", String(Boolean(disableNotification)));
    if (caption) {
      form.set("caption", truncateText(caption, 1024));
    }
    const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
    form.set("document", blob, filename);
    return callApi("sendDocument", form);
  }

  async function answerCallback(callbackQueryId, text = undefined, showAlert = false) {
    try {
      await callApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text: truncateText(text, 200) } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      });
    } catch {
      // Callback queries expire quickly; ignore answer failures.
    }
  }

  function resolveWorkspaceCwd(workspaceAlias) {
    if (workspaceAlias && workspaceAlias in workspaces) {
      return workspaces[workspaceAlias];
    }
    return workerConfig?.default_cwd || null;
  }

  function formatWorkspaceLabel(workspaceAlias) {
    if (workspaceAlias && workspaceAlias in workspaces) {
      return `${workspaceAlias} (${workspaces[workspaceAlias]})`;
    }
    return workerConfig?.default_cwd ? `default (${workerConfig.default_cwd})` : "default";
  }

  function buildDraftCard(draft) {
    const lines = [
      "<b>📝 New Task Draft</b>",
      `<b>Title:</b> ${escapeHtml(draft.title)}`,
      `<b>Agent:</b> <code>${escapeHtml(draft.agent)}</code> | <b>Priority:</b> <code>${escapeHtml(draft.priority)}</code>`,
      `<b>Workspace:</b> <code>${escapeHtml(formatWorkspaceLabel(draft.workspace))}</code>`,
      "",
      `<pre>${escapeHtml(truncateText(draft.prompt, 1200))}</pre>`,
    ];

    const row2 = [
      { text: `Agent: ${draft.agent}`, callback_data: `d:ag:${draft.id}` },
      { text: `Prio: ${draft.priority}`, callback_data: `d:pr:${draft.id}` },
    ];
    if (workspaceNames.length > 0) {
      row2.push({
        text: `WS: ${draft.workspace ?? "default"}`,
        callback_data: `d:ws:${draft.id}`,
      });
    }

    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "▶ Run", callback_data: `d:run:${draft.id}` },
            { text: "✖ Discard", callback_data: `d:del:${draft.id}` },
          ],
          row2,
        ],
      },
    };
  }

  function buildTaskActionMarkup(taskId, status) {
    const isActive = status === "queued" || status === "running";
    const primaryButton = isActive
      ? { text: "✖ Cancel", callback_data: `t:can:${taskId}` }
      : { text: "↻ Retry", callback_data: `t:ret:${taskId}` };

    return {
      inline_keyboard: [
        [primaryButton, { text: "↻ Refresh", callback_data: `t:get:${taskId}` }],
      ],
    };
  }

  function buildTaskCardText(recordOrEnvelope, { statusOverride = null, note = null } = {}) {
    const isRecord = Boolean(recordOrEnvelope?.task);
    const taskEnvelope = isRecord ? recordOrEnvelope.task : recordOrEnvelope;
    const taskData = taskEnvelope?.data ?? {};
    const exec = taskData.execution ?? {};
    const resultData = isRecord ? recordOrEnvelope.result?.data : null;

    const id = isRecord ? recordOrEnvelope.id : taskData.id;
    const status = statusOverride ?? (isRecord ? recordOrEnvelope.status : "queued");
    const badge = STATUS_BADGES[status] ?? status;
    const title = taskData.title ?? "Untitled task";
    const agent = isRecord ? recordOrEnvelope.agent : exec.agent;
    const priority = isRecord ? recordOrEnvelope.priority : taskData.priority;
    const cwd = resultData?.execution?.cwd ?? exec.cwd ?? workerConfig?.default_cwd ?? null;
    const duration = formatDurationMs(resultData?.execution?.duration_ms);
    const sessionId = resultData?.execution?.session_id ?? exec.session_id ?? null;
    const errorMsg = resultData?.error?.message ?? null;

    const lines = [
      `<b>${escapeHtml(badge)}</b> — ${escapeHtml(title)}`,
      `<b>ID:</b> <code>${escapeHtml(id)}</code>`,
      `<b>Agent:</b> <code>${escapeHtml(agent)}</code> | <b>Priority:</b> <code>${escapeHtml(priority)}</code>`,
    ];
    if (cwd) {
      lines.push(`<b>CWD:</b> <code>${escapeHtml(cwd)}</code>`);
    }
    if (taskData.parent_id) {
      lines.push(`<b>Parent:</b> <code>${escapeHtml(taskData.parent_id)}</code>`);
    }
    if (sessionId) {
      lines.push(`<b>Session:</b> <code>${escapeHtml(truncateText(sessionId, 64))}</code>`);
    }
    if (duration) {
      lines.push(`<b>Duration:</b> ${escapeHtml(duration)}`);
    }
    if (note) {
      lines.push(`<i>${escapeHtml(note)}</i>`);
    }
    if (errorMsg) {
      lines.push(`<b>Error:</b> ${escapeHtml(truncateText(errorMsg, 400))}`);
    }

    return lines.join("\n");
  }

  function buildDefaultsMessage() {
    const lines = [
      "<b>⚙️ Active Telegram Defaults</b>",
      `<b>Agent:</b> <code>${escapeHtml(activeDefaults.agent)}</code>`,
      `<b>Priority:</b> <code>${escapeHtml(activeDefaults.priority)}</code>`,
      `<b>Workspace:</b> <code>${escapeHtml(formatWorkspaceLabel(activeDefaults.workspace))}</code>`,
    ];

    const buttons = [
      { text: `Agent: ${activeDefaults.agent}`, callback_data: "u:ag" },
      { text: `Prio: ${activeDefaults.priority}`, callback_data: "u:pr" },
    ];
    if (workspaceNames.length > 0) {
      buttons.push({
        text: `WS: ${activeDefaults.workspace ?? "default"}`,
        callback_data: "u:ws",
      });
    }

    return {
      text: lines.join("\n"),
      replyMarkup: { inline_keyboard: [buttons] },
    };
  }

  function buildListMessage(tasks, statusFilter = null) {
    const header = statusFilter
      ? `<b>📋 Tasks (${escapeHtml(statusFilter)})</b>`
      : "<b>📋 Recent Tasks</b>";
    const lines = [header];

    if (!tasks.length) {
      lines.push("<i>No tasks found.</i>");
    } else {
      for (const task of tasks) {
        const badge = STATUS_BADGES[task.status] ?? task.status;
        const title = truncateText(task.task?.data?.title ?? "Untitled", 52);
        lines.push(
          `${escapeHtml(badge)} | <code>${escapeHtml(task.agent)}</code> | ${escapeHtml(task.priority)} — ${escapeHtml(title)}`,
        );
        lines.push(`<code>${escapeHtml(task.id)}</code>`);
      }
    }

    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "All", callback_data: "l:all" },
            { text: "Queued", callback_data: "l:queued" },
            { text: "Running", callback_data: "l:running" },
          ],
          [
            { text: "Completed", callback_data: "l:completed" },
            { text: "Failed", callback_data: "l:failed" },
          ],
        ],
      },
    };
  }

  async function enqueueAndPostTask({
    chatId,
    title,
    description,
    parent_id = null,
    priority,
    execution,
    replyToMessageId = undefined,
    note = null,
  }) {
    const taskEnvelope = await taskHandler.createTask({
      title,
      description,
      parent_id,
      priority,
      execution,
    });
    const taskId = taskEnvelope.data.id;

    await enqueueTaskWork(taskId, async () => {
      const sent = await sendMessage({
        chatId,
        text: buildTaskCardText(taskEnvelope, { statusOverride: "queued", note }),
        replyMarkup: buildTaskActionMarkup(taskId, "queued"),
        replyToMessageId,
      });
      if (sent?.message_id) {
        setBoundedMap(
          taskCards,
          taskId,
          { chatId: String(chatId), messageId: sent.message_id },
          MAX_TASK_CARDS,
        );
      }
    });

    return taskEnvelope;
  }

  async function handleEvent(event) {
    if (!running || !event?.record) {
      return;
    }
    const record = event.record;
    const taskId = record.id;

    if (event.type === "task.started") {
      await enqueueTaskWork(taskId, async () => {
        const existing = taskCards.get(taskId);
        const text = buildTaskCardText(record, { statusOverride: "running" });
        const replyMarkup = buildTaskActionMarkup(taskId, "running");

        if (existing) {
          await editMessageText({
            chatId: existing.chatId,
            messageId: existing.messageId,
            text,
            replyMarkup,
          });
          return;
        }

        if (!authorizedChatId) {
          return;
        }

        const sent = await sendMessage({
          chatId: authorizedChatId,
          text,
          replyMarkup,
          disableNotification: true,
        });
        if (sent?.message_id) {
          setBoundedMap(
            taskCards,
            taskId,
            { chatId: authorizedChatId, messageId: sent.message_id },
            MAX_TASK_CARDS,
          );
        }
      });
      return;
    }

    if (event.type === "task.finished" || event.type === "task.cancelled") {
      const status = record.status;
      if (!TERMINAL_TASK_STATUSES.includes(status)) {
        return;
      }

      await enqueueTaskWork(taskId, async () => {
        const tracked = taskCards.get(taskId);
        const targetChatId = tracked?.chatId ?? authorizedChatId;
        if (!targetChatId) {
          return;
        }

        if (tracked) {
          try {
            await editMessageText({
              chatId: tracked.chatId,
              messageId: tracked.messageId,
              text: buildTaskCardText(record),
              replyMarkup: buildTaskActionMarkup(taskId, status),
            });
          } catch {
            // Live card may have been deleted; continue with terminal push notification.
          }
        }

        const headerText = buildTaskCardText(record);
        const outputText = record.result?.data?.output?.text ?? "";
        const replyMarkup = buildTaskActionMarkup(taskId, status);

        if (outputText && outputText.length <= INLINE_OUTPUT_LIMIT) {
          const inlineCandidate = `${headerText}\n\n<b>Output:</b>\n<pre>${escapeHtml(outputText)}</pre>`;
          if (inlineCandidate.length <= TELEGRAM_MESSAGE_LIMIT) {
            await sendMessage({
              chatId: targetChatId,
              text: inlineCandidate,
              replyMarkup,
              disableNotification: false,
            });
            return;
          }
        }

        if (outputText) {
          const excerpt = truncateText(outputText, EXCERPT_LIMIT);
          const summaryMessage = `${headerText}\n\n<b>Output excerpt (full Markdown attached):</b>\n<pre>${escapeHtml(excerpt)}</pre>`;
          await sendMessage({
            chatId: targetChatId,
            text: summaryMessage,
            replyMarkup,
            disableNotification: false,
          });

          const title = record.task?.data?.title ?? "task";
          await sendDocument({
            chatId: targetChatId,
            filename: makeMarkdownFilename(title, taskId),
            content: outputText,
            caption: `${truncateText(title, 180)}\nID: ${taskId}`,
            disableNotification: true,
          });
          return;
        }

        await sendMessage({
          chatId: targetChatId,
          text: headerText,
          replyMarkup,
          disableNotification: false,
        });
      });
    }
  }

  async function handleCommand(chatId, text, messageId) {
    const spaceIdx = text.search(/\s/);
    const rawCmd = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
    const cmd = rawCmd.split("@")[0].toLowerCase();
    const arg = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case "/start":
      case "/help": {
        const helpLines = [
          "<b>task-aside Telegram Control</b>",
          "",
          "• Send any plain text to preview a 1-tap Draft Card.",
          "• <code>/run &lt;prompt&gt;</code> — enqueue immediately with active defaults.",
          "• Swipe-reply to any task card or result to resume/follow up.",
          "• <code>/list [status]</code> — recent tasks.",
          "• <code>/task &lt;id&gt;</code> — inspect task details.",
          "• <code>/cancel &lt;id&gt;</code> — cancel queued/running task.",
          "• <code>/retry &lt;id&gt;</code> — retry a finished/failed task.",
          "• <code>/use</code> — switch active agent, priority, or workspace.",
          "• <code>/health</code> — worker and queue status.",
        ];
        await sendMessage({ chatId, text: helpLines.join("\n") });
        return;
      }

      case "/use": {
        const view = buildDefaultsMessage();
        await sendMessage({ chatId, text: view.text, replyMarkup: view.replyMarkup });
        return;
      }

      case "/health": {
        const health = await healthHandler.getHealth({
          worker: getWorkerStatus?.(),
          transports,
        });
        const counts = health.worker?.counts ?? {};
        const lines = [
          `<b>💚 ${escapeHtml(health.name)} v${escapeHtml(health.version)}</b>`,
          `<b>Worker:</b> <code>${escapeHtml(health.worker?.workerId ?? "n/a")}</code> (running=${Boolean(health.worker?.running)}, busy=${Boolean(health.worker?.busy)})`,
          `<b>Agents:</b> <code>${escapeHtml((health.worker?.allowedAgents ?? []).join(", "))}</code>`,
          `<b>Queue:</b> queued=${counts.queued ?? 0}, running=${counts.running ?? 0}, completed=${counts.completed ?? 0}, failed=${counts.failed ?? 0}, cancelled=${counts.cancelled ?? 0}`,
        ];
        await sendMessage({ chatId, text: lines.join("\n") });
        return;
      }

      case "/run": {
        if (!arg) {
          await sendMessage({
            chatId,
            text: "Usage: <code>/run &lt;prompt&gt;</code>",
          });
          return;
        }
        await enqueueAndPostTask({
          chatId,
          title: buildTitle(arg),
          description: arg,
          priority: activeDefaults.priority,
          execution: {
            agent: activeDefaults.agent,
            cwd: resolveWorkspaceCwd(activeDefaults.workspace),
          },
          replyToMessageId: messageId,
        });
        return;
      }

      case "/list": {
        let statusFilter = null;
        if (arg) {
          const normalized = arg.toLowerCase();
          if (!TASK_STATUSES.includes(normalized)) {
            await sendMessage({
              chatId,
              text: `Invalid status. Allowed: <code>${escapeHtml(TASK_STATUSES.join(", "))}</code>`,
            });
            return;
          }
          statusFilter = normalized;
        }
        const { tasks } = await taskHandler.listTasks({
          ...(statusFilter ? { status: statusFilter } : {}),
          limit: 10,
        });
        const view = buildListMessage(tasks, statusFilter);
        await sendMessage({ chatId, text: view.text, replyMarkup: view.replyMarkup });
        return;
      }

      case "/task": {
        if (!arg) {
          await sendMessage({ chatId, text: "Usage: <code>/task &lt;uuid-v7&gt;</code>" });
          return;
        }
        const record = await taskHandler.getTask({ id: arg });
        const sent = await sendMessage({
          chatId,
          text: buildTaskCardText(record),
          replyMarkup: buildTaskActionMarkup(record.id, record.status),
        });
        if (sent?.message_id) {
          setBoundedMap(
            taskCards,
            record.id,
            { chatId: String(chatId), messageId: sent.message_id },
            MAX_TASK_CARDS,
          );
        }
        return;
      }

      case "/cancel": {
        if (!arg) {
          await sendMessage({ chatId, text: "Usage: <code>/cancel &lt;uuid-v7&gt;</code>" });
          return;
        }
        const cancelled = await taskHandler.cancelTask({ id: arg });
        await sendMessage({
          chatId,
          text: `🛑 Cancelled task <code>${escapeHtml(cancelled.id)}</code>.`,
        });
        return;
      }

      case "/retry": {
        if (!arg) {
          await sendMessage({ chatId, text: "Usage: <code>/retry &lt;uuid-v7&gt;</code>" });
          return;
        }
        const retried = await taskHandler.retryTask({ id: arg });
        const taskId = retried.data.id;
        await enqueueTaskWork(taskId, async () => {
          const sent = await sendMessage({
            chatId,
            text: buildTaskCardText(retried, {
              statusOverride: "queued",
              note: `Retried from ${arg.slice(0, 8)}`,
            }),
            replyMarkup: buildTaskActionMarkup(taskId, "queued"),
          });
          if (sent?.message_id) {
            setBoundedMap(
              taskCards,
              taskId,
              { chatId: String(chatId), messageId: sent.message_id },
              MAX_TASK_CARDS,
            );
          }
        });
        return;
      }

      default:
        await sendMessage({
          chatId,
          text: `Unknown command <code>${escapeHtml(cmd)}</code>. Send /help for commands.`,
        });
    }
  }

  async function handleReplyToResume(chatId, text, message) {
    const parentTaskId = extractTaskIdFromMessage(message.reply_to_message);
    if (!parentTaskId) {
      await sendMessage({
        chatId,
        text: "Could not find a task ID in the replied message.",
        replyToMessageId: message.message_id,
      });
      return;
    }

    const original = await taskHandler.getTask({ id: parentTaskId });
    const origExec = original.task?.data?.execution ?? {};
    const sessionId =
      original.result?.data?.execution?.session_id ?? origExec.session_id ?? null;

    await enqueueAndPostTask({
      chatId,
      title: buildTitle(text),
      description: text,
      parent_id: original.id,
      priority: original.priority,
      execution: {
        agent: origExec.agent ?? original.agent,
        model: origExec.model ?? null,
        effort: origExec.effort ?? null,
        cwd: origExec.cwd ?? null,
        permission_mode: origExec.permission_mode ?? null,
        timeout_ms: origExec.timeout_ms ?? null,
        session_id: sessionId,
      },
      replyToMessageId: message.message_id,
      note: sessionId
        ? `Resuming session ${truncateText(sessionId, 24)}`
        : `Follow-up to ${original.id.slice(0, 8)}`,
    });
  }

  async function handleMessage(message) {
    if (!isAuthorized(message?.from?.id, message?.chat?.id)) {
      return;
    }
    const chatId = String(message.chat.id);

    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) {
      return;
    }

    try {
      if (text.startsWith("/")) {
        await handleCommand(chatId, text, message.message_id);
        return;
      }

      if (message.reply_to_message) {
        await handleReplyToResume(chatId, text, message);
        return;
      }

      const draftId = randomBytes(4).toString("hex");
      const draft = {
        id: draftId,
        chatId,
        messageId: null,
        prompt: text,
        title: buildTitle(text),
        agent: activeDefaults.agent,
        priority: activeDefaults.priority,
        workspace: activeDefaults.workspace,
        createdAt: Date.now(),
      };
      setBoundedMap(drafts, draftId, draft, MAX_DRAFTS);

      const view = buildDraftCard(draft);
      const sent = await sendMessage({
        chatId,
        text: view.text,
        replyMarkup: view.replyMarkup,
        replyToMessageId: message.message_id,
      });
      if (sent?.message_id) {
        draft.messageId = sent.message_id;
      }
    } catch (error) {
      await sendMessage({
        chatId,
        text: `❌ ${escapeHtml(sanitizeToken(error instanceof Error ? error.message : String(error), botToken))}`,
      }).catch(() => {});
    }
  }

  async function handleCallbackQuery(callbackQuery) {
    if (!isAuthorized(callbackQuery?.from?.id, callbackQuery?.message?.chat?.id)) {
      return;
    }
    const chatId = String(callbackQuery.message.chat.id);

    const data = typeof callbackQuery.data === "string" ? callbackQuery.data : "";
    const messageId = callbackQuery.message?.message_id;

    try {
      if (data.startsWith("d:")) {
        const [, action, draftId] = data.split(":");
        const draft = drafts.get(draftId);
        if (!draft) {
          await answerCallback(callbackQuery.id, "Draft expired", true);
          return;
        }

        if (action === "del") {
          drafts.delete(draftId);
          await editMessageText({
            chatId,
            messageId,
            text: `<i>🗑 Draft discarded: ${escapeHtml(draft.title)}</i>`,
          });
          await answerCallback(callbackQuery.id, "Discarded");
          return;
        }

        if (action === "ag") {
          draft.agent = cycleNext(availableAgents, draft.agent);
        } else if (action === "pr") {
          draft.priority = cycleNext(TASK_PRIORITIES, draft.priority);
        } else if (action === "ws") {
          draft.workspace = cycleWorkspace(workspaceNames, draft.workspace);
        } else if (action === "run") {
          drafts.delete(draftId);
          const taskEnvelope = await taskHandler.createTask({
            title: draft.title,
            description: draft.prompt,
            priority: draft.priority,
            execution: {
              agent: draft.agent,
              cwd: resolveWorkspaceCwd(draft.workspace),
            },
          });
          const taskId = taskEnvelope.data.id;
          await enqueueTaskWork(taskId, async () => {
            setBoundedMap(
              taskCards,
              taskId,
              { chatId, messageId },
              MAX_TASK_CARDS,
            );
            await editMessageText({
              chatId,
              messageId,
              text: buildTaskCardText(taskEnvelope, { statusOverride: "queued" }),
              replyMarkup: buildTaskActionMarkup(taskId, "queued"),
            });
          });
          await answerCallback(callbackQuery.id, "Task queued");
          return;
        }

        const view = buildDraftCard(draft);
        await editMessageText({
          chatId,
          messageId,
          text: view.text,
          replyMarkup: view.replyMarkup,
        });
        await answerCallback(callbackQuery.id);
        return;
      }

      if (data.startsWith("u:")) {
        const [, field] = data.split(":");
        if (field === "ag") {
          activeDefaults.agent = cycleNext(availableAgents, activeDefaults.agent);
        } else if (field === "pr") {
          activeDefaults.priority = cycleNext(TASK_PRIORITIES, activeDefaults.priority);
        } else if (field === "ws") {
          activeDefaults.workspace = cycleWorkspace(workspaceNames, activeDefaults.workspace);
        }
        const view = buildDefaultsMessage();
        await editMessageText({
          chatId,
          messageId,
          text: view.text,
          replyMarkup: view.replyMarkup,
        });
        await answerCallback(callbackQuery.id, "Defaults updated");
        return;
      }

      if (data.startsWith("l:")) {
        const [, filter] = data.split(":");
        const statusFilter = filter === "all" ? null : filter;
        if (statusFilter && !TASK_STATUSES.includes(statusFilter)) {
          await answerCallback(callbackQuery.id, "Invalid filter", true);
          return;
        }
        const { tasks } = await taskHandler.listTasks({
          ...(statusFilter ? { status: statusFilter } : {}),
          limit: 10,
        });
        const view = buildListMessage(tasks, statusFilter);
        await editMessageText({
          chatId,
          messageId,
          text: view.text,
          replyMarkup: view.replyMarkup,
        });
        await answerCallback(callbackQuery.id);
        return;
      }

      if (data.startsWith("t:")) {
        const [, action, taskId] = data.split(":");
        if (action === "get") {
          const record = await taskHandler.getTask({ id: taskId });
          setBoundedMap(taskCards, record.id, { chatId, messageId }, MAX_TASK_CARDS);
          await editMessageText({
            chatId,
            messageId,
            text: buildTaskCardText(record),
            replyMarkup: buildTaskActionMarkup(record.id, record.status),
          });
          await answerCallback(callbackQuery.id, `Status: ${record.status}`);
          return;
        }

        if (action === "can") {
          const cancelled = await taskHandler.cancelTask({ id: taskId });
          setBoundedMap(taskCards, cancelled.id, { chatId, messageId }, MAX_TASK_CARDS);
          await editMessageText({
            chatId,
            messageId,
            text: buildTaskCardText(cancelled),
            replyMarkup: buildTaskActionMarkup(cancelled.id, cancelled.status),
          });
          await answerCallback(callbackQuery.id, "Task cancelled");
          return;
        }

        if (action === "ret") {
          const retried = await taskHandler.retryTask({ id: taskId });
          const newTaskId = retried.data.id;
          await enqueueTaskWork(newTaskId, async () => {
            const sent = await sendMessage({
              chatId,
              text: buildTaskCardText(retried, {
                statusOverride: "queued",
                note: `Retried from ${taskId.slice(0, 8)}`,
              }),
              replyMarkup: buildTaskActionMarkup(newTaskId, "queued"),
            });
            if (sent?.message_id) {
              setBoundedMap(
                taskCards,
                newTaskId,
                { chatId, messageId: sent.message_id },
                MAX_TASK_CARDS,
              );
            }
          });
          await answerCallback(callbackQuery.id, "Retry queued");
          return;
        }
      }

      await answerCallback(callbackQuery.id);
    } catch (error) {
      await answerCallback(
        callbackQuery.id,
        sanitizeToken(error instanceof Error ? error.message : String(error), botToken),
        true,
      );
    }
  }

  async function processUpdate(update) {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  }

  function start() {
    if (running) {
      return;
    }
    running = true;
    unsubscribeEvents = taskHandler.subscribe((event) => handleEvent(event));

    pollPromise = (async () => {
      while (running) {
        const controller = new AbortController();
        pollController = controller;
        try {
          const updates = await callApi(
            "getUpdates",
            {
              offset: updateOffset,
              timeout: pollTimeoutSeconds,
              allowed_updates: ["message", "callback_query"],
            },
            { signal: controller.signal },
          );

          if (!running) {
            break;
          }

          if (Array.isArray(updates)) {
            for (const update of updates) {
              if (typeof update.update_id === "number" && update.update_id >= updateOffset) {
                updateOffset = update.update_id + 1;
              }
              await processUpdate(update);
            }
          }
        } catch (error) {
          if (error?.name === "AbortError" || !running) {
            break;
          }
          logger.error(
            "[telegram] Polling error:",
            sanitizeToken(error instanceof Error ? error.message : String(error), botToken),
          );
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, retryDelayMs);
            timer.unref?.();
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        } finally {
          pollController = null;
        }
      }
    })();
  }

  async function stop() {
    running = false;
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    if (pollController) {
      pollController.abort();
    }
    if (pollPromise) {
      await pollPromise;
      pollPromise = null;
    }
    await Promise.allSettled(Array.from(taskWorkQueues.values()));
  }

  function status() {
    return {
      running,
      authorized: Boolean(authorizedUserId && authorizedChatId),
      activeDefaults: { ...activeDefaults },
    };
  }

  return {
    start,
    stop,
    status,
  };
}

const AUTH_COMMAND_REGEX = /^\/auth(?:@[a-z0-9_]+)?\s+(\S+)$/i;

/**
 * Interactive one-time pairing flow for Telegram Bot API.
 * Waits up to `ttlMs` for a private DM sending `/auth <token>` and returns verified `{ userId, chatId }`.
 */
export async function authenticateTelegram({
  botToken,
  apiBaseUrl = "https://api.telegram.org",
  ttlMs = 300_000,
  pollTimeoutSeconds = 25,
  token = undefined,
  fetchImpl = globalThis.fetch,
  signal = undefined,
  onPrompt = undefined,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch implementation is required for Telegram authentication");
  }
  if (typeof botToken !== "string" || botToken.trim() === "") {
    throw new Error("Telegram bot_token is required");
  }

  const normalizedToken = botToken.trim();
  const normalizedBaseUrl = apiBaseUrl.replace(/\/+$/, "");

  const callApi = (method, payload) =>
    callTelegramApi({
      fetchImpl,
      apiBaseUrl: normalizedBaseUrl,
      botToken: normalizedToken,
      method,
      payload,
      signal,
    });

  const me = await callApi("getMe", {});
  const botUsername = me?.username ?? "your_bot";

  let offset = 0;
  try {
    const stale = await callApi("getUpdates", {
      offset: -1,
      timeout: 0,
      allowed_updates: ["message"],
    });
    if (Array.isArray(stale) && stale.length > 0) {
      const maxId = stale.reduce(
        (acc, item) => (typeof item?.update_id === "number" ? Math.max(acc, item.update_id) : acc),
        -1,
      );
      if (maxId >= 0) {
        offset = maxId + 1;
      }
    }
  } catch (error) {
    if (error?.statusCode === 409) {
      throw new Error(
        "Telegram getUpdates conflict (409): another task-aside instance is already polling this bot. Stop it before running `task-aside auth telegram`.",
      );
    }
    throw error;
  }

  const authToken = token ?? randomBytes(16).toString("hex");
  const expiresInSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  onPrompt?.({
    botUsername,
    botUrl: `https://t.me/${botUsername}`,
    token: authToken,
    expiresInSeconds,
  });

  const deadline = Date.now() + ttlMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      const abortErr = new Error("Telegram authentication aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    const remainingSecs = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const timeout = Math.min(pollTimeoutSeconds, remainingSecs);

    let updates;
    try {
      updates = await callApi("getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message"],
      });
    } catch (error) {
      if (error?.statusCode === 409) {
        throw new Error(
          "Telegram getUpdates conflict (409): another task-aside instance is already polling this bot. Stop it before running `task-aside auth telegram`.",
        );
      }
      throw error;
    }

    if (!Array.isArray(updates)) {
      continue;
    }

    for (const update of updates) {
      if (typeof update?.update_id === "number" && update.update_id >= offset) {
        offset = update.update_id + 1;
      }

      const msg = update?.message;
      if (
        !msg ||
        msg.chat?.type !== "private" ||
        msg.from?.id === undefined ||
        msg.chat?.id === undefined ||
        typeof msg.text !== "string"
      ) {
        continue;
      }

      const match = AUTH_COMMAND_REGEX.exec(msg.text.trim());
      if (!match) {
        continue;
      }

      if (!timingSafeTokenMatch(authToken, match[1])) {
        continue;
      }

      // Acknowledge consumed update offset on Telegram servers before finishing
      try {
        await callApi("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
      } catch {
        // Best-effort acknowledgement
      }

      await callApi("setMyCommands", { commands: TELEGRAM_BOT_COMMANDS });

      const userId = String(msg.from.id);
      const chatId = String(msg.chat.id);
      await callApi("sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `✅ <b>Authenticated!</b>\nBound to <code>user_id=${escapeHtml(userId)}</code>, <code>chat_id=${escapeHtml(chatId)}</code>.`,
      });

      return {
        userId,
        chatId,
        username: msg.from.username ?? null,
        botUsername,
      };
    }
  }

  throw new Error(
    `Telegram authentication timed out after ${expiresInSeconds}s without a valid /auth <token> message.`,
  );
}
