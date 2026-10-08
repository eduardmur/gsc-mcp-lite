# Contributing

```bash
npm install
npm test          # builds dist/ first, then runs the suite (no network)
npm run lint      # biome
npm run typecheck
```

The code is four files in `src/`: `auth.ts` (which credentials file this is, sign-in, token storage), `gsc.ts` (the four API calls and error messages), `server.ts` (the MCP tools) and `index.ts` (the CLI). Keep it that size: features that interpret the data belong in [gsc-mcp](https://github.com/eduardmur/gsc-mcp), not here.

## Releasing

```bash
npm version patch       # or minor
npm publish
git push --follow-tags
npm run pack:mcpb       # builds gsc-mcp-lite.mcpb; attach it to the GitHub release
```

Bump `version` in `manifest.json` together with `package.json`.
