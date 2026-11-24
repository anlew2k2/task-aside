import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authTelegram, startApp } from "#src/index.js";
import { createInMemoryTaskRepository } from "#src/repositories/task.repository.js";
import { loadSettings } from "#src/utilities/settings.js";

function createMemoryLogger() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log(...args) {
      logs.push(args);
    },
    error(...args) {
      errors.push(args);
    },
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function startMockTelegramServer({ conflict409 = false } = {}) {
  let nextUpdateId = 1;
  let nextMessageId = 100;
  let updates = [];
  const waitingPollers = [];
  const calls = [];
  const messages = new Map();

  function dispatchUpdate(update) {
    updates.push(update);
    for (const wake of waitingPollers.splice(0, waitingPollers.length)) {
      wake();
    }
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBuffer = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? "";
    const methodMatch = /\/bot[^/]+\/([^/?]+)/.exec(req.url ?? "");
    const method = methodMatch ? methodMatch[1] : "unknown";

    if (method === "getMe") {
      calls.push({ method });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: { id: 9293254056, is_bot: true, username: "task_aside_bot" },
        }),
      );
      return;
    }

    if (method === "getUpdates") {
      const body = rawBuffer.length ? JSON.parse(rawBuffer.toString("utf8")) : {};
      calls.push({ method, body });

      if (conflict409) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 409,
            description: "Conflict: terminated by other getUpdates request",
          }),
        );
        return;
      }

      if (body.offset === -1) {
        const tail = updates.length ? [updates[updates.length - 1]] : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: tail }));
        return;
      }

      const minOffset = typeof body.offset === "number" ? body.offset : 0;
      if (minOffset > 0) {
        updates = updates.filter((u) => u.update_id >= minOffset);
      }

      const immediate = updates.filter((u) => u.update_id >= minOffset);
      if (immediate.length > 0 || (body.timeout ?? 0) === 0) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: immediate }));
        return;
      }

      const timeoutMs = Math.min((body.timeout ?? 1) * 1000, 1500);
      await new Promise((resolve) => {
        let timer = null;
        const finish = () => {
          if (timer) {
            clearTimeout(timer);
          }
          const idx = waitingPollers.indexOf(finish);
          if (idx !== -1) {
            waitingPollers.splice(idx, 1);
          }
          resolve();
        };
        waitingPollers.push(finish);
        timer = setTimeout(finish, timeoutMs);
        res.on("close", finish);
      });

      if (!res.writableEnded && !res.destroyed) {
        const ready = updates.filter((u) => u.update_id >= minOffset);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: ready }));
      }
      return;
    }

    if (method === "sendDocument") {
      const rawText = rawBuffer.toString("utf8");
      calls.push({ method, contentType, rawText });
      const message_id = nextMessageId++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id, chat: { id: 1001 } } }));
      return;
    }

    const body = rawBuffer.length ? JSON.parse(rawBuffer.toString("utf8")) : {};
    calls.push({ method, body });

    if (method === "sendMessage") {
      const message_id = nextMessageId++;
      const stored = {
        message_id,
        chat: { id: Number(body.chat_id) || body.chat_id },
        text: body.text,
        reply_markup: body.reply_markup,
        disable_notification: body.disable_notification,
      };
      messages.set(message_id, stored);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: stored }));
      return;
    }

    if (method === "editMessageText") {
      const existing = messages.get(body.message_id) ?? {
        message_id: body.message_id,
        chat: { id: Number(body.chat_id) || body.chat_id },
      };
      existing.text = body.text;
      existing.reply_markup = body.reply_markup;
      messages.set(body.message_id, existing);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: existing }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: true }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    messages,
    pushMessage({
      chatId,
      userId = chatId,
      chatType = "private",
      text,
      username = "tester",
      replyToMessage = undefined,
    }) {
      const msg = {
        message_id: nextMessageId++,
        from: { id: userId, username },
        chat: { id: chatId, type: chatType },
        text,
        ...(replyToMessage ? { reply_to_message: replyToMessage } : {}),
      };
      dispatchUpdate({ update_id: nextUpdateId++, message: msg });
      return msg;
    },
    pushCallback({ chatId, userId = chatId, messageId, data }) {
      dispatchUpdate({
        update_id: nextUpdateId++,
        callback_query: {
          id: `cb-${nextUpdateId}`,
          from: { id: userId },
          message: { message_id: messageId, chat: { id: chatId, type: "private" } },
          data,
        },
      });
    },
    close: async () => {
      for (const wake of waitingPollers.splice(0, waitingPollers.length)) {
        wake();
      }
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

function makeFakeAgentScript(filePath, { output = "Done!", sessionId = "sess-tg-1", delayMs = 20 } = {}) {
  writeFileSync(
    filePath,
    `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: "result",
      is_error: false,
      result: ${JSON.stringify(output)},
      session_id: ${JSON.stringify(sessionId)},
      usage: { input_tokens: 10, output_tokens: 5 }
    }));
  }, ${delayMs});
});
`,
    "utf8",
  );
  chmodSync(filePath, 0o755);
}

test("Telegram transport enforces user_id + chat_id, handles Draft Card, worker updates, commands, and stop()", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-tg-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fakeClaude = join(dir, "fake-claude.mjs");
  const fakeCodex = join(dir, "fake-codex.mjs");
  makeFakeAgentScript(fakeClaude, { output: "Short Claude result", sessionId: "sess-claude-1" });
  makeFakeAgentScript(fakeCodex, { output: "Short Codex result", sessionId: "sess-codex-1" });

  const mockTg = await startMockTelegramServer();
  t.after(() => mockTg.close());

  const taskRepository = createInMemoryTaskRepository();
  const app = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: {
      server: { host: "127.0.0.1", port: 0 },
      transports: { http: true, mcp: true, worker: true, telegram: true },
      allowed_workspaces: [dir],
      supabase: { url: "", publishable_key: "", schema: "public", table: "tasks" },
      telegram: {
        bot_token: "test-bot-token-secret",
        user_id: 2002,
        chat_id: 1001,
        default_agent: "codex",
        default_priority: "P1",
        poll_timeout_seconds: 1,
        api_base_url: mockTg.url,
      },
      logging: { dir: join(dir, "logs") },
      worker: {
        worker_id: "tg-worker",
        poll_interval_ms: 20,
        lease_seconds: 60,
        heartbeat_interval_ms: 5000,
        runs_dir: join(dir, "runs"),
        allowed_agents: ["codex", "claude"],
        default_permission_mode: "workspace",
        max_permission_mode: "workspace",
        default_timeout_ms: 5000,
        agents: {
          agy: { executable: "agy", default_model: null, default_effort: null },
          claude: { executable: fakeClaude, default_model: null, default_effort: null },
          codex: { executable: fakeCodex, default_model: null, default_effort: null, skip_git_repo_check: false },
        },
      },
    },
    logger: createMemoryLogger(),
  });

  // 1. Unauthorized chat_id or mismatched user_id is ignored
  mockTg.pushMessage({ chatId: 9999, userId: 2002, text: "Wrong chat" });
  mockTg.pushMessage({ chatId: 1001, userId: 8888, text: "Wrong user in same chat" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(mockTg.calls.filter((c) => c.method === "sendMessage").length, 0);

  // 2. Authorized user_id + chat_id creates Draft Card -> cycle agent, priority -> Run
  mockTg.pushMessage({ chatId: 1001, userId: 2002, text: "Audit repo authentication\nCheck edge cases" });
  await waitFor(() => mockTg.calls.some((c) => c.method === "sendMessage" && c.body.text.includes("New Task Draft")));

  const draftCall = mockTg.calls.find(
    (c) => c.method === "sendMessage" && c.body.text.includes("New Task Draft"),
  );
  const draftMsgId = Array.from(mockTg.messages.keys())[0];
  const runCallback = draftCall.body.reply_markup.inline_keyboard[0][0].callback_data;
  const draftId = runCallback.split(":")[2];

  mockTg.pushCallback({ chatId: 1001, userId: 2002, messageId: draftMsgId, data: `d:ag:${draftId}` });
  mockTg.pushCallback({ chatId: 1001, userId: 2002, messageId: draftMsgId, data: `d:pr:${draftId}` });
  await waitFor(() =>
    mockTg.calls.some(
      (c) =>
        c.method === "editMessageText" &&
        c.body.text.includes("claude") &&
        c.body.text.includes("P2"),
    ),
  );

  // Tap Run
  mockTg.pushCallback({ chatId: 1001, userId: 2002, messageId: draftMsgId, data: `d:run:${draftId}` });

  await waitFor(() =>
    mockTg.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        c.body.disable_notification === false &&
        c.body.text.includes("Short Claude result"),
    ),
  );

  assert.ok(
    mockTg.calls.some(
      (c) => c.method === "editMessageText" && c.body.text.includes("running"),
    ),
  );

  // 3. External MCP-created task notifies Telegram (silent running + fresh push completed)
  const mcpCreateRes = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_task",
        arguments: {
          title: "MCP external task",
          description: "Run via MCP",
          priority: "P0",
          execution: { agent: "codex" },
        },
      },
    }),
  });
  const mcpTask = JSON.parse((await mcpCreateRes.json()).result.content[0].text);

  await waitFor(() =>
    mockTg.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        c.body.disable_notification === true &&
        c.body.text.includes(mcpTask.data.id),
    ),
  );
  await waitFor(() =>
    mockTg.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        c.body.disable_notification === false &&
        c.body.text.includes(mcpTask.data.id) &&
        c.body.text.includes("Short Codex result"),
    ),
  );

  // 4. Commands: /health, /use, /list, /task, /run
  mockTg.pushMessage({ chatId: 1001, userId: 2002, text: "/health" });
  mockTg.pushMessage({ chatId: 1001, userId: 2002, text: "/use" });
  mockTg.pushMessage({ chatId: 1001, userId: 2002, text: "/list completed" });
  mockTg.pushMessage({ chatId: 1001, userId: 2002, text: `/task ${mcpTask.data.id}` });
  mockTg.pushMessage({ chatId: 1001, userId: 2002, text: "/run Instant command task" });

  await waitFor(() =>
    mockTg.calls.filter((c) => c.method === "sendMessage" && c.body.text.includes("Instant command task")).length >= 2,
  );

  assert.ok(mockTg.calls.some((c) => c.method === "sendMessage" && c.body.text.includes("Active Telegram Defaults")));
  assert.ok(mockTg.calls.some((c) => c.method === "sendMessage" && c.body.text.includes("Tasks (completed)")));
  assert.ok(mockTg.calls.some((c) => c.method === "sendMessage" && c.body.text.includes("tg-worker")));

  const stopStart = Date.now();
  await app.stop();
  assert.ok(Date.now() - stopStart < 2_000);
});

test("Telegram sends .md attachment for long outputs and supports restart-safe Reply-to-Resume", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-tg-hitl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const longMarkdown = `# Long Report\n\n${"A".repeat(3500)}\n\n## End`;
  const fakeCodex = join(dir, "fake-codex-long.mjs");
  makeFakeAgentScript(fakeCodex, { output: longMarkdown, sessionId: "sess-long-99" });

  const mockTg = await startMockTelegramServer();
  t.after(() => mockTg.close());

  const taskRepository = createInMemoryTaskRepository();
  const baseSettings = {
    server: { host: "127.0.0.1", port: 0 },
    transports: { http: false, mcp: false, worker: true, telegram: true },
    allowed_workspaces: [dir],
    supabase: { url: "", publishable_key: "", schema: "public", table: "tasks" },
    telegram: {
      bot_token: "test-bot-token-long",
      user_id: 2002,
      chat_id: 1001,
      default_agent: "codex",
      default_priority: "P1",
      poll_timeout_seconds: 1,
      api_base_url: mockTg.url,
    },
    logging: { dir: join(dir, "logs") },
    worker: {
      worker_id: "tg-long-worker",
      poll_interval_ms: 20,
      lease_seconds: 60,
      heartbeat_interval_ms: 5000,
      runs_dir: join(dir, "runs"),
      allowed_agents: ["codex"],
      default_permission_mode: "workspace",
      max_permission_mode: "workspace",
      default_timeout_ms: 5000,
      agents: {
        agy: { executable: "agy", default_model: null, default_effort: null },
        claude: { executable: "claude", default_model: null, default_effort: null },
        codex: { executable: fakeCodex, default_model: null, default_effort: null, skip_git_repo_check: false },
      },
    },
  };

  const app1 = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: baseSettings,
    logger: createMemoryLogger(),
  });

  mockTg.pushMessage({ chatId: 1001, userId: 2002, text: "/run Generate long report" });

  await waitFor(() => mockTg.calls.some((c) => c.method === "sendDocument"));
  const docCall = mockTg.calls.find((c) => c.method === "sendDocument");
  assert.match(docCall.rawText, /generate-long-report-/);

  const completedTasks = await taskRepository.findAll({ status: "completed" });
  assert.equal(completedTasks.length, 1);
  const originalTask = completedTasks[0];
  assert.match(docCall.rawText, new RegExp(originalTask.id));

  await waitFor(() =>
    mockTg.calls.some((c) => c.method === "getUpdates" && c.body.offset >= 2),
  );
  await app1.stop();

  const app2 = await startApp({
    installSignalHandlers: false,
    taskRepository,
    settings: baseSettings,
    logger: createMemoryLogger(),
  });
  t.after(() => app2.stop());

  mockTg.pushMessage({
    chatId: 1001,
    userId: 2002,
    text: "Now summarize the findings in 3 bullets",
    replyToMessage: {
      message_id: 555,
      caption: `Generate long report\nID: ${originalTask.id}`,
    },
  });

  await waitFor(async () => (await taskRepository.findAll({ parent_id: originalTask.id })).length === 1);
  const [followUp] = await taskRepository.findAll({ parent_id: originalTask.id });
  assert.equal(followUp.parent_id, originalTask.id);
  assert.equal(followUp.agent, "codex");
  assert.equal(followUp.task.data.execution.cwd, originalTask.result.data.execution.cwd);
  assert.equal(followUp.task.data.execution.session_id, "sess-long-99");
  assert.equal(followUp.task.data.description, "Now summarize the findings in 3 bullets");
});

test("authTelegram pairs user_id + chat_id via /auth <token>, sets commands, and enables telegram in settings.json", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-tg-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const mockTg = await startMockTelegramServer();
  t.after(() => mockTg.close());

  const configPath = join(dir, "settings.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      transports: { http: true, mcp: true, worker: true, telegram: false },
      telegram: {
        bot_token: "test-pair-token",
        api_base_url: mockTg.url,
      },
    }),
    "utf8",
  );

  const logger = createMemoryLogger();
  const authPromise = authTelegram({
    configPath,
    ttlMs: 5_000,
    pollTimeoutSeconds: 1,
    token: "pair1234abcd",
    logger,
  });

  await waitFor(() => logger.logs.some((args) => args.join(" ").includes("/auth pair1234abcd")));

  // Wrong token and group chat must be ignored
  mockTg.pushMessage({ chatId: -555, userId: 777, chatType: "group", text: "/auth pair1234abcd" });
  mockTg.pushMessage({ chatId: 1001, userId: 777, chatType: "private", text: "/auth wrongtoken00" });
  mockTg.pushMessage({ chatId: 3333, userId: 4444, chatType: "private", text: "/auth pair1234abcd" });

  const res = await authPromise;
  assert.equal(res.userId, "4444");
  assert.equal(res.chatId, "3333");
  assert.equal(res.botUsername, "task_aside_bot");

  const savedRaw = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(savedRaw.transports.telegram, true);
  assert.equal(savedRaw.telegram.user_id, "4444");
  assert.equal(savedRaw.telegram.chat_id, "3333");

  const { settings } = loadSettings({
    configPath,
    requireSupabase: false,
    requireAllowedWorkspaces: false,
  });
  assert.equal(settings.transports.telegram, true);
  assert.equal(settings.telegram.user_id, "4444");
  assert.equal(settings.telegram.chat_id, "3333");

  assert.ok(mockTg.calls.some((c) => c.method === "setMyCommands"));
  assert.ok(
    mockTg.calls.some(
      (c) =>
        c.method === "sendMessage" &&
        c.body.chat_id === "3333" &&
        c.body.text.includes("Authenticated"),
    ),
  );
  // Acknowledge update offset (offset > 0, timeout 0)
  assert.ok(
    mockTg.calls.some(
      (c) => c.method === "getUpdates" && c.body.timeout === 0 && c.body.offset >= 4,
    ),
  );
});

test("authTelegram fails fast on 409 Conflict and times out when no valid /auth arrives", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-tg-auth-err-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const conflictTg = await startMockTelegramServer({ conflict409: true });
  t.after(() => conflictTg.close());

  const conflictConfig = join(dir, "conflict.json");
  writeFileSync(
    conflictConfig,
    JSON.stringify({
      telegram: { bot_token: "tok-409", api_base_url: conflictTg.url },
    }),
    "utf8",
  );

  await assert.rejects(
    () => authTelegram({ configPath: conflictConfig, ttlMs: 2_000, logger: createMemoryLogger() }),
    /409/,
  );

  const timeoutTg = await startMockTelegramServer();
  t.after(() => timeoutTg.close());

  const timeoutConfig = join(dir, "timeout.json");
  writeFileSync(
    timeoutConfig,
    JSON.stringify({
      telegram: { bot_token: "tok-timeout", api_base_url: timeoutTg.url },
    }),
    "utf8",
  );

  await assert.rejects(
    () =>
      authTelegram({
        configPath: timeoutConfig,
        ttlMs: 120,
        pollTimeoutSeconds: 1,
        logger: createMemoryLogger(),
      }),
    /timed out/i,
  );
});
