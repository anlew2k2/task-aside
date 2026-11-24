import { readFileSync } from "node:fs";

let cachedInfo = null;

/**
 * Read package metadata once without JSON import attributes for Node 18+ and Bun compatibility.
 */
export function getPackageInfo() {
  if (!cachedInfo) {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw);
    cachedInfo = {
      name: pkg.name,
      version: pkg.version,
    };
  }
  return cachedInfo;
}
