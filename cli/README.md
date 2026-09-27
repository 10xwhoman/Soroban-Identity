# @soroban-identity/cli

Terminal tool for managing Soroban Identity DIDs and credentials.

## Install
```bash
npm install -g @soroban-identity/cli
```

## Configuration
Settings are merged in this order (later wins): network defaults → env vars → config file.

`~/.soroban-id.json` (or `--config <file>`):
```json
{
  "network": "testnet",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "identityRegistryId": "C...",
  "credentialManagerId": "C..."
}
```
Env vars: `SOROBAN_RPC_URL`, `IDENTITY_REGISTRY_ID`, `CREDENTIAL_MANAGER_ID`, `SOROBAN_SECRET_KEY`.

## Commands
| Command | Description |
|---|---|
| `soroban-id create-did [-s key] [-m json]` | Register a DID |
| `soroban-id issue-credential --subject G... --type T --claims '{...}' [--expires ts]` | Issue a credential |
| `soroban-id verify <credentialId> --caller G...` | Verify a credential |
| `soroban-id revoke <credentialId> [-s key]` | Revoke a credential |

Any missing required value is prompted interactively (secret input is hidden). In non-TTY mode missing values are an error.

## Scripting
Add `--json` for JSON output on stdout; errors are emitted as `{"error": "..."}` on stderr with exit code 1.
```bash
soroban-id --json verify abc123 --caller GABC... | jq .valid
```

## Publishing
```bash
cd cli && npm publish --access public
```
