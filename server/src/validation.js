/**
 * Request validation layer (#650, #1067)
 *
 * Provides Zod schemas for every mutating and query-bearing endpoint, plus a
 * `validateRequest` helper that validates body, query parameters and headers
 * in one pass and returns a field-level 400 payload when anything fails.
 *
 * String inputs are sanitized (trimmed, control characters stripped, and lone
 * UTF-16 surrogates replaced) *before* schema checks run, so a value that is
 * only whitespace, padding, or malformed Unicode never crashes downstream
 * handlers (#1067).
 */

import { z } from "zod";
import { sendJson } from "./http-utils.js";

/** Stellar public key: G + 55 base32 characters. */
export const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
/** Stellar secret key: S + 55 base32 characters. */
export const STELLAR_SECRET_RE = /^S[A-Z2-7]{55}$/;
/** Soroban contract address: C + 55 base32 characters. */
export const STELLAR_CONTRACT_RE = /^C[A-Z2-7]{55}$/;
/**
 * DID for this network, e.g. `did:stellar:GABC…`.
 * The method-specific identifier is a Stellar account address.
 */
export const DID_RE = /^did:stellar:(G[A-Z2-7]{55})$/;
/**
 * Credential identifier: 3–128 characters of unreserved URL characters.
 * Deliberately excludes `/` and whitespace so an id can never alter routing
 * once it is interpolated back into a path.
 */
export const CREDENTIAL_ID_RE = /^[A-Za-z0-9._:-]{3,128}$/;

/**
 * Replace lone UTF-16 surrogates with U+FFFD and normalize to NFC so that
 * special Unicode characters (emoji, accented text, CJK, RTL marks, or
 * unpaired surrogates) never cause encoding/serialization crashes (#1067).
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeUnicodeString(value) {
  if (typeof value !== "string") return value;
  const wellFormed =
    typeof value.toWellFormed === "function"
      ? value.toWellFormed()
      : value.replace(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
          "\uFFFD",
        );
  try {
    return wellFormed.normalize("NFC");
  } catch {
    return wellFormed;
  }
}

/**
 * Strip ASCII control characters (including NUL and the C1 range), normalize
 * Unicode, and trim. Applied to every string before validation.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeString(value) {
  if (typeof value !== "string") return value;
  const normalized = normalizeUnicodeString(value);
  // eslint-disable-next-line no-control-regex
  return normalized.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

/**
 * Sanitize DID metadata values while preserving valid special Unicode
 * characters (emoji, non-Latin scripts, symbols, zero-width joiners) and
 * safely replacing lone surrogates or control characters (#1067).
 *
 * @param {unknown} metadata
 * @param {number} [depth=0]
 * @returns {Record<string, unknown>}
 */
export function sanitizeDidMetadata(metadata, depth = 0) {
  if (metadata === null || metadata === undefined) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("DID metadata must be a plain JSON object");
  }
  if (depth > 20) return {};

  const out = {};
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = sanitizeString(String(rawKey));
    if (!key) continue;
    out[key] = sanitizeDidMetadataValue(rawValue, depth + 1);
  }
  return out;
}

function sanitizeDidMetadataValue(value, depth) {
  if (depth > 20) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = normalizeUnicodeString(value);
    // Preserve printable Unicode (including newlines/tabs if needed, or strip C0/C1 except tab/newline)
    // eslint-disable-next-line no-control-regex
    return normalized.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDidMetadataValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return sanitizeDidMetadata(value, depth + 1);
  }
  return String(value);
}

/**
 * Recursively sanitize every string in a JSON-like value.
 * Object keys are sanitized too so a control character cannot smuggle a
 * duplicate-looking key past a schema.
 *
 * @param {unknown} value
 * @param {number} [depth=0]
 * @returns {unknown}
 */
export function sanitizeDeep(value, depth = 0) {
  if (depth > 20) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[sanitizeString(key)] = sanitizeDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** A trimmed, control-character-free string with a minimum length. */
const cleanString = (min = 1, max = 512) =>
  z
    .string()
    .transform(sanitizeString)
    .refine((value) => value.length >= min, {
      message: `Must be at least ${min} character(s) after trimming`,
    })
    .refine((value) => value.length <= max, {
      message: `Must be at most ${max} characters`,
    });

/** Stellar account address (G…). */
export const stellarAccount = z
  .string()
  .transform(sanitizeString)
  .refine((value) => STELLAR_ACCOUNT_RE.test(value), {
    message: "Must be a valid Stellar account address (G followed by 55 base32 characters)",
  });

/** Soroban contract address (C…). */
export const stellarContract = z
  .string()
  .transform(sanitizeString)
  .refine((value) => STELLAR_CONTRACT_RE.test(value), {
    message: "Must be a valid Soroban contract address (C followed by 55 base32 characters)",
  });

/** `did:stellar:G…` identifier. */
export const did = z
  .string()
  .transform(sanitizeString)
  .refine((value) => DID_RE.test(value), {
    message: "Must be a valid DID of the form did:stellar:<STELLAR_ACCOUNT>",
  });

/** Credential identifier. */
export const credentialId = z
  .string()
  .transform(sanitizeString)
  .refine((value) => CREDENTIAL_ID_RE.test(value), {
    message:
      "Must be 3-128 characters using letters, digits, dot, underscore, colon or hyphen",
  });

/** A subject may be given either as a raw Stellar account or as a DID. */
export const subject = z
  .string()
  .transform(sanitizeString)
  .refine((value) => STELLAR_ACCOUNT_RE.test(value) || DID_RE.test(value), {
    message: "Must be a Stellar account address or a did:stellar DID",
  });

/** An https/http URL, capped so a webhook target cannot be a data: payload. */
export const httpUrl = z
  .string()
  .transform(sanitizeString)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Must be a valid http(s) URL" },
  );

/** Query-string integer within an inclusive range. */
const intInRange = (min, max) =>
  z
    .string()
    .transform(sanitizeString)
    .refine((value) => /^\d+$/.test(value), { message: "Must be a non-negative integer" })
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => value >= min && value <= max, {
      message: `Must be between ${min} and ${max}`,
    });

/** Unix seconds timestamp; 0 means "never expires". */
const unixSeconds = z
  .number()
  .int("Must be an integer number of seconds")
  .min(0, "Must not be negative")
  .max(4102444800, "Must be before the year 2100");

export const API_SCOPES = [
  "*",
  "credentials:read",
  "credentials:write",
  "admin:read",
  "admin:write",
];

export const API_TIERS = ["free", "pro", "enterprise"];

/** Maximum operations accepted in one POST /batch request (#749). */
export const BATCH_MAX_OPERATIONS = 100;

/** Body shape of a single credential issuance, shared with the batch "issue" operation. */
const issueCredentialBody = z
  .object({
    id: credentialId,
    subject: subject.optional(),
    issuer: stellarAccount.optional(),
    type: cleanString(1, 128).optional(),
    claims: z.record(z.string(), z.unknown()).optional(),
    expiresAt: unixSeconds.optional(),
    revoked: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** One entry in a POST /batch request body. */
const batchOperation = z.discriminatedUnion("type", [
  z.object({ id: cleanString(1, 128).optional(), type: z.literal("issue"), payload: issueCredentialBody }).strict(),
  z
    .object({ id: cleanString(1, 128).optional(), type: z.literal("verify"), payload: z.object({ credentialId }).strict() })
    .strict(),
  z
    .object({ id: cleanString(1, 128).optional(), type: z.literal("revoke"), payload: z.object({ credentialId }).strict() })
    .strict(),
]);

/**
 * Schemas keyed by a route name. Each entry may declare `body`, `query`,
 * `params` and `headers`; absent sections are skipped.
 */
export const schemas = {
  issueCredential: {
    body: issueCredentialBody,
  },

   upsertDid: {
    body: z
      .object({
        did: did.optional(),
        address: stellarAccount.optional(),
        controller: z.string().transform(sanitizeString).optional(),
        metadata: z.record(z.string(), z.unknown()).optional().default({}),
        active: z.boolean().optional(),
      })
      .strict(),
  },

  batchOperations: {
    body: z
      .object({
        atomic: z.boolean().optional(),
        operations: z
          .array(batchOperation)
          .min(1, "Must contain at least one operation")
          .max(BATCH_MAX_OPERATIONS, `Must contain at most ${BATCH_MAX_OPERATIONS} operations`),
      })
      .strict(),
  },

  listCredentials: {
    query: z
      .object({
        limit: intInRange(1, 200).optional(),
        cursor: cleanString(1, 512).optional(),
        direction: z.enum(["next", "prev"]).optional(),
        page: intInRange(1, 100000).optional(),
        pageSize: intInRange(1, 200).optional(),
        fields: cleanString(1, 1024).optional(),
      })
      .strip(),
  },

  credentialByIdParams: {
    params: z.object({ credentialId }).strict(),
    query: z
      .object({
        fields: cleanString(1, 1024).optional(),
      })
      .strip(),
  },

  createWebhook: {
    body: z
      .object({
        url: httpUrl,
        events: z.array(cleanString(1, 64)).max(32).optional(),
        secret: cleanString(8, 256).optional(),
        authToken: cleanString(1, 512).optional(),
        description: cleanString(1, 512).optional(),
        active: z.boolean().optional(),
      })
      .strict(),
  },

  testWebhook: {
    body: z
      .object({
        url: httpUrl,
        secret: cleanString(1, 256).optional(),
        authToken: cleanString(1, 512).optional(),
      })
      .strict(),
  },

  webhookLogsQuery: {
    query: z
      .object({
        limit: intInRange(1, 500).optional(),
        webhookId: cleanString(1, 128).optional(),
      })
      .strip(),
  },

  addIssuer: {
    body: z.object({ issuer: stellarAccount }).strict(),
  },

  removeIssuer: {
    body: z.object({ issuer: stellarAccount.optional() }).strict(),
    query: z.object({ issuer: stellarAccount.optional() }).strip(),
  },

  expiryReportQuery: {
    query: z
      .object({
        windowDays: intInRange(1, 3650).optional(),
        page: intInRange(1, 100000).optional(),
        pageSize: intInRange(1, 200).optional(),
      })
      .strip(),
  },

  expiryThresholds: {
    body: z
      .object({
        thresholds: z
          .array(z.number().int().positive().max(3650))
          .min(1, "Must contain at least one positive integer")
          .max(20),
      })
      .strict(),
  },

  createApiKey: {
    body: z
      .object({
        name: cleanString(1, 128).optional(),
        owner: cleanString(1, 128).optional(),
        scopes: z.array(z.enum(API_SCOPES)).min(1).max(16).optional(),
        tier: z.enum(API_TIERS).optional(),
        expiresInDays: z.number().int().positive().max(3650).optional(),
      })
      .strict(),
  },

  rotateApiKey: {
    body: z
      .object({
        expiresInDays: z.number().int().positive().max(3650).optional(),
      })
      .strict(),
  },

  graphql: {
    body: z
      .object({
        query: cleanString(1, 100_000),
        variables: z.record(z.string(), z.unknown()).optional(),
        operationName: cleanString(1, 256).nullable().optional(),
      })
      .strip(),
  },

  registerOAuthClient: {
    body: z
      .object({
        name: cleanString(1, 128).optional(),
        redirectUris: z.array(httpUrl).min(1).max(10),
        scopes: z.array(z.enum(API_SCOPES)).min(1).max(16).optional(),
        grantTypes: z.array(z.enum(["authorization_code", "refresh_token"])).min(1).max(2).optional(),
      })
      .strict(),
  },

  oauthAuthorizeQuery: {
    query: z
      .object({
        response_type: z.literal("code"),
        client_id: cleanString(1, 256),
        redirect_uri: httpUrl,
        scope: cleanString(1, 512).optional(),
        state: cleanString(1, 512).optional(),
      })
      .strip(),
  },

  oauthToken: {
    body: z
      .object({
        grant_type: z.enum(["authorization_code", "refresh_token"]),
        code: cleanString(1, 256).optional(),
        redirect_uri: httpUrl.optional(),
        refresh_token: cleanString(1, 256).optional(),
        client_id: cleanString(1, 256),
        client_secret: cleanString(1, 256),
        scope: cleanString(1, 512).optional(),
      })
      .strict()
      .superRefine((body, ctx) => {
        if (body.grant_type === "authorization_code") {
          if (!body.code) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "code is required for the authorization_code grant" });
          }
          if (!body.redirect_uri) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["redirect_uri"], message: "redirect_uri is required for the authorization_code grant" });
          }
        }
        if (body.grant_type === "refresh_token" && !body.refresh_token) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refresh_token"], message: "refresh_token is required for the refresh_token grant" });
        }
      }),
  },

  oauthIntrospect: {
    body: z
      .object({
        token: cleanString(1, 512),
        token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
        client_id: cleanString(1, 256).optional(),
        client_secret: cleanString(1, 256).optional(),
      })
      .strict()
      .refine((body) => !body.client_id || Boolean(body.client_secret), {
        message: "client_secret is required when client_id is present",
        path: ["client_secret"],
      }),
  },

  oauthRevoke: {
    body: z
      .object({
        token: cleanString(1, 512),
        token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
        client_id: cleanString(1, 256).optional(),
        client_secret: cleanString(1, 256).optional(),
      })
      .strict()
      .refine((body) => !body.client_id || Boolean(body.client_secret), {
        message: "client_secret is required when client_id is present",
        path: ["client_secret"],
      }),
  },

  /** Headers accepted on every request; unknown headers are ignored. */
  commonHeaders: {
    headers: z
      .object({
        "x-request-id": cleanString(1, 200).optional(),
        "x-user-tier": z.enum(API_TIERS).optional(),
        "x-api-version": cleanString(1, 16).optional(),
        "x-actor": cleanString(1, 128).optional(),
      })
      .strip(),
  },
};

/**
 * Convert a ZodError into a flat, field-level error list.
 *
 * @param {import('zod').ZodError} error
 * @param {'body'|'query'|'params'|'headers'} source
 * @returns {Array<{field: string, source: string, message: string, code: string}>}
 */
export function formatZodError(error, source) {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : source,
    source,
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Lower-case every header name once so schemas can key on the canonical form.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {Record<string, string>}
 */
function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/**
 * Turn URLSearchParams into a plain object. Repeated keys keep the last value,
 * matching the behaviour of `searchParams.get()` used elsewhere in the server.
 *
 * @param {URLSearchParams} searchParams
 * @returns {Record<string, string>}
 */
export function searchParamsToObject(searchParams) {
  const out = {};
  for (const [key, value] of searchParams ?? []) {
    out[key] = value;
  }
  return out;
}

/**
 * Validate the pieces of a request against a schema set.
 *
 * @param {object} schemaSet - One entry from `schemas`
 * @param {object} input
 * @param {unknown} [input.body]
 * @param {URLSearchParams|Record<string,string>} [input.query]
 * @param {Record<string, unknown>} [input.params]
 * @param {Record<string, unknown>} [input.headers]
 * @returns {{success: boolean, data?: object, errors?: Array<object>}}
 */
export function validate(schemaSet, { body, query, params, headers } = {}) {
  const errors = [];
  const data = {};

  const sections = [
    ["body", schemaSet?.body, body === undefined ? undefined : sanitizeDeep(body)],
    [
      "query",
      schemaSet?.query,
      query instanceof URLSearchParams ? searchParamsToObject(query) : query,
    ],
    ["params", schemaSet?.params, params],
    ["headers", schemaSet?.headers, normalizeHeaders(headers)],
  ];

  for (const [name, schema, value] of sections) {
    if (!schema) continue;
    const result = schema.safeParse(value ?? {});
    if (result.success) {
      data[name] = result.data;
    } else {
      errors.push(...formatZodError(result.error, name));
    }
  }

  if (errors.length > 0) return { success: false, errors };
  return { success: true, data };
}

/**
 * Validate a request and, on failure, write a 400 response describing every
 * offending field.
 *
 * @returns {{ok: true, data: object}|{ok: false}} `ok:false` means the response
 *   has already been sent and the caller must return immediately.
 */
export function validateRequest(res, schemaSet, input) {
  const result = validate(schemaSet, input);
  if (result.success) return { ok: true, data: result.data };

  sendJson(res, 400, {
    error: "validation_failed",
    code: "VALIDATION_FAILED",
    message: "Request validation failed.",
    errors: result.errors,
  });
  return { ok: false };
}
