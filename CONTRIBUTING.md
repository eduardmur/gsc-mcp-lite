# Contributing

```bash
npm install
npm test          # builds dist/ first, then runs the suite (no network)
npm run lint      # biome
npm run typecheck
```

The code is four files in `src/`: `auth.ts` (which credentials file this is, sign-in, token storage), `gsc.ts` (the four API calls and error messages), `server.ts` (the MCP tools) and `index.ts` (the CLI). Keep it that size: features that interpret the data belong in [gsc-mcp](https://github.com/eduardmur/gsc-mcp), not here.

## Releasing

1. Set the same new version in `package.json` and `manifest.json`, commit, and tag it: `git tag v0.1.1`.
2. `git push && git push --tags`.

The Release workflow runs the tests, publishes to npm through trusted publishing (no token lives in the repo), builds `gsc-mcp-lite.mcpb` and attaches it to a GitHub release for the tag. `npm run pack:mcpb` builds the bundle locally if you need it without a release.
