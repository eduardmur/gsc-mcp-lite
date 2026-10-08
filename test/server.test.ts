import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type GscApi, GscError } from "../src/gsc.js";
import { createServer, INSTRUCTIONS, shapeRow } from "../src/server.js";

const api: GscApi = {
  listSites: vi.fn(async () => []),
  query: vi.fn(async () => ({
    rows: [
      {
        keys: ["how to x", "https://x.com/a"],
        clicks: 10,
        impressions: 230,
        ctr: 0.0434782,
        position: 12.3456,
      },
    ],
    responseAggregationType: "byPage",
  })),
};

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { isError: result.isError === true, body: body as Record<string, unknown>, text };
}

beforeAll(async () => {
  const server = createServer(api, {
    now: () => new Date("2026-10-08T12:00:00Z"),
    serviceAccountEmail: () => "bot@p.iam.gserviceaccount.com",
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

describe("tools", () => {
  it("registers two read-only tools and short instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list-properties", "search-analytics"]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description?.length ?? 0).toBeLessThan(600);
    }
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThan(400);
  });

  it("list-properties hints when a service account sees nothing", async () => {
    const { body } = await call("list-properties");
    expect(body.properties).toEqual([]);
    expect(body.hint).toContain("bot@p.iam.gserviceaccount.com");
  });

  it("search-analytics fills defaults, shapes rows, and reports paging", async () => {
    const { body, isError } = await call("search-analytics", {
      site_url: "sc-domain:x.com",
      dimensions: ["query", "page"],
      row_limit: 1,
      filters: [{ dimension: "country", operator: "equals", expression: "usa" }],
    });
    expect(isError).toBe(false);
    expect(api.query).toHaveBeenLastCalledWith("sc-domain:x.com", {
      startDate: "2026-09-08",
      endDate: "2026-10-05",
      dimensions: ["query", "page"],
      dimensionFilterGroups: [
        {
          groupType: "and",
          filters: [{ dimension: "country", operator: "equals", expression: "usa" }],
        },
      ],
      rowLimit: 1,
      startRow: 0,
    });
    expect(body).toMatchObject({
      start_date: "2026-09-08",
      end_date: "2026-10-05",
      type: "web",
      data_state: "final",
      row_count: 1,
      next_start_row: 1,
      response_aggregation_type: "byPage",
      rows: [
        {
          query: "how to x",
          page: "https://x.com/a",
          clicks: 10,
          impressions: 230,
          ctr: 0.0435,
          position: 12.3,
        },
      ],
    });
  });

  it("search-analytics passes explicit options through untouched", async () => {
    await call("search-analytics", {
      site_url: "https://x.com/",
      start_date: "2026-01-01",
      end_date: "2026-01-07",
      type: "discover",
      data_state: "all",
      aggregation_type: "byProperty",
      start_row: 1000,
    });
    expect(api.query).toHaveBeenLastCalledWith("https://x.com/", {
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      type: "discover",
      dataState: "all",
      aggregationType: "byProperty",
      rowLimit: 1000,
      startRow: 1000,
    });
  });

  it("rejects bad input before calling Google", async () => {
    const before = vi.mocked(api.query).mock.calls.length;
    const { isError, text } = await call("search-analytics", {
      site_url: "x",
      start_date: "Jan 1",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/YYYY-MM-DD/);
    const limit = await call("search-analytics", { site_url: "x", row_limit: 30000 });
    expect(limit.isError).toBe(true);
    expect(vi.mocked(api.query).mock.calls.length).toBe(before);
  });

  it("turns API errors into isError results with the message", async () => {
    vi.mocked(api.query).mockRejectedValueOnce(new GscError("Not found (404): nope", 404));
    const { isError, text } = await call("search-analytics", { site_url: "sc-domain:nope" });
    expect(isError).toBe(true);
    expect(text).toBe("Not found (404): nope");
  });
});

describe("shapeRow", () => {
  it("handles totals rows without keys", () => {
    expect(shapeRow({ clicks: 1, impressions: 2, ctr: 0.5, position: 1 }, [])).toEqual({
      clicks: 1,
      impressions: 2,
      ctr: 0.5,
      position: 1,
    });
  });
});
