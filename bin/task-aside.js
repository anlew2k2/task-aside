#!/usr/bin/env node

import { parseArgs } from "node:util";
import { startApp } from "../src/index.js";
import { getPackageInfo } from "../src/utilities/package-info.js";

const { name, version } = getPackageInfo();

function printHelp() {
  console.log(`${name} v${version}

Usage:
  task-aside [options]

Options:
  -p, --port <port>   MCP HTTP port (default: $PORT or 3100)
  -H, --host <host>   Bind host (default: $HOST or 127.0.0.1)
  -h, --help          Show this help message
  -v, --version       Show version`);
}

function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: "string", short: "p", default: process.env.PORT ?? "3100" },
        host: { type: "string", short: "H", default: process.env.HOST ?? "127.0.0.1" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      strict: true,
      allowPositionals: false,
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

  if (!/^\d+$/.test(values.port)) {
    console.error(`Invalid port "${values.port}": expected an integer between 0 and 65535.`);
    process.exit(1);
  }

  const port = Number.parseInt(values.port, 10);
  if (port < 0 || port > 65535) {
    console.error(`Invalid port "${values.port}": expected an integer between 0 and 65535.`);
    process.exit(1);
  }

  return {
    host: values.host,
    port,
  };
}

const config = parseCliArgs(process.argv.slice(2));

startApp(config).catch((error) => {
  console.error(`Failed to start ${name}: ${error.message}`);
  process.exit(1);
});
