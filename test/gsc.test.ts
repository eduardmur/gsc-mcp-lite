import { describe, expect, it, type Mock, vi } from "vitest";
import type { Auth } from "../src/auth.js";
import { createGscApi, describeFailure, GscError, inspectFailure } from "../src/gsc.js";

function fakeAuth(
  request: (options: { url: string }) => Promise<unknown>,
  kind?: "service_account" | "oauth_client",
): Auth & { reset: Mock<() => void> } {
  const creds =
    kind === "service_account"
      ? { kind, email: "bot@p.iam.gserviceaccount.com", json: {} }
      : kind === "oauth_client"
        ? { kind, clientId: "id", clientSecret: "s" }
        : null;
  return {
    source: () => "fake",
    credentials: () => creds as Auth extends { credentials: () => infer R } ? R : never,
    getClient: async () => ({ request }) as never,
    login: async () => null,
    reset: vi.fn<() => void>(),
  };
}

describe("createGscApi", () => {
  it("encodes property identifiers and posts the query body", async () => {
    const request = vi.fn(async (options: { url: string }) => {
      if (options.url.endsWith("/sites")) {
        return {
          data: { siteEntry: [{ siteUrl: "sc-domain:x.com", permissionLevel: "siteOwner" }] },
        };
      }
      if (options.url.includes("searchAnalytics")) {
        return {
          data: { rows: [{ keys: ["a"], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] },
        };
      }
      if (options.url.includes("urlInspection")) {
        return { data: { inspectionResult: { indexStatusResult: { verdict: "PASS" } } } };
      }
      return { data: { sitemap: [{ path: "https://x.com/sitemap.xml" }] } };
    });
    const api = createGscApi(fakeAuth(request));

    expect(await api.listSites()).toEqual([
      { siteUrl: "sc-domain:x.com", permissionLevel: "siteOwner" },
    ]);
    const body = { startDate: "2026-01-01", endDate: "2026-01-28", dimensions: ["query"] };
    expect((await api.query("https://x.com/", body)).rows).toHaveLength(1);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fx.com%2F/searchAnalytics/query",
        data: body,
      }),
    );
    await api.inspectUrl("sc-domain:x.com", "https://x.com/p", "de");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
        data: { siteUrl: "sc-domain:x.com", inspectionUrl: "https://x.com/p", languageCode: "de" },
      }),
    );
    expect(await api.listSitemaps("sc-domain:x.com")).toEqual([
      { path: "https://x.com/sitemap.xml" },
    ]);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Ax.com/sitemaps",
      }),
    );
  });

  it("returns empty lists when Google omits the array", async () => {
    const api = createGscApi(fakeAuth(async () => ({ data: {} })));
    expect(await api.listSites()).toEqual([]);
    expect(await api.listSitemaps("sc-domain:x.com")).toEqual([]);
  });

  it("wraps API errors and resets auth only on credential failures", async () => {
    const denied = {
      response: {
        status: 403,
        data: { error: { message: "User does not have sufficient permission for site" } },
      },
    };
    const auth = fakeAuth(async () => {
      throw denied;
    }, "service_account");
    const api = createGscApi(auth);
    const error = await api.listSites().catch((e) => e);
    expect(error).toBeInstanceOf(GscError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("Add bot@p.iam.gserviceaccount.com as a user");
    expect(auth.reset).not.toHaveBeenCalled();

    const revoked = {
      response: {
        status: 400,
        data: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
      },
    };
    const oauth = fakeAuth(async () => {
      throw revoked;
    }, "oauth_client");
    const message = await createGscApi(oauth)
      .listSites()
      .catch((e) => e.message);
    expect(message).toMatch(/Call the tool again to sign in/);
    expect(oauth.reset).toHaveBeenCalledTimes(1);
  });
});

describe("inspectFailure + describeFailure", () => {
  const sa = { kind: "service_account" as const, email: "bot@p.iam.gserviceaccount.com", json: {} };

  it("maps the statuses users actually hit", () => {
    const f = (status: number, message: string) =>
      describeFailure({ status, message, authFailure: false }, sa);
    expect(
      f(403, "Search Console API has not been used in project 123 before or it is disabled."),
    ).toMatch(/not enabled/);
    expect(f(403, "Request had insufficient authentication scopes.")).toMatch(
      /gcloud auth application-default login/,
    );
    expect(f(403, "forbidden")).toMatch(/Add bot@p/);
    expect(
      describeFailure({ status: 403, message: "forbidden", authFailure: false }, null),
    ).toMatch(/Sign in with a Google account/);
    expect(f(404, "Site not found")).toMatch(/list-properties/);
    expect(f(429, "Quota exceeded")).toMatch(/Wait a minute/);
    expect(f(400, "startDate must be before endDate")).toBe(
      "Google rejected the request (400): startDate must be before endDate",
    );
    expect(f(500, "boom")).toBe("Google API error (500): boom");
  });

  it("reads gaxios shapes and plain errors", () => {
    expect(
      inspectFailure({
        response: { status: 401, data: { error: { message: "Invalid Credentials" } } },
      }),
    ).toEqual({ status: 401, message: "Invalid Credentials", authFailure: true });
    expect(
      inspectFailure({
        response: {
          status: 400,
          data: { error: "invalid_grant", error_description: "Bad Request" },
        },
      }),
    ).toEqual({ status: 400, message: "invalid_grant: Bad Request", authFailure: true });
    expect(inspectFailure(new Error("socket hang up"))).toEqual({
      status: undefined,
      message: "socket hang up",
      authFailure: false,
    });
    expect(inspectFailure("weird")).toEqual({
      status: undefined,
      message: "weird",
      authFailure: false,
    });
  });
});
