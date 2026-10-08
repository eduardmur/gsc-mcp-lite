import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a Google sign-in is remembered (OAuth clients only; keys need nothing).
 *   macOS    ~/Library/Application Support/gsc-mcp-lite
 *   Windows  %APPDATA%\gsc-mcp-lite
 *   Linux    $XDG_CONFIG_HOME/gsc-mcp-lite or ~/.config/gsc-mcp-lite
 * GSC_MCP_LITE_DIR overrides all three.
 */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.GSC_MCP_LITE_DIR) {
    return env.GSC_MCP_LITE_DIR;
  }
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "gsc-mcp-lite");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "gsc-mcp-lite");
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "gsc-mcp-lite");
}
