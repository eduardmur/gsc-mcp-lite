import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const NAME = "gsc-mcp-lite";
export const PACKAGE = "@eduardmur/gsc-mcp-lite";
export const VERSION: string = pkg.version;
