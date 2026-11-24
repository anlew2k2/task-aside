import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigError } from "#src/utilities/errors.js";
import {
  isPlainObject,
  PERMISSION_MODE_RANK,
  PERMISSION_MODES,
  SUPPORTED_AGENTS,
  TASK_PRIORITIES,
} from "#src/utilities/validation.js";

export const DEFAULT_HOME_DIR = join(homedir(), ".task-aside");
export const DEFAULT_SETTINGS_PATH = join(DEFAULT_HOME_DIR, "settings.json");

export function createDefaultSettings() {
  return {
    server: {
      host: "127.0.0.1",
      port: 3100,
    },
    transports: {
      http: true,
      mcp: true,
      worker: true,
      telegram: false,
    },
    supabase: {
      url: "",
      publishable_key: "",
      schema: "public",
      table: "tasks",
    },
    telegram: {
      bot_token: "",
      user_id: null,
      chat_id: null,
      default_agent: null,
      default_priority: "P1",
      default_workspace: null,
      workspaces: {},
      poll_timeout_seconds: 25,
      api_base_url: "https://api.telegram.org",
    },
    logging: {
      dir: "~/.task-aside/logs",
    },
    worker: {
      worker_id: null,
      poll_interval_ms: 1000,
      lease_seconds: 120,
      heartbeat_interval_ms: 30000,
      runs_dir: "~/.task-aside/runs",
      allowed_agents: ["agy", "claude", "codex"],
      default_permission_mode: "workspace",
      max_permission_mode: "workspace",
      default_cwd: "",
      allowed_cwd_roots: [],
      default_timeout_ms: 600000,
      agents: {
        agy: {
          executable: "agy",
          default_model: null,
          default_effort: null,
        },
        claude: {
          executable: "claude",
          default_model: null,
          default_effort: null,
        },
        codex: {
          executable: "codex",
          default_model: null,
          default_effort: null,
          skip_git_repo_check: false,
        },
      },
    },
  };
}

export function expandHomePath(inputPath, { cwd = process.cwd(), home = homedir() } = {}) {
  const trimmed = String(inputPath).trim();
  if (trimmed === "~") {
    return home;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(home, trimmed.slice(2));
  }
  return resolve(cwd, trimmed);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) {
    return structuredClone(base);
  }

  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function assertNonEmptyConfigString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function assertNullableConfigString(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${fieldName} must be a non-empty string or null`);
  }
  return value.trim();
}

function assertConfigBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${fieldName} must be a boolean`);
  }
  return value;
}

function assertPositiveConfigInt(value, fieldName, { min = 1 } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new ConfigError(`${fieldName} must be an integer >= ${min}`);
  }
  return value;
}

function assertNullableTelegramId(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ConfigError(`${fieldName} must be an integer, numeric string, or null`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    if (/^-?\d+$/.test(trimmed)) {
      return trimmed;
    }
  }
  throw new ConfigError(`${fieldName} must be an integer, numeric string, or null`);
}

/**
 * Validate and normalize settings loaded from ~/.task-aside/settings.json or passed in memory.
 */
export function validateSettings(
  rawSettings,
  {
    requireSupabase = true,
    requireTelegram = undefined,
    cwd = process.cwd(),
    home = homedir(),
  } = {},
) {
  if (!isPlainObject(rawSettings)) {
    throw new ConfigError("Settings root must be a JSON object");
  }

  const merged = deepMerge(createDefaultSettings(), rawSettings);

  // Server
  if (!isPlainObject(merged.server)) {
    throw new ConfigError("server must be an object");
  }
  const host = assertNonEmptyConfigString(merged.server.host, "server.host");
  const port = merged.server.port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError("server.port must be an integer between 0 and 65535");
  }

  // Transports
  if (!isPlainObject(merged.transports)) {
    throw new ConfigError("transports must be an object");
  }
  const transports = {
    http: assertConfigBoolean(merged.transports.http, "transports.http"),
    mcp: assertConfigBoolean(merged.transports.mcp, "transports.mcp"),
    worker: assertConfigBoolean(merged.transports.worker, "transports.worker"),
    telegram: assertConfigBoolean(merged.transports.telegram, "transports.telegram"),
  };

  // Supabase
  if (!isPlainObject(merged.supabase)) {
    throw new ConfigError("supabase must be an object");
  }
  const rawUrl = typeof merged.supabase.url === "string" ? merged.supabase.url.trim() : "";
  const rawKey =
    typeof merged.supabase.publishable_key === "string"
      ? merged.supabase.publishable_key.trim()
      : "";

  if (requireSupabase) {
    if (!rawUrl) {
      throw new ConfigError("supabase.url is required in settings.json");
    }
    if (!rawKey) {
      throw new ConfigError("supabase.publishable_key is required in settings.json");
    }
  }

  let normalizedUrl = "";
  if (rawUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new ConfigError("supabase.url must be a valid http(s) URL");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new ConfigError("supabase.url must use http or https protocol");
    }
    normalizedUrl = rawUrl.replace(/\/+$/, "");
  }

  const schema = assertNonEmptyConfigString(merged.supabase.schema, "supabase.schema");
  const table = assertNonEmptyConfigString(merged.supabase.table, "supabase.table");

  // Logging
  if (!isPlainObject(merged.logging)) {
    throw new ConfigError("logging must be an object");
  }
  const rawLogDir = assertNonEmptyConfigString(merged.logging.dir, "logging.dir");
  const logDir = expandHomePath(rawLogDir, { cwd, home });

  // Worker
  if (!isPlainObject(merged.worker)) {
    throw new ConfigError("worker must be an object");
  }
  const w = merged.worker;
  const workerId =
    w.worker_id === null || w.worker_id === undefined || String(w.worker_id).trim() === ""
      ? `${hostname()}-${process.pid}`
      : assertNonEmptyConfigString(w.worker_id, "worker.worker_id");

  const pollIntervalMs = assertPositiveConfigInt(w.poll_interval_ms, "worker.poll_interval_ms");
  const leaseSeconds = assertPositiveConfigInt(w.lease_seconds, "worker.lease_seconds", {
    min: 10,
  });
  const heartbeatIntervalMs = assertPositiveConfigInt(
    w.heartbeat_interval_ms,
    "worker.heartbeat_interval_ms",
  );
  if (heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new ConfigError(
      "worker.heartbeat_interval_ms must be strictly less than worker.lease_seconds * 1000",
    );
  }

  const rawRunsDir = assertNonEmptyConfigString(w.runs_dir, "worker.runs_dir");
  const runsDir = expandHomePath(rawRunsDir, { cwd, home });

  if (!Array.isArray(w.allowed_agents) || w.allowed_agents.length === 0) {
    throw new ConfigError(
      `worker.allowed_agents must be a non-empty array of: ${SUPPORTED_AGENTS.join(", ")}`,
    );
  }
  const allowedAgents = [];
  for (const item of w.allowed_agents) {
    if (typeof item !== "string" || !SUPPORTED_AGENTS.includes(item)) {
      throw new ConfigError(
        `worker.allowed_agents contains unsupported agent "${String(item)}"; allowed: ${SUPPORTED_AGENTS.join(", ")}`,
      );
    }
    if (!allowedAgents.includes(item)) {
      allowedAgents.push(item);
    }
  }

  if (
    typeof w.default_permission_mode !== "string" ||
    !PERMISSION_MODES.includes(w.default_permission_mode)
  ) {
    throw new ConfigError(
      `worker.default_permission_mode must be one of: ${PERMISSION_MODES.join(", ")}`,
    );
  }
  if (
    typeof w.max_permission_mode !== "string" ||
    !PERMISSION_MODES.includes(w.max_permission_mode)
  ) {
    throw new ConfigError(
      `worker.max_permission_mode must be one of: ${PERMISSION_MODES.join(", ")}`,
    );
  }
  if (
    PERMISSION_MODE_RANK[w.default_permission_mode] >
    PERMISSION_MODE_RANK[w.max_permission_mode]
  ) {
    throw new ConfigError(
      "worker.default_permission_mode cannot exceed worker.max_permission_mode",
    );
  }

  if (typeof w.default_cwd !== "string") {
    throw new ConfigError("worker.default_cwd must be a string");
  }
  const defaultCwd =
    w.default_cwd.trim() === "" ? cwd : expandHomePath(w.default_cwd, { cwd, home });

  if (!Array.isArray(w.allowed_cwd_roots)) {
    throw new ConfigError("worker.allowed_cwd_roots must be an array of paths");
  }
  const allowedCwdRoots = w.allowed_cwd_roots.map((root, idx) =>
    expandHomePath(
      assertNonEmptyConfigString(root, `worker.allowed_cwd_roots[${idx}]`),
      { cwd, home },
    ),
  );

  const defaultTimeoutMs = assertPositiveConfigInt(
    w.default_timeout_ms,
    "worker.default_timeout_ms",
  );

  if (!isPlainObject(w.agents)) {
    throw new ConfigError("worker.agents must be an object");
  }
  const agents = {};
  for (const agentName of SUPPORTED_AGENTS) {
    const cfg = w.agents[agentName];
    if (!isPlainObject(cfg)) {
      throw new ConfigError(`worker.agents.${agentName} must be an object`);
    }
    agents[agentName] = {
      executable: assertNonEmptyConfigString(
        cfg.executable,
        `worker.agents.${agentName}.executable`,
      ),
      default_model: assertNullableConfigString(
        cfg.default_model,
        `worker.agents.${agentName}.default_model`,
      ),
      default_effort: assertNullableConfigString(
        cfg.default_effort,
        `worker.agents.${agentName}.default_effort`,
      ),
    };
    if (agentName === "codex") {
      agents[agentName].skip_git_repo_check = assertConfigBoolean(
        cfg.skip_git_repo_check,
        "worker.agents.codex.skip_git_repo_check",
      );
    }
  }

  // Telegram
  if (!isPlainObject(merged.telegram)) {
    throw new ConfigError("telegram must be an object");
  }
  const tg = merged.telegram;
  const telegramEnabled = requireTelegram ?? transports.telegram;

  if (typeof tg.bot_token !== "string") {
    throw new ConfigError("telegram.bot_token must be a string");
  }
  const botToken = tg.bot_token.trim();
  if (telegramEnabled && !botToken) {
    throw new ConfigError("telegram.bot_token is required when transports.telegram is enabled");
  }

  const tgUserId = assertNullableTelegramId(tg.user_id, "telegram.user_id");
  const tgChatId = assertNullableTelegramId(tg.chat_id, "telegram.chat_id");
  if (telegramEnabled && (!tgUserId || !tgChatId)) {
    throw new ConfigError(
      "telegram.user_id and telegram.chat_id are required when transports.telegram is enabled (run `task-aside auth telegram`)",
    );
  }

  const rawTgDefaultAgent = assertNullableConfigString(
    tg.default_agent,
    "telegram.default_agent",
  );
  if (rawTgDefaultAgent !== null && !SUPPORTED_AGENTS.includes(rawTgDefaultAgent)) {
    throw new ConfigError(
      `telegram.default_agent must be one of: ${SUPPORTED_AGENTS.join(", ")} or null`,
    );
  }
  const tgDefaultAgent = rawTgDefaultAgent ?? allowedAgents[0];

  if (
    typeof tg.default_priority !== "string" ||
    !TASK_PRIORITIES.includes(tg.default_priority)
  ) {
    throw new ConfigError(
      `telegram.default_priority must be one of: ${TASK_PRIORITIES.join(", ")}`,
    );
  }

  if (!isPlainObject(tg.workspaces)) {
    throw new ConfigError("telegram.workspaces must be an object");
  }
  const workspaces = {};
  for (const [aliasKey, rawWorkspacePath] of Object.entries(tg.workspaces)) {
    const alias = assertNonEmptyConfigString(aliasKey, "telegram.workspaces key");
    if (alias in workspaces) {
      throw new ConfigError(`Duplicate telegram.workspaces alias "${alias}"`);
    }
    const workspacePath = assertNonEmptyConfigString(
      rawWorkspacePath,
      `telegram.workspaces.${alias}`,
    );
    workspaces[alias] = expandHomePath(workspacePath, { cwd, home });
  }

  const tgDefaultWorkspace = assertNullableConfigString(
    tg.default_workspace,
    "telegram.default_workspace",
  );
  if (tgDefaultWorkspace !== null && !(tgDefaultWorkspace in workspaces)) {
    throw new ConfigError(
      `telegram.default_workspace "${tgDefaultWorkspace}" must match a key in telegram.workspaces`,
    );
  }

  const pollTimeoutSeconds = assertPositiveConfigInt(
    tg.poll_timeout_seconds,
    "telegram.poll_timeout_seconds",
  );
  if (pollTimeoutSeconds > 50) {
    throw new ConfigError("telegram.poll_timeout_seconds must be an integer between 1 and 50");
  }

  const rawTgApiUrl = assertNonEmptyConfigString(tg.api_base_url, "telegram.api_base_url");
  let parsedTgApiUrl;
  try {
    parsedTgApiUrl = new URL(rawTgApiUrl);
  } catch {
    throw new ConfigError("telegram.api_base_url must be a valid http(s) URL");
  }
  if (parsedTgApiUrl.protocol !== "http:" && parsedTgApiUrl.protocol !== "https:") {
    throw new ConfigError("telegram.api_base_url must use http or https protocol");
  }
  const apiBaseUrl = rawTgApiUrl.replace(/\/+$/, "");

  return {
    server: { host, port },
    transports,
    supabase: {
      url: normalizedUrl,
      publishable_key: rawKey,
      schema,
      table,
    },
    telegram: {
      bot_token: botToken,
      user_id: tgUserId,
      chat_id: tgChatId,
      default_agent: tgDefaultAgent,
      default_priority: tg.default_priority,
      default_workspace: tgDefaultWorkspace,
      workspaces,
      poll_timeout_seconds: pollTimeoutSeconds,
      api_base_url: apiBaseUrl,
    },
    logging: { dir: logDir },
    worker: {
      worker_id: workerId,
      poll_interval_ms: pollIntervalMs,
      lease_seconds: leaseSeconds,
      heartbeat_interval_ms: heartbeatIntervalMs,
      runs_dir: runsDir,
      allowed_agents: allowedAgents,
      default_permission_mode: w.default_permission_mode,
      max_permission_mode: w.max_permission_mode,
      default_cwd: defaultCwd,
      allowed_cwd_roots: allowedCwdRoots,
      default_timeout_ms: defaultTimeoutMs,
      agents,
    },
  };
}

/**
 * Load global settings from ~/.task-aside/settings.json (or custom path),
 * creating default settings if missing.
 */
export function loadSettings({
  configPath = DEFAULT_SETTINGS_PATH,
  createIfMissing = true,
  requireSupabase = true,
  requireTelegram = undefined,
  cwd = process.cwd(),
  home = homedir(),
} = {}) {
  const resolvedPath = expandHomePath(configPath, { cwd, home });
  let created = false;

  if (!existsSync(resolvedPath)) {
    if (!createIfMissing) {
      throw new ConfigError(`Settings file not found: ${resolvedPath}`);
    }
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    writeFileSync(resolvedPath, `${JSON.stringify(createDefaultSettings(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(resolvedPath, 0o600);
    } catch {
      // Ignore chmod errors on filesystems without POSIX permissions
    }
    created = true;
  }

  let rawContent;
  try {
    rawContent = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Failed to read settings file "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new ConfigError(
      `Invalid JSON in settings file "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const settings = validateSettings(parsed, {
    requireSupabase,
    requireTelegram,
    cwd,
    home,
  });
  return {
    settings,
    path: resolvedPath,
    created,
  };
}

/**
 * Persist settings JSON atomically with 0o600 permissions.
 */
export function saveSettings(
  configPath = DEFAULT_SETTINGS_PATH,
  rawSettings,
  { cwd = process.cwd(), home = homedir() } = {},
) {
  const resolvedPath = expandHomePath(configPath, { cwd, home });
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  writeFileSync(resolvedPath, `${JSON.stringify(rawSettings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(resolvedPath, 0o600);
  } catch {
    // Ignore chmod errors on filesystems without POSIX permissions
  }
  return resolvedPath;
}
