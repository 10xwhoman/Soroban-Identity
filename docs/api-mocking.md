# API Mocking for Client Development

The server provides deterministic API fixtures for frontend work and integration testing when the chain or supporting services are unavailable. The mock routes do not access Soroban and never persist credential writes.

## Enable locally

Set `MOCK_API_ENABLED=true` when starting the server:

```bash
cd server
MOCK_API_ENABLED=true npm start
```

The feature is **disabled by default** and is forcibly disabled when `NODE_ENV=production`, even if `MOCK_API_ENABLED=true` is present. Responses include `mock: true` where applicable and `Cache-Control: no-store` so test data is not cached.

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/mock/v1/health` | Mock service health |
| `GET` | `/mock/v1/info` | Endpoint index |
| `GET` | `/mock/v1/credentials` | Deterministic example credential list |
| `GET` | `/mock/v1/credentials/:id` | Fetch the example credential or return a mock 404 |
| `POST` | `/mock/v1/credentials` | Return a mock issued credential without storing it |
| `GET` | `/mock/v1/dids/:address` | Return a minimal DID document fixture |
| `GET` | `/mock/v1/reputation/:address` | Return a fixed reputation fixture |

The mock routes have a dedicated `/mock/v1` prefix and are not aliases for real API routes. Invalid methods and unknown paths return JSON errors. `POST /mock/v1/credentials` requires `Content-Type: application/json` and obeys the server request-body size limit.

## Example

```bash
curl http://localhost:3001/mock/v1/credentials
curl -X POST http://localhost:3001/mock/v1/credentials \
  -H 'Content-Type: application/json' \
  -d '{"subject":"GMOCKSUBJECT","credentialType":"Kyc"}'
```
