import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError } from "#src/utilities/errors.js";
import {
  createDefaultSettings,
  expandHomePath,
  loadSettings,
  validateSettings,
} from "#src/utilities/settings.js";

test("loadSettings creates default settings.json with 0600 mode when missing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, ".task-aside", "settings.json");
  const { settings, path, created } = loadSettings({
    configPath,
    createIfMissing: true,
    requireSupabase: false,
    home: dir,
    cwd: dir,
  });

  assert.equal(created, true);
  assert.equal(path, configPath);
  assert.equal(settings.server.port, 3100);
  assert.equal(settings.logging.dir, join(dir, ".task-aside", "logs"));
  assert.equal(settings.worker.runs_dir, join(dir, ".task-aside", "runs"));
  assert.equal(settings.worker.default_cwd, dir);
  assert.equal(settings.transports.telegram, false);
  assert.equal(settings.telegram.default_agent, "agy");
  assert.equal(settings.telegram.default_priority, "P1");
  assert.equal(settings.worker.agents.agy.default_model, "gemini-pro-orchestrator-neon");
  assert.equal(settings.worker.agents.agy.default_effort, "high");
  assert.equal(settings.worker.agents.claude.default_model, "sonnet");
  assert.equal(settings.worker.agents.claude.default_effort, "high");
  assert.equal(settings.worker.agents.codex.default_model, "sol");
  assert.equal(settings.worker.agents.codex.default_effort, "high");

  const mode = statSync(configPath).mode & 0o777;
  assert.equal(mode, 0o600);

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written, createDefaultSettings());
});

test("loadSettings merges partial JSON, expands ~ paths, and validates fields", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-settings-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, "settings.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      server: { port: 4100 },
      supabase: {
        url: "https://example.supabase.co/",
        publishable_key: "sb_publishable_secret_value",
      },
      worker: {
        allowed_agents: ["codex", "claude"],
        allowed_cwd_roots: ["~/projects"],
      },
    }),
    "utf8",
  );

  const { settings, created } = loadSettings({
    configPath,
    home: "/Users/tester",
    cwd: "/work/repo",
  });

  assert.equal(created, false);
  assert.equal(settings.server.host, "127.0.0.1");
  assert.equal(settings.server.port, 4100);
  assert.equal(settings.supabase.url, "https://example.supabase.co");
  assert.deepEqual(settings.worker.allowed_agents, ["codex", "claude"]);
  assert.deepEqual(settings.worker.allowed_cwd_roots, ["/Users/tester/projects"]);
  assert.equal(settings.worker.default_cwd, "/work/repo");
  assert.equal(expandHomePath("~", { home: "/Users/tester" }), "/Users/tester");
});

test("validateSettings rejects invalid config without leaking publishable_key", () => {
  assert.throws(
    () =>
      validateSettings({
        supabase: {
          url: "ftp://bad.example.com",
          publishable_key: "secret-key-do-not-leak",
        },
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message.includes("secret-key-do-not-leak"), false);
      return true;
    },
  );

  assert.throws(
    () =>
      validateSettings(
        {
          worker: {
            default_permission_mode: "full",
            max_permission_mode: "workspace",
          },
        },
        { requireSupabase: false },
      ),
    (err) => err instanceof ConfigError && /default_permission_mode/.test(err.message),
  );

  assert.throws(
    () =>
      validateSettings(
        {
          worker: {
            allowed_agents: [],
          },
        },
        { requireSupabase: false },
      ),
    (err) => err instanceof ConfigError && /allowed_agents/.test(err.message),
  );

  assert.throws(
    () =>
      validateSettings(
        {
          worker: {
            lease_seconds: 15,
            heartbeat_interval_ms: 15000,
          },
        },
        { requireSupabase: false },
      ),
    (err) => err instanceof ConfigError && /heartbeat_interval_ms/.test(err.message),
  );
});

test("loadSettings throws ConfigError on invalid JSON", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "task-aside-bad-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "settings.json");
  writeFileSync(configPath, "{not-valid-json", "utf8");

  assert.throws(
    () => loadSettings({ configPath }),
    (err) => err instanceof ConfigError && /Invalid JSON/.test(err.message),
  );
});

test("validateSettings validates telegram config, expands workspaces, and never leaks bot_token", () => {
  assert.throws(
    () =>
      validateSettings(
        {
          transports: { telegram: true },
          telegram: {
            bot_token: "",
            user_id: 1001,
            chat_id: 1001,
          },
        },
        { requireSupabase: false },
      ),
    (err) => err instanceof ConfigError && /bot_token/.test(err.message),
  );

  assert.throws(
    () =>
      validateSettings(
        {
          transports: { telegram: true },
          telegram: {
            bot_token: "secret-telegram-token-xyz",
            user_id: null,
            chat_id: null,
          },
        },
        { requireSupabase: false },
      ),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /user_id/);
      assert.equal(err.message.includes("secret-telegram-token-xyz"), false);
      return true;
    },
  );

  assert.throws(
    () =>
      validateSettings(
        {
          telegram: {
            default_workspace: "missing-alias",
            workspaces: { repo: "~/code/repo" },
          },
        },
        { requireSupabase: false, home: "/Users/tester" },
      ),
    (err) => err instanceof ConfigError && /default_workspace/.test(err.message),
  );

  const normalized = validateSettings(
    {
      transports: { telegram: true },
      telegram: {
        bot_token: "secret-telegram-token-xyz",
        user_id: 12345,
        chat_id: "12345",
        default_agent: "claude",
        default_priority: "P0",
        default_workspace: "main",
        workspaces: { main: "~/projects/main" },
        api_base_url: "https://api.telegram.org/",
      },
    },
    { requireSupabase: false, home: "/Users/tester" },
  );

  assert.equal(normalized.telegram.user_id, "12345");
  assert.equal(normalized.telegram.chat_id, "12345");
  assert.equal(normalized.telegram.default_agent, "claude");
  assert.equal(normalized.telegram.default_priority, "P0");
  assert.equal(normalized.telegram.default_workspace, "main");
  assert.equal(normalized.telegram.workspaces.main, "/Users/tester/projects/main");
  assert.equal(normalized.telegram.api_base_url, "https://api.telegram.org");
});
