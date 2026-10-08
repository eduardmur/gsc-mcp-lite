import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defaultDateRange } from "./dates.js";
import type { ApiRow, GscApi } from "./gsc.js";
import { NAME, VERSION } from "./version.js";

export const INSTRUCTIONS =
  "Read-only access to the Google Search Console Performance report. Call list-properties first and pass site_url exactly as it is returned (https://example.com/ or sc-domain:example.com). Dates are YYYY-MM-DD in Pacific Time. Google finalizes data after 2-3 days; data_state=final (the default) leaves unfinished days out.";

export const DIMENSIONS = [
  "query",
  "page",
  "country",
  "device",
  "date",
  "searchAppearance",
  "hour",
] as const;
export const FILTER_DIMENSIONS = [
  "query",
  "page",
  "country",
  "device",
  "searchAppearance",
] as const;
export const OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
] as const;
export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
export const AGGREGATIONS = ["auto", "byPage", "byProperty", "byNewsShowcasePanel"] as const;
export const DATA_STATES = ["final", "all", "hourly_all"] as const;
export const DEFAULT_ROW_LIMIT = 1000;
export const MAX_ROW_LIMIT = 25_000;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const SITE_URL = z
  .string()
  .describe(
    "The property exactly as list-properties returns it: https://example.com/ or sc-domain:example.com",
  );
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export interface ServerOptions {
  /** Test seam: the clock behind the default date range. */
  now?: () => Date;
  /** The configured service-account email, for the hint when it sees no properties. */
  serviceAccountEmail?: () => string | null;
}

export function createServer(api: GscApi, options: ServerOptions = {}): McpServer {
  const now = options.now ?? (() => new Date());
  const server = new McpServer({ name: NAME, version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list-properties",
    {
      title: "List properties",
      description:
        "The Search Console properties these credentials can see, with the permission level of each. Their site_url values are what every other tool takes.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const sites = await api.listSites();
        const properties = sites.map((site) => ({
          site_url: site.siteUrl,
          permission_level: site.permissionLevel,
        }));
        const email = properties.length === 0 ? options.serviceAccountEmail?.() : null;
        return email
          ? {
              properties,
              hint: `No properties are shared with ${email}. In Search Console open the property, then Settings → Users and permissions → Add user, and add that email.`,
            }
          : { properties };
      }),
  );

  server.registerTool(
    "search-analytics",
    {
      title: "Search analytics",
      description:
        "The Performance report for one property: clicks, impressions, CTR and average position, grouped by the dimensions you choose (query, page, country, device, date, searchAppearance, hour; none = one row of totals for the period). Defaults: the last 28 finalized days, type web, 1000 rows; Google returns at most 25,000 rows per call, so page with start_row. Rows list only the queries and pages Google chooses to name; totals from a call without dimensions are the complete numbers.",
      inputSchema: {
        site_url: SITE_URL,
        start_date: DATE.optional().describe(
          "YYYY-MM-DD. Default: 27 days before end_date (a 28-day window).",
        ),
        end_date: DATE.optional().describe(
          "YYYY-MM-DD. Default: three days ago, the newest day Google has usually finalized.",
        ),
        dimensions: z
          .array(z.enum(DIMENSIONS))
          .optional()
          .describe(
            "Group rows by these, in this order. Omit for totals. hour needs data_state=hourly_all and a range of at most 10 days.",
          ),
        filters: z
          .array(
            z.object({
              dimension: z.enum(FILTER_DIMENSIONS),
              operator: z.enum(OPERATORS),
              expression: z.string(),
            }),
          )
          .optional()
          .describe(
            "All filters must match (AND). Regex operators use RE2 syntax. country expressions are 3-letter ISO codes in lowercase (usa, deu).",
          ),
        type: z.enum(SEARCH_TYPES).optional().describe("Search type. Default web."),
        row_limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROW_LIMIT)
          .optional()
          .describe(`Rows to return, 1-${MAX_ROW_LIMIT}. Default ${DEFAULT_ROW_LIMIT}.`),
        start_row: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based offset for paging. Default 0."),
        aggregation_type: z
          .enum(AGGREGATIONS)
          .optional()
          .describe("auto (default), byPage, byProperty or byNewsShowcasePanel."),
        data_state: z
          .enum(DATA_STATES)
          .optional()
          .describe(
            "final (default): finalized days only. all: also the latest, still-changing days. hourly_all: required for the hour dimension.",
          ),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const range = defaultDateRange(now());
        const dimensions = args.dimensions ?? [];
        const rowLimit = args.row_limit ?? DEFAULT_ROW_LIMIT;
        const startRow = args.start_row ?? 0;
        const endDate = args.end_date ?? range.end;
        const startDate = args.start_date ?? range.start;
        const response = await api.query(args.site_url, {
          startDate,
          endDate,
          ...(dimensions.length > 0 ? { dimensions } : {}),
          ...(args.type ? { type: args.type } : {}),
          ...(args.data_state ? { dataState: args.data_state } : {}),
          ...(args.aggregation_type ? { aggregationType: args.aggregation_type } : {}),
          ...(args.filters && args.filters.length > 0
            ? { dimensionFilterGroups: [{ groupType: "and" as const, filters: args.filters }] }
            : {}),
          rowLimit,
          startRow,
        });
        const rows = (response.rows ?? []).map((row) => shapeRow(row, dimensions));
        return {
          site_url: args.site_url,
          start_date: startDate,
          end_date: endDate,
          dimensions,
          type: args.type ?? "web",
          data_state: args.data_state ?? "final",
          row_count: rows.length,
          ...(rows.length === rowLimit ? { next_start_row: startRow + rowLimit } : {}),
          ...(response.responseAggregationType
            ? { response_aggregation_type: response.responseAggregationType }
            : {}),
          ...(response.metadata ? { metadata: response.metadata } : {}),
          rows,
        };
      }),
  );

  return server;
}

/** Google's keys array becomes named fields; ctr and position are rounded to what the UI shows. */
export function shapeRow(row: ApiRow, dimensions: readonly string[]): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  dimensions.forEach((dimension, index) => {
    shaped[dimension] = row.keys?.[index] ?? "";
  });
  shaped.clicks = row.clicks;
  shaped.impressions = row.impressions;
  shaped.ctr = round(row.ctr, 4);
  shaped.position = round(row.position, 1);
  return shaped;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
