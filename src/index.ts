#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAuth } from "./auth.js";
import { createGscApi } from "./gsc.js";
import { createServer } from "./server.js";
import { NAME, VERSION } from "./version.js";

const HELP = `${NAME} v${VERSION}: Google Search Console over MCP, read-only

Usage:
  ${NAME}            Start the MCP server on stdio (default)
  ${NAME} check      Verify the credentials and print the properties they can see
  ${NAME} login      Sign in with a Desktop-app OAuth client (keys need no login)

Options:
  --credentials <path>  Google credentials JSON (or set GSC_CREDENTIALS)
  --no-open             login: print the sign-in URL instead of opening a browser
  -v, --version         Print the version
  -h, --help            Print this help

Credentials are a service-account key or a Desktop-app OAuth client JSON from
Google Cloud. The README explains both: https://github.com/eduardmur/gsc-mcp-lite`;

const log = (line: string) => void process.stderr.write(`${line}\n`);
const print = (line: string) => void process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      credentials: { type: "string" },
      "no-open": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.version) {
    print(VERSION);
    return 0;
  }
  if (values.help) {
    print(HELP);
    return 0;
  }

  const auth = createAuth({ credentialsFile: values.credentials, openBrowser: !values["no-open"] });
  const api = createGscApi(auth);
  const [command = "serve"] = positionals;

  switch (command) {
    case "serve": {
      let source: string;
      try {
        source = auth.source();
      } catch (error) {
        source = `credentials problem, tools will report it: ${message(error)}`;
      }
      const email = () => {
        const creds = auth.credentials();
        return creds?.kind === "service_account" ? creds.email : null;
      };
      const server = createServer(api, { serviceAccountEmail: email });
      await server.connect(new StdioServerTransport());
      log(`${NAME} v${VERSION} on stdio; ${source}`);
      return 0;
    }
    case "login": {
      const path = await auth.login();
      print(path ? `Signed in. Token saved to ${path}` : `No sign-in needed: ${auth.source()}`);
      return 0;
    }
    case "check": {
      print(`Credentials: ${auth.source()}`);
      const sites = await api.listSites();
      if (sites.length === 0) {
        const creds = auth.credentials();
        print("Google answered, but no properties are visible.");
        if (creds?.kind === "service_account") {
          print(
            `Add ${creds.email} as a user in Search Console: open the property, Settings → Users and permissions → Add user.`,
          );
        }
        return 1;
      }
      print(`Properties (${sites.length}):`);
      const width = Math.max(...sites.map((site) => site.siteUrl.length));
      for (const site of sites) {
        print(`  ${site.siteUrl.padEnd(width)}  ${site.permissionLevel}`);
      }
      return 0;
    }
    default:
      log(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    log(message(error));
    process.exitCode = 1;
  },
);
