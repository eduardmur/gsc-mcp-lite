import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  type AuthClient,
  CodeChallengeMethod,
  GoogleAuth,
  type JWTInput,
  OAuth2Client,
} from "google-auth-library";
import { configDir } from "./paths.js";
import { NAME, PACKAGE } from "./version.js";

export const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** The JSON files Google Cloud hands out that this server accepts. */
export type Credentials =
  | { kind: "service_account"; email: string; json: JWTInput }
  | { kind: "authorized_user"; json: JWTInput }
  | { kind: "oauth_client"; clientId: string; clientSecret: string };

export function detectCredentials(raw: unknown): Credentials {
  const obj = record(raw);
  if (obj.type === "service_account") {
    if (typeof obj.client_email !== "string" || typeof obj.private_key !== "string") {
      throw new Error("The service-account key is missing client_email or private_key.");
    }
    return { kind: "service_account", email: obj.client_email, json: obj as unknown as JWTInput };
  }
  if (obj.type === "authorized_user") {
    if (typeof obj.refresh_token !== "string") {
      throw new Error("The authorized_user file has no refresh_token.");
    }
    return { kind: "authorized_user", json: obj as unknown as JWTInput };
  }
  if ("web" in obj) {
    throw new Error(
      'This OAuth client is of type "Web application". Create one of type "Desktop app" and download its JSON instead.',
    );
  }
  const installed = record(obj.installed);
  if (typeof installed.client_id === "string" && typeof installed.client_secret === "string") {
    return {
      kind: "oauth_client",
      clientId: installed.client_id,
      clientSecret: installed.client_secret,
    };
  }
  throw new Error(
    'Unrecognized credentials file. Expected a service-account key ("type": "service_account") or a Desktop-app OAuth client ("installed": {...}) downloaded from Google Cloud.',
  );
}

export function readCredentialsFile(path: string): Credentials {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Cannot read the credentials file: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`The credentials file is not valid JSON: ${path}`);
  }
  return detectCredentials(raw);
}

/** One token file per OAuth client, so two clients on one machine never collide. */
export function tokenPath(clientId: string, dir: string = configDir()): string {
  const id = createHash("sha256").update(clientId).digest("hex").slice(0, 16);
  return join(dir, `token-${id}.json`);
}

export interface AuthOptions {
  /** Path to the credentials JSON; falls back to $GSC_CREDENTIALS, then to Application Default Credentials. */
  credentialsFile?: string;
  /** login: open the browser (default) or only print the URL. */
  openBrowser?: boolean;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Test seam: where OAuth tokens are stored. */
  dir?: string;
  /** Test seam: replaces the browser sign-in. */
  loopback?: (clientId: string, clientSecret: string) => Promise<JWTInput>;
}

export interface Auth {
  /** One line saying where the credentials come from. Throws when the file is unreadable. */
  source(): string;
  credentials(): Credentials | null;
  /** An authenticated client, created once and shared; OAuth clients sign in on first use. */
  getClient(): Promise<AuthClient>;
  /** Interactive sign-in for OAuth clients. Returns the token file path, or null when no sign-in is needed. */
  login(): Promise<string | null>;
  /** Forget the cached client and, for OAuth clients, the saved sign-in. */
  reset(): void;
}

export function createAuth(options: AuthOptions = {}): Auth {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const file = options.credentialsFile ?? env.GSC_CREDENTIALS;
  const dir = options.dir ?? configDir(env);
  const openBrowser = options.openBrowser ?? true;
  const loopback =
    options.loopback ?? ((id, secret) => runLoopbackFlow(id, secret, { openBrowser, log }));

  let creds: Credentials | null | undefined;
  let clientPromise: Promise<AuthClient> | null = null;
  let loginPromise: Promise<string | null> | null = null;

  function credentials(): Credentials | null {
    if (creds === undefined) {
      creds = file ? readCredentialsFile(file) : null;
    }
    return creds;
  }

  function source(): string {
    const c = credentials();
    if (!c) {
      return "Application Default Credentials (GSC_CREDENTIALS is not set)";
    }
    if (c.kind === "service_account") {
      return `service account ${c.email} (${file})`;
    }
    if (c.kind === "authorized_user") {
      return `saved Google sign-in (${file})`;
    }
    return `OAuth client ${c.clientId} (${file})`;
  }

  function login(): Promise<string | null> {
    const c = credentials();
    if (c?.kind !== "oauth_client") {
      return Promise.resolve(null);
    }
    if (!loginPromise) {
      loginPromise = (async () => {
        const path = tokenPath(c.clientId, dir);
        const token = await loopback(c.clientId, c.clientSecret);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
        return path;
      })().finally(() => {
        loginPromise = null;
      });
    }
    return loginPromise;
  }

  async function build(): Promise<AuthClient> {
    const c = credentials();
    if (!c) {
      try {
        return await new GoogleAuth({ scopes: [SCOPE] }).getClient();
      } catch {
        throw new Error(
          "No Google credentials found. Set GSC_CREDENTIALS to the path of your key file; the README explains how to get one.",
        );
      }
    }
    if (c.kind === "oauth_client") {
      const path = tokenPath(c.clientId, dir);
      let stored = readJson(path);
      if (!stored) {
        log("No saved sign-in for this OAuth client yet; starting the Google sign-in.");
        await login();
        stored = readJson(path);
      }
      if (!stored) {
        throw new Error("Sign-in finished without a token. Try again.");
      }
      return await new GoogleAuth({ credentials: stored, scopes: [SCOPE] }).getClient();
    }
    return await new GoogleAuth({ credentials: c.json, scopes: [SCOPE] }).getClient();
  }

  function getClient(): Promise<AuthClient> {
    if (!clientPromise) {
      clientPromise = build().catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  function reset(): void {
    clientPromise = null;
    if (creds?.kind === "oauth_client") {
      try {
        rmSync(tokenPath(creds.clientId, dir));
      } catch {
        // nothing saved
      }
    }
  }

  return { source, credentials, getClient, login, reset };
}

function readJson(path: string): JWTInput | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as JWTInput;
    return parsed.refresh_token ? parsed : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Desktop-app OAuth with PKCE on an ephemeral loopback port. Google accepts
 * any http://127.0.0.1:{port} redirect for Desktop-app clients, so no port
 * needs to be registered. Resolves to an authorized_user JSON, the same
 * shape gcloud writes, which GoogleAuth reads directly.
 */
export async function runLoopbackFlow(
  clientId: string,
  clientSecret: string,
  options: { openBrowser: boolean; log: (line: string) => void; timeoutMs?: number },
): Promise<JWTInput> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [SCOPE],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: challenge,
  });

  options.log("Sign in to Google in the browser. If none opens, use this URL:");
  options.log(url);
  if (options.openBrowser) {
    openBrowser(url, options.log);
  }

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Sign-in timed out after 5 minutes. Run \`npx -y ${PACKAGE} login\`.`)),
        options.timeoutMs ?? LOGIN_TIMEOUT_MS,
      );
      server.on("request", (request, response) => {
        const query = new URL(request.url ?? "/", redirectUri).searchParams;
        const error = query.get("error");
        const returnedCode = query.get("code");
        if (error || query.get("state") !== state || !returnedCode) {
          response.writeHead(400, { "Content-Type": "text/html" });
          response.end(page("Sign-in failed. Close this tab and try again."));
          clearTimeout(timer);
          reject(
            new Error(error ? `Google returned: ${error}` : "State mismatch or missing code."),
          );
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(page("Connected. You can close this tab."));
        clearTimeout(timer);
        resolve(returnedCode);
      });
    });

    const { tokens } = await client.getToken({
      code,
      codeVerifier: verifier,
      redirect_uri: redirectUri,
    });
    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Make sure the OAuth client type is "Desktop app" and try again.',
      );
    }
    return {
      type: "authorized_user",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
    };
  } finally {
    server.close();
  }
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${NAME}</title><body style="font-family:system-ui;margin:4rem auto;max-width:28rem;text-align:center"><p>${message}</p></body>`;
}

function openBrowser(url: string, log: (line: string) => void): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    log("Could not open a browser automatically; open the URL above yourself.");
  }
}
