import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { redactSecrets } from "#src/utilities/redaction.js";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pad3(value) {
  return String(value).padStart(3, "0");
}

/**
 * Format a Date as local YYYY-MM-DD for daily log file rotation.
 */
export function formatLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Format a Date as an ISO-like local timestamp with timezone offset.
 */
export function formatLocalTimestamp(date = new Date()) {
  const datePart = formatLocalDate(date);
  const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds(),
  )}.${pad3(date.getMilliseconds())}`;

  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) {
    return `${datePart}T${timePart}Z`;
  }

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = pad2(Math.floor(absMinutes / 60));
  const offsetMins = pad2(absMinutes % 60);
  return `${datePart}T${timePart}${sign}${offsetHours}:${offsetMins}`;
}

/**
 * Daily-rotating file logger that also mirrors output to a console sink.
 */
export function createFileLogger({
  dir,
  prefix = "task-aside",
  consoleSink = console,
  now = () => new Date(),
  secrets = [],
} = {}) {
  if (typeof dir !== "string" || dir.trim() === "") {
    throw new Error("Log directory path must be a non-empty string");
  }

  mkdirSync(dir, { recursive: true });
  let lastDateKey = null;

  function getLogFilePath(date = now()) {
    return join(dir, `${prefix}-${formatLocalDate(date)}.log`);
  }

  function formatAndRedact(args) {
    return redactSecrets(format(...args), secrets);
  }

  function writeLine(level, message) {
    const date = now();
    const dateKey = formatLocalDate(date);
    const filePath = join(dir, `${prefix}-${dateKey}.log`);
    const line = `[${formatLocalTimestamp(date)}] [${level}] ${message}\n`;

    try {
      if (dateKey !== lastDateKey) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(filePath, line, "utf8");
      lastDateKey = dateKey;
    } catch (error) {
      if (error?.code === "ENOENT") {
        try {
          mkdirSync(dir, { recursive: true });
          appendFileSync(filePath, line, "utf8");
          lastDateKey = dateKey;
          return;
        } catch (retryError) {
          consoleSink?.error?.(
            "[logger] Failed to write log file:",
            retryError instanceof Error ? retryError.message : String(retryError),
          );
          return;
        }
      }
      consoleSink?.error?.(
        "[logger] Failed to write log file:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    dir,
    getCurrentLogFile() {
      return getLogFilePath(now());
    },
    log(...args) {
      const message = formatAndRedact(args);
      writeLine("INFO", message);
      consoleSink?.log?.(message);
    },
    info(...args) {
      const message = formatAndRedact(args);
      writeLine("INFO", message);
      consoleSink?.log?.(message);
    },
    warn(...args) {
      const message = formatAndRedact(args);
      writeLine("WARN", message);
      (consoleSink?.warn ?? consoleSink?.log)?.(message);
    },
    error(...args) {
      const message = formatAndRedact(args);
      writeLine("ERROR", message);
      consoleSink?.error?.(message);
    },
    async close() {},
  };
}
