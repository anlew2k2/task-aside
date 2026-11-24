#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { authTelegram, startApp } from "#src/index.js";
import { getPackageInfo } from "#src/utilities/package-info.js";
import { DEFAULT_SETTINGS_PATH } from "#src/utilities/settings.js";

const { name, version } = getPackageInfo();

function printHelp() {
  console.log(`${name} v${version}

Usage:
  task-aside [options]
  task-aside auth telegram [-c <path>]

Options:
  -c, --config <path>   Path to settings.json (default: ${DEFAULT_SETTINGS_PATH})
  -p, --port <port>     HTTP/MCP port (overrides settings.json server.port)
  -H, --host <host>     Bind host (overrides settings.json server.host)
  -h, --help            Show this help message
  -v, --version         Show version`);
}

function parseCliArgs(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        config: { type: "string", short: "c" },
        port: { type: "string", short: "p" },
        host: { type: "string", short: "H" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    console.error(`Invalid arguments: ${error.message}`);
    process.exit(1);
  }

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log(version);
    process.exit(0);
  }

  let port;
  if (values.port !== undefined) {
    const rawPort = values.port.trim();
    if (!/^\d+$/.test(rawPort)) {
      console.error(`Invalid port "${values.port}": expected an integer between 0 and 65535.`);
      process.exit(1);
    }

    port = Number.parseInt(rawPort, 10);
    if (port < 0 || port > 65535) {
      console.error(`Invalid port "${values.port}": expected an integer between 0 and 65535.`);
      process.exit(1);
    }
  }

  const trimmedHost = values.host?.trim();
  const host = trimmedHost ? trimmedHost : undefined;
  const trimmedConfig = values.config?.trim();
  const configPath = trimmedConfig ? trimmedConfig : undefined;

  return {
    positionals,
    configPath,
    host,
    port,
  };
}

async function promptAllowedWorkspacesInteractive({ settingsPath }) {
  console.log(`\nNo allowed workspaces configured in ${settingsPath}.`);
  console.log(
    'Enter at least one workspace folder (tip: enter "~" for simplicity, or comma-separated paths).',
  );
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      let answer;
      try {
        answer = await rl.question("Allowed workspace folder(s) [tip: ~]: ");
      } catch (error) {
        if (error?.name === "AbortError" || error?.code === "ERR_USE_AFTER_CLOSE") {
          return [];
        }
        throw error;
      }
      const entries = answer
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (entries.length > 0) {
        return entries;
      }
      console.log("Please enter at least one folder path (e.g. ~ or ~/workspace).");
    }
  } finally {
    rl.close();
  }
}

const { positionals, ...config } = parseCliArgs(process.argv.slice(2));

if (positionals.length === 0) {
  const promptAllowedWorkspaces =
    process.stdin.isTTY && process.stdout.isTTY ? promptAllowedWorkspacesInteractive : undefined;
  startApp({ ...config, promptAllowedWorkspaces }).catch((error) => {
    console.error(`Failed to start ${name}: ${error.message}`);
    process.exit(1);
  });
} else if (positionals.length === 2 && positionals[0] === "auth" && positionals[1] === "telegram") {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  authTelegram({ configPath: config.configPath, signal: controller.signal })
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      if (error?.name === "AbortError") {
        console.error("Telegram authentication cancelled.");
      } else {
        console.error(`Telegram authentication failed: ${error.message}`);
      }
      process.exit(1);
    });
} else {
  console.error(`Unknown command: ${positionals.join(" ")}`);
  printHelp();
  process.exit(1);
}
