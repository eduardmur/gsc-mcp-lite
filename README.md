# gsc-mcp-lite

Google Search Console data in Claude, Cursor or any other MCP client. Four read-only tools:

| Tool | Returns |
| --- | --- |
| `list-properties` | The properties your credentials can see, with permission levels. |
| `search-analytics` | Any Search Analytics query: clicks, impressions, CTR and position by query, page, country, device, date, search appearance or hour, with filters, search type and paging. |
| `inspect-url` | Google's index status for one URL: verdict, coverage, last crawl, canonical, rich results. |
| `list-sitemaps` | Submitted sitemaps with their status, errors and counts. |

There is no analysis layer, no prompts, no cache and no settings. You ask the question, the model builds the query, Google answers. This package is for people who want the raw data and nothing in between.

It runs on your machine, talks only to `googleapis.com`, asks Google for the read-only Search Console scope, and never changes anything in your account.

## Setup

You need [Node.js](https://nodejs.org) 20 or newer (the LTS installer, on macOS or Windows) and one credentials file from Google Cloud. The Claude Desktop bundle described below works without Node.js.

### 1. Get a credentials file

Pick one of the two. A service account is simpler and behaves the same on every machine. An OAuth client lets you sign in with your own Google account and see everything it sees.

#### Service account

1. Create a Google Cloud project or open an existing one: https://console.cloud.google.com/projectcreate. No billing is needed.
2. Enable the Search Console API: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com, then **Enable**.
3. Create a service account: https://console.cloud.google.com/iam-admin/serviceaccounts, then **Create service account**. Any name, no roles.
4. Open it, then **Keys**, **Add key**, **Create new key**, **JSON**. A file downloads. Treat it like a password.
5. In [Search Console](https://search.google.com/search-console), open each property, then **Settings**, **Users and permissions**, **Add user**. Paste the service account's email (it ends in `.iam.gserviceaccount.com`) and give it **Full** permission.

If your organization blocks service-account keys, use an OAuth client instead.

#### OAuth client

1. Do steps 1 and 2 above.
2. Configure the consent screen: https://console.cloud.google.com/auth/branding. User type **External**, any app name, your email.
3. Publish the app: https://console.cloud.google.com/auth/audience, then **Publish app**. If you skip this, Google expires your sign-in every 7 days. No verification is needed. Sign-in shows an "unverified app" warning because your own client never went through Google's review; click **Advanced**, then **Go to ... (unsafe)**.
4. Create a client: https://console.cloud.google.com/auth/clients, **Create client**, application type **Desktop app**. Download the JSON.
5. The first time the server needs Google it opens a browser for the sign-in and remembers it. To do this up front from a terminal:

   ```bash
   npx -y @eduardmur/gsc-mcp-lite login --credentials /path/to/client.json
   ```

### 2. Point your MCP client at the file

The server takes one setting: `GSC_CREDENTIALS`, the path to that JSON file. Keep the file somewhere permanent rather than in Downloads.

#### Claude Desktop, one click

Download `gsc-mcp-lite.mcpb` from the [releases page](https://github.com/eduardmur/gsc-mcp-lite/releases) and open it. Claude Desktop asks for the credentials file in a dialog, and nothing else needs installing.

#### Claude Desktop, macOS

Settings, Developer, Edit Config opens `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "npx",
      "args": ["-y", "@eduardmur/gsc-mcp-lite"],
      "env": { "GSC_CREDENTIALS": "/Users/you/gsc/key.json" }
    }
  }
}
```

#### Claude Desktop, Windows

The file is `%APPDATA%\Claude\claude_desktop_config.json`. Backslashes in the path are doubled, and `npx` runs through `cmd`:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@eduardmur/gsc-mcp-lite"],
      "env": { "GSC_CREDENTIALS": "C:\\Users\\you\\gsc\\key.json" }
    }
  }
}
```

Restart Claude Desktop after saving. The tools appear under the tools icon in the chat box.

#### Claude Code

```bash
claude mcp add gsc -e GSC_CREDENTIALS=/path/to/key.json -- npx -y @eduardmur/gsc-mcp-lite
```

#### Cursor, Windsurf, VS Code, others

Paste the macOS or Windows JSON above into the client's MCP settings.

### 3. Check

```bash
npx -y @eduardmur/gsc-mcp-lite check --credentials /path/to/key.json
```

This prints the properties the credentials can see, or the exact problem. Then ask the model something:

- "List my Search Console properties."
- "Top 20 queries for example.com in the last 28 days."
- "Clicks by day for pages under /blog/ in September 2026."
- "Is https://example.com/pricing indexed, and which canonical did Google pick?"

## What the API gives you

These are limits of Search Console itself. The tool descriptions repeat them to the model.

- Google finalizes a day's data two to three days later. By default queries end three days ago and cover the 28 days before that; pass `data_state=all` to include newer, still-changing days.
- Dates are calendar days in Pacific Time.
- Rows list only the queries and pages Google chooses to name. A query with no dimensions returns the complete totals for the period; adding up rows gives less.
- One call returns at most 25,000 rows. The response carries `next_start_row` when there are more.
- Country values are three-letter ISO codes in lowercase, such as `usa` or `deu`.
- Hourly data needs `data_state=hourly_all` and a range of at most 10 days.
- `inspect-url` is limited by Google to 2,000 URLs per property per day.
- Nothing older than about 16 months is available.

## Troubleshooting

- "Cannot read the credentials file": the path in `GSC_CREDENTIALS` is wrong. On Windows, double every backslash in the JSON config.
- `npx` is not recognized (Windows): install Node.js LTS, then quit and reopen Claude Desktop so it sees the new PATH. Keep the `cmd /c` form shown above, or use the `.mcpb` bundle, which needs no Node.js.
- Empty property list or a 403 with a service account: the service account has not been added to the property in Search Console (step 5), or the Search Console API is not enabled in the project (step 2).
- Sign-in expires every week (OAuth): the app is still in Testing. Publish it (OAuth step 3) and sign in again.
- Sign out: delete the token file in `~/Library/Application Support/gsc-mcp-lite` (macOS), `%APPDATA%\gsc-mcp-lite` (Windows) or `~/.config/gsc-mcp-lite` (Linux). To revoke the grant itself, use https://myaccount.google.com/permissions.
- Without `GSC_CREDENTIALS` the server falls back to Google's Application Default Credentials, which work after `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`.

## Privacy

The server runs locally and makes requests only to Google. Tokens stay in the directory above with owner-only permissions on macOS and Linux. There is no telemetry.

## License

MIT
