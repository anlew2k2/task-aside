import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ConfigError } from "./errors.js";

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed === "") {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    const quote = trimmed[0];
    const inner = trimmed.slice(1, -1);
    if (quote === '"') {
      return inner
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\t", "\t")
        .replaceAll('\\"', '"')
        .replaceAll("\\\\", "\\");
    }
    return inner;
  }

  // Strip inline comment only when preceded by whitespace for unquoted values.
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/**
 * Load environment variables from a .env file without overriding existing entries.
 */
export function loadEnvFile({
  filePath = resolve(process.cwd(), ".env"),
  target = process.env,
} = {}) {
  if (!existsSync(filePath)) {
    return target;
  }

  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    if (target[key] === undefined) {
      target[key] = parseEnvValue(line.slice(eqIndex + 1));
    }
  }

  return target;
}

const TRUTHY_ENV_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSY_ENV_VALUES = new Set(["false", "0", "no", "off"]);

export function parseBooleanEnv(rawValue, defaultValue, varName) {
  if (rawValue === undefined || rawValue === null) {
    return defaultValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === "") {
    return defaultValue;
  }

  if (TRUTHY_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSY_ENV_VALUES.has(normalized)) {
    return false;
  }

  throw new ConfigError(`${varName} must be a boolean (true/false, 1/0)`);
}

/**
 * Read transport enable/disable flags from environment variables.
 */
export function readFeatureFlags(env = process.env) {
  return {
    enableHttp: parseBooleanEnv(env.ENABLE_HTTP, true, "ENABLE_HTTP"),
    enableMcp: parseBooleanEnv(env.ENABLE_MCP, true, "ENABLE_MCP"),
    enableWorker: parseBooleanEnv(env.ENABLE_WORKER, true, "ENABLE_WORKER"),
  };
}

/**
 * Validate and extract Cloudflare Queue settings from environment variables.
 */
export function readCloudflareQueueConfig(env = process.env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const queueId = env.CLOUDFLARE_TASKS_QUEUE_ID?.trim() ?? "";

  const missing = [];
  if (!accountId) {
    missing.push("CLOUDFLARE_ACCOUNT_ID");
  }
  if (!apiToken) {
    missing.push("CLOUDFLARE_API_TOKEN");
  }
  if (!queueId) {
    missing.push("CLOUDFLARE_TASKS_QUEUE_ID");
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required Cloudflare Queue configuration: ${missing.join(", ")}`,
    );
  }

  const dlqQueueId =
    env.CLOUDFLARE_DLQ_QUEUE_ID?.trim() || env.CLOUDFLARE_DLQ_QUEUE_ID_?.trim() || null;

  const apiBaseUrl = env.CLOUDFLARE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;

  let visibilityTimeoutMs = DEFAULT_VISIBILITY_TIMEOUT_MS;
  const rawTimeout = env.CLOUDFLARE_VISIBILITY_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    if (!/^\d+$/.test(rawTimeout)) {
      throw new ConfigError(
        "CLOUDFLARE_VISIBILITY_TIMEOUT_MS must be a positive integer",
      );
    }
    visibilityTimeoutMs = Number.parseInt(rawTimeout, 10);
    if (visibilityTimeoutMs <= 0) {
      throw new ConfigError(
        "CLOUDFLARE_VISIBILITY_TIMEOUT_MS must be a positive integer",
      );
    }
  }

  return {
    accountId,
    apiToken,
    queueId,
    dlqQueueId,
    apiBaseUrl,
    visibilityTimeoutMs,
  };
}

/**
 * Resolve the log directory from environment variables (defaults to ./logs).
 */
export function readLogConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const rawDir = env.LOG_DIR?.trim() ?? "";
  const rawPath = rawDir || "logs";

  let dir;
  if (rawPath === "~") {
    dir = homedir();
  } else if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    dir = resolve(homedir(), rawPath.slice(2));
  } else {
    dir = resolve(cwd, rawPath);
  }

  return { dir };
}

/**
 * Read HTTP/MCP server host and port from environment variables.
 */
export function readServerConfig(env = process.env) {
  const host = env.HOST?.trim() || "127.0.0.1";
  const rawPort = env.PORT !== undefined && env.PORT !== null ? String(env.PORT).trim() : "";

  if (rawPort === "") {
    return { host, port: 3100 };
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new ConfigError(
      `Invalid PORT "${rawPort}": expected an integer between 0 and 65535`,
    );
  }

  const port = Number.parseInt(rawPort, 10);
  if (port < 0 || port > 65535) {
    throw new ConfigError(
      `Invalid PORT "${rawPort}": expected an integer between 0 and 65535`,
    );
  }

  return { host, port };
}
