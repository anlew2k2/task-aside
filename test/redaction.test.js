import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileLogger } from "#src/utilities/logger.js";
import { collectConfiguredSecrets, redactSecrets } from "#src/utilities/redaction.js";

test("redactSecrets scrubs configured secrets and common token patterns", () => {
  const input = [
    "Authorization: Bearer super_secret_header_value_1234",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "https://api.telegram.org/bot123456:ABCdefGHIjklMNOpqrSTUvwxYZ123456/getMe",
    "openai=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "github=ghp_1234567890abcdefghij1234567890",
    "supabase=sb_publishable_1234567890abcdef",
    "custom=my-custom-secret-token-999",
  ].join(" | ");

  const output = redactSecrets(input, ["my-custom-secret-token-999"]);
  assert.equal(output.includes("super_secret_header_value_1234"), false);
  assert.equal(output.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);
  assert.equal(output.includes("123456:ABCdefGHIjklMNOpqrSTUvwxYZ123456"), false);
  assert.equal(output.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(output.includes("ghp_1234567890abcdefghij1234567890"), false);
  assert.equal(output.includes("sb_publishable_1234567890abcdef"), false);
  assert.equal(output.includes("my-custom-secret-token-999"), false);
  assert.ok(output.includes("Authorization: Bearer [REDACTED]"));
  assert.ok(output.includes("/bot[REDACTED]/getMe"));
});

test("collectConfiguredSecrets extracts non-empty credentials and createFileLogger redacts logs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-logger-redact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const secrets = collectConfiguredSecrets({
    supabase: { publishable_key: "sb_publishable_live_key_12345" },
    telegram: { bot_token: "999888:SecretTelegramBotTokenXYZ123" },
  });
  assert.equal(secrets.length, 2);

  const consoleLines = [];
  const logger = createFileLogger({
    dir,
    secrets,
    consoleSink: {
      log(msg) {
        consoleLines.push(msg);
      },
      error(msg) {
        consoleLines.push(msg);
      },
    },
  });

  logger.log("Using key sb_publishable_live_key_12345 and sk-ant-api03-abcdefghijklmnopqr");
  logger.error("Telegram failed on https://api.telegram.org/bot999888:SecretTelegramBotTokenXYZ123/sendMessage");

  const logContent = readFileSync(logger.getCurrentLogFile(), "utf8");
  assert.equal(logContent.includes("sb_publishable_live_key_12345"), false);
  assert.equal(logContent.includes("sk-ant-api03-abcdefghijklmnopqr"), false);
  assert.equal(logContent.includes("SecretTelegramBotTokenXYZ123"), false);
  assert.ok(logContent.includes("[REDACTED]"));
  assert.equal(consoleLines.join("\n").includes("sb_publishable_live_key_12345"), false);
});
