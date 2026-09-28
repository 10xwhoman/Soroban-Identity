# Cursor Pagination

## Overview

`GET /credentials` pages through results using an opaque cursor rather than an offset, so results stay stable even as credentials are issued or revoked between requests.

## Cursor format

A cursor is the base64url encoding of `{"id": "<credential id>"}`. Treat it as opaque — always pass back exactly the string a previous response gave you, in `?cursor=`.

```bash
curl "http://localhost:3001/credentials?limit=25"
```

```json
{
  "items": [ ... ],
  "nextCursor": "eyJpZCI6ImNyZWQtMDI0In0",
  "previousCursor": null
}
```

```bash
curl "http://localhost:3001/credentials?limit=25&cursor=eyJpZCI6ImNyZWQtMDI0In0"
```

An unrecognized or already-deleted cursor id falls back to the first page (`next`) or last page (`prev`) rather than erroring — the credential it pointed at may simply no longer exist. A bare id string (pre-#746 clients) is also accepted as a legacy cursor form.

## Paging backward

Pass `direction=prev` alongside `cursor` to walk backward through the same ordering (results are still returned in forward order, just the page immediately *before* the cursor):

```bash
curl "http://localhost:3001/credentials?limit=25&cursor=<previousCursor>&direction=prev"
```

Every response includes both `nextCursor` and `previousCursor`, so a client can page either direction from any page. Either is `null` when there is nothing further in that direction.

## Limits

`limit` is clamped to `[1, 200]` (default 50).

## Offset pagination (unaffected)

`GET /admin/expiry-report` continues to use classic `page`/`pageSize` offset pagination (`{ page, pageSize, totalItems, totalPages, hasNextPage, items }`) — cursor pagination is additive and does not replace it. Use whichever fits the caller: offset pagination supports jumping to an arbitrary page number; cursor pagination stays correct under concurrent writes.

## Pagination metadata (#958)

Every paginated list endpoint returns a standard `pagination` block next to its existing fields, and mirrors it in response headers. Existing fields (`nextCursor`, `logs`, `entries`, `page`/`totalItems`, …) are unchanged, so current clients keep working.

| Field | Header | Meaning |
|---|---|---|
| `total_count` | `X-Total-Count` | Items matching the query across all pages. |
| `page_size` | `X-Page-Size` | Maximum items in this page (the clamped `limit`/`pageSize`). |
| `has_more` | `X-Has-More` | Whether another page exists in the direction of travel. |
| `next_cursor` | `Link: rel="next"` | Opaque cursor for the next page, or `null`. |
| `previous_cursor` | `Link: rel="prev"` | Opaque cursor for the previous page, or `null`. |

```json
{
  "logs": [ ... ],
  "pagination": {
    "total_count": 137,
    "page_size": 50,
    "has_more": true,
    "next_cursor": "eyJvIjo1MH0",
    "previous_cursor": null
  }
}
```

```
Link: </webhooks/logs?limit=50&cursor=eyJvIjo1MH0>; rel="next", </webhooks/logs?limit=50&cursor=eyJvIjoxMDB9>; rel="last"
X-Total-Count: 137
X-Page-Size: 50
X-Has-More: true
```

`Link` follows RFC 8288. Targets are path-relative (so they survive a proxy rewriting the host) and keep every non-positional query parameter, such as `webhookId` or `action`, from the original request. `rel="first"` appears on every page except the first; `rel="last"` appears only on offset-backed endpoints, because an id-anchored cursor cannot address the last page directly.

### Endpoints

| Endpoint | Cursor kind | Notes |
|---|---|---|
| `GET /credentials` | id-anchored (see above) | `has_more` follows `direction`; the `prev` link carries `direction=prev`. |
| `GET /webhooks/logs`, `GET /webhooks/{id}/logs` | offset | Newest first. |
| `GET /notifications/logs` | offset | Newest first (previously oldest-first within the returned tail). |
| `GET /admin/audit-logs` | offset | `limit` up to 500; `offset` still accepted, `cursor` wins if both are sent. |
| `GET /admin/expiry-report` | offset | `page`/`pageSize` still accepted; `cursor` selects the page when sent. |
| `GET /admin/api-keys` | offset | Now paginated: default 50, max 200 per page. |

Offset cursors are base64url `{"o": <offset>}`, but treat them as opaque like any other cursor. A malformed cursor falls back to the first page rather than erroring.

### Edge cases

- **Empty result**: `total_count: 0`, `has_more: false`, both cursors `null`, no `Link` header.
- **Exact multiple of the page size**: the last full page reports `has_more: false` and no `next_cursor`; there is never an empty trailing page.
- **Cursor past the end**: returns an empty page with `has_more: false` and a `previous_cursor` back into range.
- **Out-of-range `limit`**: clamped to the endpoint maximum; non-numeric or `< 1` falls back to the default.
