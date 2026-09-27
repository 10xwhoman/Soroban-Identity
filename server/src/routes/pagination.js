/**
 * Standard pagination metadata for list endpoints (#958)
 *
 * Every paginated list response carries a `pagination` object alongside its
 * existing fields:
 *
 *   {
 *     "pagination": {
 *       "total_count": 137,
 *       "page_size": 50,
 *       "has_more": true,
 *       "next_cursor": "eyJvIjo1MH0",
 *       "previous_cursor": null
 *     }
 *   }
 *
 * and the same information as headers:
 *
 *   Link: <https://api/...?cursor=...>; rel="next", <...>; rel="first"
 *   X-Total-Count: 137
 *   X-Page-Size: 50
 *   X-Has-More: true
 *
 * Cursors are opaque. Endpoints backed by an in-memory array use offset
 * cursors (base64url `{"o": <offset>}`); `/credentials` keeps its id-anchored
 * cursors from #746. Clients should always pass back exactly the string a
 * previous response gave them.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Clamp a requested page size into `[1, max]`, falling back to the default for
 * anything missing or unparsable.
 */
export function resolvePageSize(value, { fallback = DEFAULT_PAGE_SIZE, max = MAX_PAGE_SIZE } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function encodeOffsetCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

/**
 * Decode an offset cursor. Returns null for a missing or malformed cursor so
 * the caller can fall back to the first page rather than erroring.
 */
export function decodeOffsetCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (decoded && Number.isSafeInteger(decoded.o) && decoded.o >= 0) return decoded.o;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Slice one page out of an array.
 *
 * `cursor` wins over `offset` when both are given, so a client following
 * `next_cursor` is never thrown off by a stale `offset` left in the URL.
 */
export function paginateArray(items, { pageSize, cursor = null, offset = 0, maxPageSize = MAX_PAGE_SIZE } = {}) {
  const size = resolvePageSize(pageSize, { max: maxPageSize });
  const total = items.length;
  const fromCursor = decodeOffsetCursor(cursor);
  const start = Math.min(fromCursor ?? Math.max(0, Number.parseInt(offset, 10) || 0), total);
  const end = Math.min(start + size, total);
  const hasMore = end < total;

  return {
    items: items.slice(start, end),
    offset: start,
    meta: buildPaginationMeta({
      totalCount: total,
      pageSize: size,
      hasMore,
      nextCursor: hasMore ? encodeOffsetCursor(end) : null,
      previousCursor: start > 0 ? encodeOffsetCursor(Math.max(0, start - size)) : null,
      firstCursor: start > 0 ? encodeOffsetCursor(0) : null,
      lastCursor: hasMore ? encodeOffsetCursor(Math.floor((total - 1) / size) * size) : null,
    }),
  };
}

/**
 * Build the `pagination` block. `totalCount` may be null when the backing
 * store cannot count cheaply; the field is still present so clients can rely
 * on the shape.
 */
export function buildPaginationMeta({
  totalCount = null,
  pageSize,
  hasMore,
  nextCursor = null,
  previousCursor = null,
  firstCursor = null,
  lastCursor = null,
  extraLinkParams = {},
}) {
  const meta = {
    total_count: totalCount,
    page_size: pageSize,
    has_more: Boolean(hasMore),
    next_cursor: nextCursor,
    previous_cursor: previousCursor,
  };
  // Link-only details are kept off the enumerable body.
  Object.defineProperty(meta, 'links', {
    value: { firstCursor, lastCursor, extraLinkParams },
    enumerable: false,
  });
  return meta;
}

/** Params that describe a position and must not leak into generated links. */
const POSITION_PARAMS = ['cursor', 'offset', 'page', 'direction'];

function linkFor(url, cursor, pageSize, extra = {}) {
  const target = new URL(url);
  for (const param of POSITION_PARAMS) target.searchParams.delete(param);
  if (cursor) target.searchParams.set('cursor', cursor);
  target.searchParams.set('limit', String(pageSize));
  for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);
  return target;
}

/**
 * RFC 8288 `Link` header value for a page, or null when there is nowhere to
 * go. `rel="first"` is omitted on the first page itself.
 */
export function buildLinkHeader(url, meta) {
  const { firstCursor, lastCursor, extraLinkParams = {} } = meta.links ?? {};
  const links = [];
  const add = (rel, target) => links.push(`<${target.pathname}${target.search}>; rel="${rel}"`);

  if (meta.next_cursor) add('next', linkFor(url, meta.next_cursor, meta.page_size, extraLinkParams.next));
  if (meta.previous_cursor) add('prev', linkFor(url, meta.previous_cursor, meta.page_size, extraLinkParams.prev));
  if (meta.previous_cursor || firstCursor) add('first', linkFor(url, null, meta.page_size));
  if (lastCursor) add('last', linkFor(url, lastCursor, meta.page_size));

  return links.length > 0 ? links.join(', ') : null;
}

/**
 * Set `Link`, `X-Total-Count`, `X-Page-Size` and `X-Has-More` on the response.
 * Links are path-relative so they stay correct behind a proxy that rewrites
 * the host.
 */
export function setPaginationHeaders(res, url, meta) {
  const link = buildLinkHeader(url, meta);
  if (link) res.setHeader('Link', link);
  if (meta.total_count !== null && meta.total_count !== undefined) {
    res.setHeader('X-Total-Count', String(meta.total_count));
  }
  res.setHeader('X-Page-Size', String(meta.page_size));
  res.setHeader('X-Has-More', String(meta.has_more));
}
