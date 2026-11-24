import { readFileSync } from "node:fs";
import { createHealthHandler } from "#src/handlers/health.handler.js";
import { createTaskHandler } from "#src/handlers/task.handler.js";
import { createSupabaseTaskRepository } from "#src/repositories/task.repository.js";
import { createAgentService } from "#src/services/agent.service.js";
import { createHttpTransport } from "#src/transports/http.js";
import { createMcpTransport } from "#src/transports/mcp.js";
import { authenticateTelegram, createTelegramTransport } from "#src/transports/telegram.js";
import { createWorkerTransport } from "#src/transports/worker.js";
import { createTaskUsecase } from "#src/usecases/task.usecase.js";
import { ConfigError } from "#src/utilities/errors.js";
import { createFileLogger } from "#src/utilities/logger.js";
import { getPackageInfo } from "#src/utilities/package-info.js";
import { loadSettings, saveSettings, validateSettings } from "#src/utilities/settings.js";

/**
 * Composition root: wires settings -> repositories -> services -> usecases -> handlers -> transports.
 */
export async function startApp({
  configPath = undefined,
  settings = undefined,
  host = undefined,
  port = undefined,
  installSignalHandlers = true,
  taskRepository = null,
  agentService = null,
  executeTask = undefined,
  workerIntervalMs = undefined,
  logger = undefined,
  enableHttp = undefined,
  enableMcp = undefined,
  enableWorker = undefined,
  enableTelegram = undefined,
  telegramFetch = undefined,
  startWorker = undefined,
  promptAllowedWorkspaces = undefined,
} = {}) {
  const appInfo = getPackageInfo();

  let resolvedSettings;
  let settingsPath = null;
  let settingsCreated = false;

  if (settings !== undefined) {
    resolvedSettings = validateSettings(settings, {
      requireSupabase: !taskRepository,
      requireTelegram: enableTelegram,
    });
  } else {
    let loaded = loadSettings({
      configPath,
      requireSupabase: promptAllowedWorkspaces ? false : !taskRepository,
      requireTelegram: promptAllowedWorkspaces ? false : enableTelegram,
      requireAllowedWorkspaces: !promptAllowedWorkspaces,
    });
    const firstCreated = loaded.created;

    if (promptAllowedWorkspaces) {
      if (loaded.settings.allowed_workspaces.length === 0) {
        const entries = await promptAllowedWorkspaces({ settingsPath: loaded.path });
        const normalizedEntries = Array.isArray(entries)
          ? entries.map((entry) => String(entry ?? "").trim()).filter(Boolean)
          : [];
        if (normalizedEntries.length > 0) {
          const rawSettings = JSON.parse(readFileSync(loaded.path, "utf8"));
          rawSettings.allowed_workspaces = normalizedEntries;
          saveSettings(loaded.path, rawSettings);
        }
      }

      loaded = loadSettings({
        configPath: loaded.path,
        createIfMissing: false,
        requireSupabase: !taskRepository,
        requireTelegram: enableTelegram,
        requireAllowedWorkspaces: true,
      });
    }

    resolvedSettings = loaded.settings;
    settingsPath = loaded.path;
    settingsCreated = firstCreated;
  }

  const resolvedEnableHttp = enableHttp ?? resolvedSettings.transports.http;
  const resolvedEnableMcp = enableMcp ?? resolvedSettings.transports.mcp;
  const resolvedEnableWorker =
    enableWorker ?? startWorker ?? resolvedSettings.transports.worker;
  const resolvedEnableTelegram = enableTelegram ?? resolvedSettings.transports.telegram;

  if (
    !resolvedEnableHttp &&
    !resolvedEnableMcp &&
    !resolvedEnableWorker &&
    !resolvedEnableTelegram
  ) {
    throw new ConfigError(
      "At least one of transports.http, transports.mcp, transports.worker, or transports.telegram must be enabled",
    );
  }

  let resolvedLogger = logger;
  let ownsLogger = false;
  const logDir = resolvedSettings.logging.dir;
  if (!resolvedLogger) {
    resolvedLogger = createFileLogger({ dir: logDir });
    ownsLogger = true;
  }

  const transports = {
    http: resolvedEnableHttp,
    mcp: resolvedEnableMcp,
    worker: resolvedEnableWorker,
    telegram: resolvedEnableTelegram,
  };

  const resolvedTaskRepository =
    taskRepository ??
    createSupabaseTaskRepository({
      url: resolvedSettings.supabase.url,
      publishableKey: resolvedSettings.supabase.publishable_key,
      schema: resolvedSettings.supabase.schema,
      table: resolvedSettings.supabase.table,
    });

  const resolvedAgentService =
    agentService ??
    createAgentService({
      workerConfig: resolvedSettings.worker,
      allowedWorkspaces: resolvedSettings.allowed_workspaces,
      logger: resolvedLogger,
    });

  const taskUsecase = createTaskUsecase({
    taskRepository: resolvedTaskRepository,
    agentService: resolvedAgentService,
    executeTask,
    workerConfig: resolvedSettings.worker,
    allowedWorkspaces: resolvedSettings.allowed_workspaces,
    logger: resolvedLogger,
  });

  const taskHandler = createTaskHandler({ taskUsecase });
  const healthHandler = createHealthHandler({ taskUsecase, appInfo });

  const workerTransport = createWorkerTransport({
    taskHandler,
    intervalMs: workerIntervalMs ?? resolvedSettings.worker.poll_interval_ms,
    logger: resolvedLogger,
  });
  const getWorkerStatus = () => workerTransport.status();

  const mcpTransport = resolvedEnableMcp
    ? createMcpTransport({
        taskHandler,
        version: appInfo.version,
        logger: resolvedLogger,
      })
    : null;

  const shouldStartHttpServer = resolvedEnableHttp || resolvedEnableMcp;
  const httpTransport = shouldStartHttpServer
    ? createHttpTransport({
        healthHandler,
        taskHandler,
        mcpTransport,
        enableHttp: resolvedEnableHttp,
        enableMcp: resolvedEnableMcp,
        getWorkerStatus,
        transports,
        logger: resolvedLogger,
      })
    : null;

  const telegramTransport = resolvedEnableTelegram
    ? createTelegramTransport({
        taskHandler,
        healthHandler,
        telegramConfig: resolvedSettings.telegram,
        workerConfig: resolvedSettings.worker,
        allowedWorkspaces: resolvedSettings.allowed_workspaces,
        getWorkerStatus,
        transports,
        ...(telegramFetch ? { fetchImpl: telegramFetch } : {}),
        logger: resolvedLogger,
      })
    : null;

  if (resolvedEnableWorker) {
    workerTransport.start();
  }
  if (telegramTransport) {
    telegramTransport.start();
  }

  let binding = { host: null, port: null, url: null };
  if (httpTransport) {
    const resolvedHost = host ?? resolvedSettings.server.host;
    const resolvedPort = port ?? resolvedSettings.server.port;
    try {
      binding = await httpTransport.listen({ host: resolvedHost, port: resolvedPort });
    } catch (error) {
      if (telegramTransport) {
        await telegramTransport.stop();
      }
      await workerTransport.stop();
      if (ownsLogger) {
        await resolvedLogger.close?.();
      }
      throw error;
    }
  }

  resolvedLogger.log(`${appInfo.name} v${appInfo.version} ready`);
  if (settingsPath) {
    resolvedLogger.log(
      `Settings: ${settingsPath}${settingsCreated ? " (created default)" : ""}`,
    );
  }
  resolvedLogger.log(`HTTP:     ${resolvedEnableHttp ? `${binding.url}/tasks` : "disabled"}`);
  resolvedLogger.log(`MCP:      ${resolvedEnableMcp ? `${binding.url}/mcp` : "disabled"}`);
  if (binding.url) {
    resolvedLogger.log(`Health:   ${binding.url}/health`);
  }
  resolvedLogger.log(
    `Worker:   ${resolvedEnableWorker ? `running (id=${resolvedSettings.worker.worker_id})` : "disabled"}`,
  );
  resolvedLogger.log(
    `Telegram: ${resolvedEnableTelegram ? `running (chat=${resolvedSettings.telegram.chat_id})` : "disabled"}`,
  );
  resolvedLogger.log(`Agents:   ${resolvedSettings.worker.allowed_agents.join(", ")}`);
  resolvedLogger.log(`Workspaces: ${resolvedSettings.allowed_workspaces.join(", ")}`);
  resolvedLogger.log(`Runs:     ${resolvedSettings.worker.runs_dir}`);
  if (ownsLogger && resolvedLogger.getCurrentLogFile) {
    resolvedLogger.log(`Logs:     ${resolvedLogger.getCurrentLogFile()}`);
  }

  let stopping = false;
  let stopPromise = null;

  async function stop() {
    if (stopping) {
      return stopPromise;
    }
    stopping = true;
    stopPromise = (async () => {
      if (httpTransport) {
        await httpTransport.close();
      }
      await workerTransport.stop();
      if (telegramTransport) {
        await telegramTransport.stop();
      }
      if (ownsLogger) {
        await resolvedLogger.close?.();
      }
    })();
    return stopPromise;
  }

  if (installSignalHandlers) {
    const shutdown = () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  return {
    ...binding,
    settingsPath,
    logDir,
    runsDir: resolvedSettings.worker.runs_dir,
    allowedWorkspaces: resolvedSettings.allowed_workspaces,
    transports,
    workerTransport,
    telegramTransport,
    httpTransport,
    stop,
  };
}

/**
 * Interactive Telegram pairing flow: generates a 5-minute token, waits for `/auth <token>`,
 * and persists `telegram.user_id`, `telegram.chat_id`, and `transports.telegram = true`.
 */
export async function authTelegram({
  configPath = undefined,
  ttlMs = 300_000,
  pollTimeoutSeconds = undefined,
  token = undefined,
  fetchImpl = undefined,
  signal = undefined,
  logger = console,
} = {}) {
  const { settings, path: settingsPath } = loadSettings({
    configPath,
    requireSupabase: false,
    requireTelegram: false,
    requireAllowedWorkspaces: false,
  });

  if (!settings.telegram.bot_token) {
    throw new ConfigError(
      `telegram.bot_token is required in ${settingsPath} before running auth telegram`,
    );
  }

  const result = await authenticateTelegram({
    botToken: settings.telegram.bot_token,
    apiBaseUrl: settings.telegram.api_base_url,
    ttlMs,
    pollTimeoutSeconds: pollTimeoutSeconds ?? settings.telegram.poll_timeout_seconds,
    token,
    fetchImpl,
    signal,
    onPrompt: ({ botUrl, token: pairToken, expiresInSeconds }) => {
      logger.log(`Open ${botUrl} in Telegram and send:`);
      logger.log(`  /auth ${pairToken}`);
      logger.log(`Waiting up to ${expiresInSeconds}s for confirmation...`);
    },
  });

  const rawSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  rawSettings.transports = {
    ...(rawSettings.transports ?? {}),
    telegram: true,
  };
  const updatedTelegram = {
    ...(rawSettings.telegram ?? {}),
    user_id: result.userId,
    chat_id: result.chatId,
  };
  delete updatedTelegram.allowed_chat_ids;
  rawSettings.telegram = updatedTelegram;

  saveSettings(settingsPath, rawSettings);
  loadSettings({
    configPath: settingsPath,
    requireSupabase: false,
    requireTelegram: true,
    requireAllowedWorkspaces: false,
  });

  logger.log(
    `Telegram authenticated: user_id=${result.userId}, chat_id=${result.chatId}. Saved to ${settingsPath} with transports.telegram=true.`,
  );

  return {
    ...result,
    settingsPath,
  };
}
