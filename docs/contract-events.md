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

## reputation events

| Topic | Payload |
| --- | --- |
| `SCORE,updated` | `[subject: string, reporter: string, delta: number, score: number]` |

## credential-escrow events

Escrow lifecycle events are emitted by the credential escrow contract. Indexers can
track escrow state transitions by following the `ESCROW` topic prefix; clients can
subscribe to a specific escrow by filtering on the escrow `id` in the payload.

| Topic | Payload |
| --- | --- |
| `ESCROW,created` | `[id: string, depositor: string, beneficiary: string, amount: number, condition: number, deadline: number]` — escrow funded and awaiting condition verification; `condition` is a `ConditionType` discriminant |
| `ESCROW,released` | `[id: string, beneficiary: string, amount: number, releasedAt: number]` — all release conditions verified and funds transferred to the beneficiary |
| `ESCROW,refunded` | `[id: string, depositor: string, amount: number, refundedAt: number]` — conditions failed or expired and funds returned to the depositor |
| `ESCROW,disputed` | `[id: string, challenger: string, reason: number, disputedAt: number]` — a party opened a dispute, freezing release until resolution; `reason` is a `DisputeReason` discriminant |
| `ESCROW,resolved` | `[id: string, resolver: string, outcome: number, resolvedAt: number]` — dispute resolved by the arbiter; `outcome` is a `DisputeOutcome` discriminant (`0` = release, `1` = refund) |
| `ESCROW,cancelled` | `[id: string, depositor: string, cancelledAt: number]` — escrow cancelled before any condition was met |

### Escrow status queries

The current escrow state is not carried in events; clients should query it via
`get_escrow(id)` which returns the escrow record including its `EscrowStatus`
(`Pending`, `Released`, `Refunded`, `Disputed`, `Resolved`, or `Cancelled`).

> The payload arrays are decoded from contract event values and reflect the contract tuple order.
