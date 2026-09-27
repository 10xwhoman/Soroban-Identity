# CDN for static assets

Static frontend assets (JS/CSS bundles, fonts, images) are served from a
Cloudflare R2 bucket behind the Cloudflare CDN.

## Setup
1. Create an R2 bucket and connect a custom domain (e.g. `cdn.soroban-identity.xyz`) — this enables Cloudflare's CDN in front of it.
2. Add a Cache Rule for `/assets/*`: *Eligible for cache*, Edge TTL = respect origin.
3. Set repo secrets: `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CDN_BASE_URL`, `CF_ZONE_ID`, `CF_API_TOKEN` (Zone.Cache Purge permission).

## Pipeline
`deploy.sh` (run by `.github/workflows/frontend-cdn.yml` on pushes to `main` touching `frontend/`):
- builds with `CDN_BASE_URL` as Vite `base`, so asset URLs point at the CDN;
- uploads `assets/*` with `max-age=31536000, immutable` (filenames are content-hashed);
- uploads `index.html` and other entry files with `max-age=0, must-revalidate`;
- purges the Cloudflare cache for the entry points (cache invalidation on deploy).

`_headers` documents the same policy for Cloudflare Pages, if used instead of R2.

## Testing & measuring
`check-regions.sh <cdn-url> [origin-url]` prints `cf-cache-status`, `cf-ray` (edge location) and total load time. Run it from runners in several regions and compare with the origin URL; a `HIT` status and lower `time_total` confirm the improvement. Lighthouse / WebPageTest runs before and after enabling the CDN give the end-user numbers.
