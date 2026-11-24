import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
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
import { collectConfiguredSecrets, redactSecrets } from "#src/utilities/redaction.js";
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

  const secrets = collectConfiguredSecrets(resolvedSettings);

  let resolvedLogger = logger;
  let ownsLogger = false;
  const logDir = resolvedSettings.logging.dir;
  if (!resolvedLogger) {
    resolvedLogger = createFileLogger({ dir: logDir, secrets });
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
      secrets,
      logger: resolvedLogger,
    });

  const taskUsecase = createTaskUsecase({
    taskRepository: resolvedTaskRepository,
    agentService: resolvedAgentService,
    executeTask,
    workerConfig: resolvedSettings.worker,
    allowedWorkspaces: resolvedSettings.allowed_workspaces,
    secrets,
    logger: resolvedLogger,
  });

  const taskHandler = createTaskHandler({ taskUsecase });
  const healthHandler = createHealthHandler({ taskUsecase, appInfo });

  const workerTransport = createWorkerTransport({
    taskHandler,
    intervalMs: workerIntervalMs ?? resolvedSettings.worker.poll_interval_ms,
    maxIntervalMs: resolvedSettings.worker.poll_max_interval_ms,
    logger: resolvedLogger,
  });
  const getWorkerStatus = () => workerTransport.status();

  const mcpTransport = resolvedEnableMcp
    ? createMcpTransport({
        taskHandler,
        healthHandler,
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

/**
 * Intake-only STDIO MCP server entrypoint (`task-aside mcp`).
 * Keeps stdout strictly reserved for newline-delimited JSON-RPC responses.
 */
export async function startStdioMcp({
  configPath = undefined,
  settings = undefined,
  taskRepository = null,
  logger = undefined,
  stdin = process.stdin,
  stdout = process.stdout,
  installSignalHandlers = true,
} = {}) {
  const appInfo = getPackageInfo();

  let resolvedSettings;
  let settingsPath = null;
  if (settings !== undefined) {
    resolvedSettings = validateSettings(settings, {
      requireSupabase: !taskRepository,
      requireTelegram: false,
      requireAllowedWorkspaces: false,
    });
  } else {
    const loaded = loadSettings({
      configPath,
      requireSupabase: !taskRepository,
      requireTelegram: false,
      requireAllowedWorkspaces: false,
    });
    resolvedSettings = loaded.settings;
    settingsPath = loaded.path;
  }

  const secrets = collectConfiguredSecrets(resolvedSettings);
  let resolvedLogger = logger;
  let ownsLogger = false;
  if (!resolvedLogger) {
    resolvedLogger = createFileLogger({
      dir: resolvedSettings.logging.dir,
      consoleSink: null,
      secrets,
    });
    ownsLogger = true;
  }

  const resolvedTaskRepository =
    taskRepository ??
    createSupabaseTaskRepository({
      url: resolvedSettings.supabase.url,
      publishableKey: resolvedSettings.supabase.publishable_key,
      schema: resolvedSettings.supabase.schema,
      table: resolvedSettings.supabase.table,
    });

  const taskUsecase = createTaskUsecase({
    taskRepository: resolvedTaskRepository,
    workerConfig: resolvedSettings.worker,
    allowedWorkspaces: resolvedSettings.allowed_workspaces,
    secrets,
    logger: resolvedLogger,
  });

  const taskHandler = createTaskHandler({ taskUsecase });
  const healthHandler = createHealthHandler({ taskUsecase, appInfo });
  const mcpTransport = createMcpTransport({
    taskHandler,
    healthHandler,
    version: appInfo.version,
    logger: resolvedLogger,
  });

  const controller = new AbortController();
  const stdio = mcpTransport.startStdio({
    stdin,
    stdout,
    signal: controller.signal,
  });

  resolvedLogger.log(`${appInfo.name} v${appInfo.version} STDIO MCP ready`);

  let stopped = false;
  async function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    controller.abort();
    await stdio.done;
    if (ownsLogger) {
      await resolvedLogger.close?.();
    }
  }

  if (installSignalHandlers) {
    const onSignal = () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return {
    settingsPath,
    logDir: resolvedSettings.logging.dir,
    done: stdio.done,
    stop,
  };
}

function defaultCheckExecutable(commandName) {
  if (typeof commandName !== "string" || commandName.trim() === "") {
    return { ok: false, path: null };
  }
  const trimmed = commandName.trim();
  const isPath = trimmed.includes("/") || trimmed.includes("\\") || isAbsolute(trimmed);
  const candidates = isPath
    ? [trimmed]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, trimmed));

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      const st = statSync(candidate);
      if (!st.isFile()) {
        continue;
      }
      accessSync(candidate, fsConstants.X_OK);
      return { ok: true, path: candidate };
    } catch {
      // Continue scanning candidates
    }
  }
  return { ok: false, path: null };
}

/**
 * Diagnostic check command (`task-aside doctor`) verifying settings, workspaces,
 * writable directories, Supabase table/RPCs, and configured agent binaries.
 */
export async function runDoctor({
  configPath = undefined,
  settings = undefined,
  fetchImpl = globalThis.fetch,
  checkExecutable = defaultCheckExecutable,
  logger = console,
} = {}) {
  const checks = [];
  let resolvedSettings = null;
  let settingsPath = null;
  let secrets = [];

  try {
    if (settings !== undefined) {
      resolvedSettings = validateSettings(settings, {
        requireSupabase: true,
        requireTelegram: undefined,
        requireAllowedWorkspaces: true,
      });
      checks.push({
        name: "settings",
        status: "ok",
        message: "In-memory settings valid",
      });
    } else {
      const loaded = loadSettings({
        configPath,
        createIfMissing: false,
        requireSupabase: true,
        requireTelegram: undefined,
        requireAllowedWorkspaces: true,
      });
      resolvedSettings = loaded.settings;
      settingsPath = loaded.path;
      let permWarn = false;
      try {
        const mode = statSync(settingsPath).mode & 0o077;
        permWarn = mode !== 0;
      } catch {
        // Ignore on filesystems without POSIX mode bits
      }
      checks.push({
        name: "settings",
        status: permWarn ? "warn" : "ok",
        message: permWarn
          ? `Settings valid (${settingsPath}), but permissions are broader than 0600`
          : `Settings valid (${settingsPath})`,
      });
    }
    secrets = collectConfiguredSecrets(resolvedSettings);
  } catch (error) {
    checks.push({
      name: "settings",
      status: "fail",
      message: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
    });
    for (const check of checks) {
      const prefix = check.status === "ok" ? "[OK]" : check.status === "warn" ? "[WARN]" : "[FAIL]";
      (check.status === "fail" ? logger.error : logger.log)(`${prefix} ${check.name}: ${check.message}`);
    }
    return { ok: false, checks };
  }

  // Workspaces check
  const missingWorkspaces = [];
  for (const ws of resolvedSettings.allowed_workspaces) {
    try {
      if (!existsSync(ws) || !statSync(ws).isDirectory()) {
        missingWorkspaces.push(ws);
      }
    } catch {
      missingWorkspaces.push(ws);
    }
  }
  checks.push(
    missingWorkspaces.length === 0
      ? {
          name: "workspaces",
          status: "ok",
          message: `Verified ${resolvedSettings.allowed_workspaces.length} workspace path(s)`,
        }
      : {
          name: "workspaces",
          status: "fail",
          message: `Missing or non-directory allowed_workspaces: ${missingWorkspaces.join(", ")}`,
        },
  );

  // Writable directories check
  const dirFailures = [];
  for (const [label, dirPath] of [
    ["logging.dir", resolvedSettings.logging.dir],
    ["worker.runs_dir", resolvedSettings.worker.runs_dir],
  ]) {
    try {
      mkdirSync(dirPath, { recursive: true });
      accessSync(dirPath, fsConstants.W_OK);
    } catch (error) {
      dirFailures.push(`${label} (${dirPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  checks.push(
    dirFailures.length === 0
      ? {
          name: "directories",
          status: "ok",
          message: `Writable logs (${resolvedSettings.logging.dir}) and runs (${resolvedSettings.worker.runs_dir})`,
        }
      : {
          name: "directories",
          status: "fail",
          message: dirFailures.join("; "),
        },
  );

  // Supabase connectivity & RPC / migration check
  const { url, publishable_key: publishableKey, schema, table } = resolvedSettings.supabase;
  const baseUrl = url.replace(/\/+$/, "");
  const encodedTable = encodeURIComponent(table);
  const baseHeaders = {
    apikey: publishableKey,
    authorization: `Bearer ${publishableKey}`,
    "content-type": "application/json",
    ...(schema !== "public"
      ? {
          "Accept-Profile": schema,
          "Content-Profile": schema,
        }
      : {}),
  };

  try {
    const tableRes = await fetchImpl(`${baseUrl}/rest/v1/${encodedTable}?select=id&limit=1`, {
      method: "GET",
      headers: baseHeaders,
    });
    if (!tableRes.ok) {
      checks.push({
        name: "supabase",
        status: "fail",
        message: redactSecrets(
          `Supabase table "${schema}.${table}" check failed with HTTP ${tableRes.status}`,
          secrets,
        ),
      });
    } else {
      let openApiPaths = null;
      let openApiDefs = null;
      try {
        const schemaRes = await fetchImpl(`${baseUrl}/rest/v1/`, {
          method: "GET",
          headers: baseHeaders,
        });
        if (schemaRes.ok) {
          const spec = await schemaRes.json();
          if (spec && typeof spec === "object" && spec.paths) {
            openApiPaths = spec.paths;
            openApiDefs = spec.definitions ?? null;
          }
        }
      } catch {
        // Fallback to direct probes below
      }

      const missingRequired = [];
      const missingUpgrades = [];

      if (openApiPaths) {
        if (!("/rpc/claim_next_task" in openApiPaths)) {
          missingRequired.push("rpc/claim_next_task");
        }
        if (!("/rpc/extend_task_lease" in openApiPaths)) {
          missingRequired.push("rpc/extend_task_lease");
        }
        if (!("/rpc/get_task_stats" in openApiPaths)) {
          missingUpgrades.push("rpc/get_task_stats");
        }
        const tableProps = openApiDefs?.[table]?.properties;
        if (tableProps && !("idempotency_key" in tableProps)) {
          missingUpgrades.push("idempotency_key column");
        }
      } else {
        const extendRes = await fetchImpl(`${baseUrl}/rest/v1/rpc/extend_task_lease`, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify({
            p_task_id: "00000000-0000-0000-0000-000000000000",
            p_worker_id: "__doctor__",
            p_lease_seconds: 10,
            p_attempt: 1,
          }),
        });
        if (extendRes.status === 404) {
          missingRequired.push("rpc/extend_task_lease");
        }
        const statsRes = await fetchImpl(`${baseUrl}/rest/v1/rpc/get_task_stats`, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify({}),
        });
        if (statsRes.status === 404) {
          missingUpgrades.push("rpc/get_task_stats");
        }
        const idemRes = await fetchImpl(
          `${baseUrl}/rest/v1/${encodedTable}?select=idempotency_key&limit=1`,
          { method: "GET", headers: baseHeaders },
        );
        if (!idemRes.ok) {
          missingUpgrades.push("idempotency_key column");
        }
      }

      if (missingRequired.length > 0) {
        checks.push({
          name: "supabase",
          status: "fail",
          message: `Missing required Supabase RPC(s): ${missingRequired.join(", ")} (apply migrations/000001-init-schema.sql)`,
        });
      } else if (missingUpgrades.length > 0) {
        checks.push({
          name: "supabase",
          status: "warn",
          message: `Connected, but optional upgrade feature(s) missing: ${missingUpgrades.join(", ")} (re-apply migrations/000001-init-schema.sql)`,
        });
      } else {
        checks.push({
          name: "supabase",
          status: "ok",
          message: `Connected to ${schema}.${table}; schema and RPCs ready`,
        });
      }
    }
  } catch (error) {
    checks.push({
      name: "supabase",
      status: "fail",
      message: redactSecrets(
        `Supabase connection error: ${error instanceof Error ? error.message : String(error)}`,
        secrets,
      ),
    });
  }

  // Agent CLI executables check
  const missingAgents = [];
  const foundAgents = [];
  for (const agentName of resolvedSettings.worker.allowed_agents) {
    const execName = resolvedSettings.worker.agents[agentName]?.executable ?? agentName;
    const probe = checkExecutable(execName);
    if (probe?.ok) {
      foundAgents.push(`${agentName}(${probe.path ?? execName})`);
    } else {
      missingAgents.push(`${agentName}(${execName})`);
    }
  }
  checks.push(
    missingAgents.length === 0
      ? {
          name: "agents",
          status: "ok",
          message: `Found allowed agent binaries: ${foundAgents.join(", ")}`,
        }
      : {
          name: "agents",
          status: "fail",
          message: `Missing executable(s) for allowed_agents: ${missingAgents.join(", ")}`,
        },
  );

  if (resolvedSettings.transports.telegram) {
    checks.push({
      name: "telegram",
      status: "ok",
      message: `Telegram configured for chat_id=${resolvedSettings.telegram.chat_id}`,
    });
  }

  const ok = checks.every((check) => check.status !== "fail");
  for (const check of checks) {
    const prefix = check.status === "ok" ? "[OK]" : check.status === "warn" ? "[WARN]" : "[FAIL]";
    const line = redactSecrets(`${prefix} ${check.name}: ${check.message}`, secrets);
    (check.status === "fail" ? logger.error : logger.log)(line);
  }

  return { ok, checks };
}
