# Contract Event Schema

This document defines the normalized event payload served by `GET /events` in the server package.

## SSE message shape

Each `contract-event` message includes:

- `id` (string): unique event identifier for stream clients
- `type` (string): Soroban event type (`contract`)
- `contractId` (string): emitting contract address
- `topic` (string[]): normalized event topic segments
- `value` (unknown): decoded event payload
- `ledger` (number): ledger sequence that emitted the event
- `txHash` (string): transaction hash
- `timestamp` (string): server timestamp (ISO 8601)

## identity-registry events

| Topic | Payload |
| --- | --- |
| `IDENTITY,created` | `[controller: string, timestamp: number]` |
| `IDENTITY,updated` | `[controller: string, metadataHash: string]` |
| `IDENTITY,deact` | `[controller: string, timestamp: number]` |
| `admin,xfer` | `[oldAdmin: string, newAdmin: string]` |

## credential-manager events

| Topic | Payload |
| --- | --- |
| `CRED,issued` | `[id: string, subject: string, issuer: string, credentialType: string]` |
| `CRED,revoked` | `[id: string, issuer: string]` |
| `CRED,suspended` | `[id: string, issuer: string, reason: number, suspendedAt: number]` — credential temporarily suspended; see `SuspensionReason` |
| `CRED,unsuspend` | `[id: string, issuer: string, reactivatedAt: number]` — suspension lifted by `reactivate_credential` |
| `CRED,evicted` | `[issuer: string, evictedId: string]` — emitted when the per-issuer credential ring buffer (`MAX_ISSUER_CREDS`) is full and the oldest entry is dropped to make room for a new one |

### credential transfer events

Credential ownership transfers are a two-step, consent-based flow: the current
owner initiates a transfer to a recipient, and the recipient accepts or rejects
it. Off-chain consumers can index ownership changes by following the events
below in ledger order.

| Topic | Payload |
| --- | --- |
| `CRED,xfer_init` | `[id: string, from: string, to: string, initiatedAt: number, expiresAt: number]` — emitted by `initiate_transfer`; `expiresAt` is the ledger timestamp after which the pending transfer can no longer be accepted |
| `CRED,xfer_accept` | `[id: string, from: string, to: string, acceptedAt: number]` — emitted by `accept_transfer`; ownership of `id` moves from `from` to `to` |
| `CRED,xfer_reject` | `[id: string, from: string, to: string, rejectedAt: number]` — emitted by `reject_transfer`; the pending transfer is cancelled and ownership remains with `from` |
| `CRED,xfer_done` | `[id: string, from: string, to: string, completedAt: number, fee: number]` — emitted once the transfer is finalized and any transfer fee has been settled; `fee` is the amount charged for the transfer (0 when the credential type is fee-exempt) |

Notes for indexers:

- A transfer is only `completed` after a matching `xfer_accept`; `xfer_init`
  alone does not change ownership.
- `xfer_reject` and expiry both leave ownership unchanged, so consumers should
  treat only `xfer_accept`/`xfer_done` as ownership-changing events.
- Transfer restrictions are enforced per credential type: credentials whose
  type disallows transfers never emit `xfer_init`, and the call reverts instead.
- The `from`/`to` fields are always the addresses recorded at initiation time;
  they are not re-resolved at acceptance.

## reputation events

| Topic | Payload |
| --- | --- |
| `SCORE,updated` | `[subject: string, reporter: string, delta: number, score: number]` |

> The payload arrays are decoded from contract event values and reflect the contract tuple order.
