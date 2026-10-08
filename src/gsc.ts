import type { Auth, Credentials } from "./auth.js";
import { PACKAGE } from "./version.js";

const HOST = "https://searchconsole.googleapis.com";
const V3 = `${HOST}/webmasters/v3`;
const INSPECT = `${HOST}/v1/urlInspection/index:inspect`;
const REQUEST_TIMEOUT_MS = 60_000;

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export interface DimensionFilter {
  dimension: string;
  operator: string;
  expression: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  type?: string;
  dimensionFilterGroups?: Array<{ groupType: "and"; filters: DimensionFilter[] }>;
  rowLimit?: number;
  startRow?: number;
  aggregationType?: string;
  dataState?: string;
}

/** One row as Google returns it: keys in request order, absent when no dimensions were asked for. */
export interface ApiRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows?: ApiRow[];
  responseAggregationType?: string;
  metadata?: Record<string, unknown>;
}

export interface SitemapEntry {
  path: string;
  [key: string]: unknown;
}

export class GscError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GscError";
  }
}

export interface GscApi {
  listSites(): Promise<SiteEntry[]>;
  query(siteUrl: string, body: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse>;
  inspectUrl(
    siteUrl: string,
    inspectionUrl: string,
    languageCode?: string,
  ): Promise<Record<string, unknown>>;
  listSitemaps(siteUrl: string): Promise<SitemapEntry[]>;
}

/** Four calls, one attempt each. Property identifiers are path segments and must be fully encoded. */
export function createGscApi(auth: Auth): GscApi {
  async function call<T>(method: "GET" | "POST", url: string, data?: unknown): Promise<T> {
    const client = await auth.getClient();
    try {
      const response = await client.request<T>({ url, method, data, timeout: REQUEST_TIMEOUT_MS });
      return response.data;
    } catch (error) {
      const failure = inspectFailure(error);
      if (failure.authFailure) {
        auth.reset();
      }
      throw new GscError(describeFailure(failure, auth.credentials()), failure.status);
    }
  }

  return {
    async listSites() {
      const data = await call<{ siteEntry?: SiteEntry[] }>("GET", `${V3}/sites`);
      return data?.siteEntry ?? [];
    },
    async query(siteUrl, body) {
      const url = `${V3}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
      return (await call<SearchAnalyticsResponse>("POST", url, body)) ?? {};
    },
    async inspectUrl(siteUrl, inspectionUrl, languageCode) {
      const body = { siteUrl, inspectionUrl, languageCode };
      return (await call<Record<string, unknown>>("POST", INSPECT, body)) ?? {};
    },
    async listSitemaps(siteUrl) {
      const url = `${V3}/sites/${encodeURIComponent(siteUrl)}/sitemaps`;
      const data = await call<{ sitemap?: SitemapEntry[] }>("GET", url);
      return data?.sitemap ?? [];
    },
  };
}

export interface Failure {
  status?: number;
  message: string;
  /** The credentials themselves were rejected, not the request. */
  authFailure: boolean;
}

/** Reads a gaxios error (Google API JSON error or token-endpoint error) into one flat shape. */
export function inspectFailure(error: unknown): Failure {
  const e = record(error);
  const response = record(e.response);
  const data = record(response.data);
  const inner = record(data.error);
  const status =
    typeof response.status === "number"
      ? response.status
      : typeof e.status === "number"
        ? e.status
        : undefined;
  let message: string;
  if (typeof inner.message === "string") {
    message = inner.message;
  } else if (typeof data.error === "string") {
    const description = typeof data.error_description === "string" ? data.error_description : "";
    message = description ? `${data.error}: ${description}` : data.error;
  } else if (typeof e.message === "string" && e.message) {
    message = e.message;
  } else {
    message = String(error);
  }
  const authFailure =
    status === 401 || /invalid_grant|invalid_rapt|expired or revoked|invalid_client/i.test(message);
  return { status, message, authFailure };
}

const API_DISABLED =
  /not been used|is disabled|accessNotConfigured|SERVICE_DISABLED|has not enabled/i;
const SCOPES = /insufficient.*scope/i;

export function describeFailure(failure: Failure, creds: Credentials | null): string {
  const { status, message } = failure;
  if (failure.authFailure) {
    if (creds?.kind === "oauth_client") {
      return `Google rejected the saved sign-in (${message}). Call the tool again to sign in, or run: npx -y ${PACKAGE} login`;
    }
    return `Google rejected the credentials (${message}). Check the key file: the service account may have been deleted or the key revoked.`;
  }
  if (status === 403 && API_DISABLED.test(message)) {
    return `The Search Console API is not enabled in your Google Cloud project. Enable it at https://console.cloud.google.com/apis/library/searchconsole.googleapis.com and retry in a minute. Google said: ${message}`;
  }
  if (status === 403 && SCOPES.test(message)) {
    return `The credentials lack the Search Console scope (${message}). For gcloud ADC run: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`;
  }
  if (status === 403) {
    const fix =
      creds?.kind === "service_account"
        ? `Add ${creds.email} as a user of this property in Search Console (Settings → Users and permissions).`
        : "Sign in with a Google account that has access to this property.";
    return `Google denied access (403): ${message}. ${fix}`;
  }
  if (status === 404) {
    return `Not found (404): ${message}. Pass site_url exactly as list-properties returns it, e.g. "sc-domain:example.com" or "https://example.com/".`;
  }
  if (status === 429) {
    return `Quota exceeded (429): ${message}. Wait a minute and retry with fewer or smaller requests.`;
  }
  if (status === 400) {
    return `Google rejected the request (400): ${message}`;
  }
  return `Google API error${status ? ` (${status})` : ""}: ${message}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
