# Analytics dashboard

Tracks network activity from the IdentityRegistry and CredentialManager contracts.

```bash
cd analytics && npm install
IDENTITY_REGISTRY_ID=C... CREDENTIAL_MANAGER_ID=C... npm start   # http://localhost:4000
```

| Metric | Source |
|---|---|
| Total DIDs over time | `created` contract events |
| Credential issuance rate | `issued` / `revoked` events |
| Top issuers | issuer field of `issued` events |
| Verification frequency | `POST /api/track/verification` (verification is read-only, so no on-chain event) |
| Geographic distribution | `country` in event payload / tracking body / `CF-IPCountry` header |

Real-time updates stream over Server-Sent Events (`/api/stream`). Reports: `/api/export.csv`, `/api/export.pdf`.

Env: `SOROBAN_RPC_URL`, `IDENTITY_REGISTRY_ID`, `CREDENTIAL_MANAGER_ID`, `START_LEDGER`, `PORT`.
