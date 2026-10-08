import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("built binary", () => {
  it("prints the version and help", () => {
    const version = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
    expect(help.stdout).toContain("GSC_CREDENTIALS");
  });

  it("serves the four tools over stdio and reports credential problems per call", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...process.env, GSC_CREDENTIALS: "/nonexistent/key.json" },
      stderr: "pipe",
    });
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(4);
      const result = await client.callTool({ name: "list-properties", arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]?.text).toContain(
        "Cannot read the credentials file",
      );
    } finally {
      await client.close();
    }
  });

  it("check exits 1 with a clear message when the file is missing", () => {
    const result = spawnSync(
      process.execPath,
      [BIN, "check", "--credentials", "/nonexistent/key.json"],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot read the credentials file");
  });
});
