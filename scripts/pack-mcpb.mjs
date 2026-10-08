// Builds gsc-mcp-lite.mcpb, the one-click bundle for Claude Desktop.
// Production dependencies are vendored into the bundle, so dev dependencies
// are removed for the pack and reinstalled afterwards.
import { execSync } from "node:child_process";

const run = (command) => execSync(command, { stdio: "inherit" });

run("npm run build");
run("npm ci --omit=dev");
try {
  run("npx -y @anthropic-ai/mcpb pack . gsc-mcp-lite.mcpb");
} finally {
  run("npm ci");
}
