import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAuth, detectCredentials, tokenPath } from "../src/auth.js";
import { configDir } from "../src/paths.js";

const SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "p",
  client_email: "bot@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
};
const OAUTH_CLIENT = {
  installed: { client_id: "id.apps.googleusercontent.com", client_secret: "s" },
};
const AUTHORIZED_USER = {
  type: "authorized_user",
  client_id: "id",
  client_secret: "s",
  refresh_token: "r",
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "gsc-lite-"));
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("detectCredentials", () => {
  it("recognizes the three Google Cloud shapes", () => {
    expect(detectCredentials(SERVICE_ACCOUNT)).toMatchObject({
      kind: "service_account",
      email: "bot@p.iam.gserviceaccount.com",
    });
    expect(detectCredentials(AUTHORIZED_USER)).toMatchObject({ kind: "authorized_user" });
    expect(detectCredentials(OAUTH_CLIENT)).toEqual({
      kind: "oauth_client",
      clientId: "id.apps.googleusercontent.com",
      clientSecret: "s",
    });
  });

  it("explains a Web-application client and rejects anything else", () => {
    expect(() => detectCredentials({ web: { client_id: "x", client_secret: "y" } })).toThrow(
      /Desktop app/,
    );
    expect(() => detectCredentials({ type: "service_account" })).toThrow(/client_email/);
    expect(() => detectCredentials({ hello: 1 })).toThrow(/Unrecognized/);
    expect(() => detectCredentials(null)).toThrow(/Unrecognized/);
    expect(() => detectCredentials([1, 2])).toThrow(/Unrecognized/);
  });
});

describe("configDir", () => {
  it("follows each platform's convention and the override", () => {
    const home = "/home/u";
    expect(configDir({}, "darwin", home)).toBe(
      join(home, "Library", "Application Support", "gsc-mcp-lite"),
    );
    expect(configDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", home)).toMatch(
      /AppData[\\/]Roaming[\\/]gsc-mcp-lite$/,
    );
    expect(configDir({}, "linux", home)).toBe(join(home, ".config", "gsc-mcp-lite"));
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", home)).toBe(join("/x", "gsc-mcp-lite"));
    expect(configDir({ GSC_MCP_LITE_DIR: "/o" }, "darwin", home)).toBe("/o");
  });

  it("names token files by a hash of the client id", () => {
    const path = tokenPath("a", "/d");
    expect(dirname(path)).toBe(join("/d"));
    expect(basename(path)).toMatch(/^token-[0-9a-f]{16}\.json$/);
    expect(tokenPath("a", "/d")).not.toBe(tokenPath("b", "/d"));
  });
});

describe("createAuth", () => {
  it("falls back to ADC when nothing is configured", () => {
    const auth = createAuth({ env: {}, dir: tmp() });
    expect(auth.credentials()).toBeNull();
    expect(auth.source()).toMatch(/Application Default Credentials/);
  });

  it("reports an unreadable or malformed file at first use", () => {
    const dir = tmp();
    expect(() =>
      createAuth({ env: {}, credentialsFile: join(dir, "missing.json") }).source(),
    ).toThrow(/Cannot read/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(() => createAuth({ env: {}, credentialsFile: bad }).source()).toThrow(/not valid JSON/);
  });

  it("builds a JWT client from a service-account key without network", async () => {
    const dir = tmp();
    const file = writeJson(dir, "sa.json", SERVICE_ACCOUNT);
    const auth = createAuth({ env: { GSC_CREDENTIALS: file }, dir });
    expect(auth.source()).toContain("bot@p.iam.gserviceaccount.com");
    const client = await auth.getClient();
    expect(client.constructor.name).toBe("JWT");
    expect(await auth.getClient()).toBe(client);
    expect(await auth.login()).toBeNull();
  });

  it("signs in once for an OAuth client, stores the token, and reuses it", async () => {
    const dir = tmp();
    const file = writeJson(dir, "client.json", OAUTH_CLIENT);
    const loopback = vi.fn(async (clientId: string, clientSecret: string) => ({
      type: "authorized_user",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: "fresh",
    }));
    const log = vi.fn();
    const auth = createAuth({ credentialsFile: file, env: {}, dir, loopback, log });

    const [a, b] = await Promise.all([auth.getClient(), auth.getClient()]);
    expect(loopback).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.constructor.name).toBe("UserRefreshClient");
    const path = tokenPath("id.apps.googleusercontent.com", dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ refresh_token: "fresh" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("starting the Google sign-in"));

    const again = createAuth({ credentialsFile: file, env: {}, dir, loopback, log });
    await again.getClient();
    expect(loopback).toHaveBeenCalledTimes(1);

    again.reset();
    expect(existsSync(path)).toBe(false);
    await again.getClient();
    expect(loopback).toHaveBeenCalledTimes(2);
  });

  it("login returns the token path and surfaces sign-in failures", async () => {
    const dir = tmp();
    const file = writeJson(dir, "client.json", OAUTH_CLIENT);
    const failing = createAuth({
      credentialsFile: file,
      env: {},
      dir,
      log: () => {},
      loopback: async () => {
        throw new Error("access_denied");
      },
    });
    await expect(failing.getClient()).rejects.toThrow(/access_denied/);
    const ok = createAuth({
      credentialsFile: file,
      env: {},
      dir,
      log: () => {},
      loopback: async () => AUTHORIZED_USER,
    });
    expect(await ok.login()).toBe(tokenPath("id.apps.googleusercontent.com", dir));
  });

  it("reads a saved authorized_user file directly", async () => {
    const dir = tmp();
    const file = writeJson(dir, "adc.json", AUTHORIZED_USER);
    const auth = createAuth({ credentialsFile: file, env: {}, dir });
    expect(auth.source()).toMatch(/saved Google sign-in/);
    expect((await auth.getClient()).constructor.name).toBe("UserRefreshClient");
  });
});
