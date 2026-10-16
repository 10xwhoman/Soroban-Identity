/**
 * v1 route helpers (#878).
 *
 * Defines the canonical route map for API version 1 and helper utilities
 * used by both v1 handlers in app.js and the version negotiation tests.
 *
 * v1 is the default version and remains fully backward-compatible: requests
 * to unversioned paths (e.g. `/credentials`) are transparently treated as
 * `/v1/credentials` by the version middleware.
 */

export const V1_PREFIX = "/v1";

/**
 * Canonical route descriptors for v1.
 * Each entry maps a logical name to the method + path pattern (without prefix).
 */
export const V1_ROUTES = {
  listCredentials:     { method: "GET",    path: "/credentials" },
  getCredential:       { method: "GET",    path: "/credentials/:id" },
  credentialStatus:    { method: "GET",    path: "/credentials/:id/status" },
  verifyCredential:    { method: "POST",   path: "/credentials/:id/verify" },
  issueCredential:     { method: "POST",   path: "/credentials" },
  revokeCredential:    { method: "POST",   path: "/credentials/:id/revoke" },
  batchOperations:     { method: "POST",   path: "/batch" },
  listWebhooks:        { method: "GET",    path: "/webhooks" },
  createWebhook:       { method: "POST",   path: "/webhooks" },
  deleteWebhook:       { method: "DELETE", path: "/webhooks/:id" },
  listIssuers:         { method: "GET",    path: "/admin/issuers" },
  addIssuer:           { method: "POST",   path: "/admin/issuers" },
  removeIssuer:        { method: "DELETE", path: "/admin/issuers" },
  expiryReport:        { method: "GET",    path: "/admin/expiry-report" },
  networkStatistics:   { method: "GET",    path: "/analytics/network-statistics" },
  health:              { method: "GET",    path: "/health" },
  info:                { method: "GET",    path: "/info" },
  metrics:             { method: "GET",    path: "/metrics" },
};

/**
 * Given a bare path (no version prefix), return the v1-prefixed equivalent.
 *
 * @param {string} path  e.g. "/credentials"
 * @returns {string}     e.g. "/v1/credentials"
 */
export function withV1Prefix(path) {
  if (path.startsWith(V1_PREFIX)) return path;
  return `${V1_PREFIX}${path}`;
}

/**
 * Strip the /v1 prefix from a path if present, normalising to the bare form.
 *
 * @param {string} path  e.g. "/v1/credentials"
 * @returns {string}     e.g. "/credentials"
 */
export function stripV1Prefix(path) {
  if (path.startsWith(V1_PREFIX + "/")) return path.slice(V1_PREFIX.length);
  if (path === V1_PREFIX) return "/";
  return path;
}

/**
 * v1 response envelope – the response body is returned as-is.
 * Included for symmetry with v2's wrapResponse helper.
 *
 * @param {*} data
 * @returns {*}
 */
export function wrapResponse(data) {
  return data;
}

/**
 * Scopes permitted to read aggregated network statistics.
 */
export const NETWORK_STATISTICS_SCOPES = ["admin:read", "analytics:read"];

/**
 * Check whether the given scopes grant access to network statistics.
 *
 * @param {string[]|string|undefined} scopes
 * @returns {boolean}
 */
export function canReadNetworkStatistics(scopes) {
  if (!scopes) return false;
  const list = Array.isArray(scopes) ? scopes : String(scopes).split(/\s+/);
  return list.some((scope) => NETWORK_STATISTICS_SCOPES.includes(scope));
}

/**
 * GET /analytics/network-statistics handler.
 *
 * Returns the aggregated network statistics payload produced by
 * AnalyticsService (DID/credential totals over time, top issuers,
 * geographic distribution, verification success rate, credential type
 * distribution, etc.).
 *
 * Requires the `admin:read` or `analytics:read` scope.
 *
 * @param {object} deps
 * @param {{ getNetworkStatistics: Function }} deps.analyticsService
 * @param {object} [deps.query]  optional query params forwarded to the service
 * @returns {Promise<*>}
 */
export async function getNetworkStatistics({ analyticsService, query = {} } = {}) {
  if (!analyticsService || typeof analyticsService.getNetworkStatistics !== "function") {
    throw new Error("AnalyticsService with getNetworkStatistics() is required");
  }
  return analyticsService.getNetworkStatistics(query);
}

/**
 * Build the v1 route map entry for network statistics, including the
 * required scope check, so app.js can register it consistently.
 *
 * @param {object} deps
 * @param {{ getNetworkStatistics: Function }} deps.analyticsService
 * @returns {{ method: string, path: string, scopes: string[], handler: Function }}
 */
export function networkStatisticsRoute({ analyticsService } = {}) {
  return {
    method: V1_ROUTES.networkStatistics.method,
    path: withV1Prefix(V1_ROUTES.networkStatistics.path),
    scopes: NETWORK_STATISTICS_SCOPES,
    handler: (req) => {
      if (!canReadNetworkStatistics(req?.scopes ?? req?.user?.scopes)) {
        const err = new Error("Insufficient scope for network statistics");
        err.status = 403;
        throw err;
      }
      return getNetworkStatistics({ analyticsService, query: req?.query });
    },
  };
}
