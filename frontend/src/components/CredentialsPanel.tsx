import { useState } from "react";
import type { CredentialType, RevocationReason } from "../../../sdk/src/types";
import { REVOCATION_REASONS } from "../../../sdk/src/types";
import { exportCredentials, type ExportFormat } from "../export";
import type { WalletState } from "../hooks/useWallet";

interface Props {
  wallet: WalletState & {
    connect: () => void;
    signTransaction: (xdr: string) => Promise<string>;
  };
}

type VerifyState =
  | "idle"
  | "valid"
  | "not_found"
  | "revoked"
  | "expired"
  | "invalid";

type FilterType = "All" | CredentialType;

// Mock credentials for demonstration — replace with SDK data when wired
const MOCK_CREDENTIALS = [
  { id: "abc001", credentialType: "Kyc" as CredentialType, subject: "GABC…" },
  { id: "abc002", credentialType: "Kyc" as CredentialType, subject: "GABC…" },
  { id: "abc003", credentialType: "Reputation" as CredentialType, subject: "GABC…" },
  { id: "abc004", credentialType: "Achievement" as CredentialType, subject: "GABC…" },
  { id: "abc005", credentialType: "Custom" as CredentialType, subject: "GABC…" },
];

const FILTER_OPTIONS: FilterType[] = ["All", "Kyc", "Reputation", "Achievement", "Custom"];

function countByType(type: FilterType): number {
  if (type === "All") return MOCK_CREDENTIALS.length;
  return MOCK_CREDENTIALS.filter((c) => c.credentialType === type).length;
}

export default function CredentialsPanel({ wallet }: Props) {
  const [credId, setCredId] = useState("");
  const [verifyState, setVerifyState] = useState<VerifyState>("idle");
  const [verifying, setVerifying] = useState(false);

  const [subject, setSubject] = useState("");
  const [issueResult, setIssueResult] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);

  const [activeFilter, setActiveFilter] = useState<FilterType>("All");

  const [revokeId, setRevokeId] = useState("");
  const [revokeReason, setRevokeReason] = useState<RevocationReason>("Compromised");
  const [revokeResult, setRevokeResult] = useState<string | null>(null);

  const filteredCredentials =
    activeFilter === "All"
      ? MOCK_CREDENTIALS
      : MOCK_CREDENTIALS.filter((c) => c.credentialType === activeFilter);

  const handleVerify = async () => {
    if (!credId.trim()) return;
    setVerifying(true);
    setVerifyState("idle");
    try {
      // TODO: wire CredentialClient.verifyCredential() from SDK
      await new Promise((r) => setTimeout(r, 800));
      const mockResult = credId.startsWith("0")
        ? { valid: false as const, reason: "revoked" as const }
        : { valid: true as const };
      if (mockResult.valid) {
        setVerifyState("valid");
      } else {
        setVerifyState(mockResult.reason);
      }
    } catch {
      setVerifyState("invalid");
    } finally {
      setVerifying(false);
    }
  };

  const handleIssue = async () => {
    if (!wallet.connected || !subject.trim()) return;
    setIssuing(true);
    setIssueResult(null);
    try {
      // TODO: build tx via CredentialClient, sign via wallet.signTransaction(), submit
      await new Promise((r) => setTimeout(r, 1000));
      const mockId = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      setIssueResult(`Credential issued.\nID: ${mockId}`);
    } catch (e: unknown) {
      setIssueResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIssuing(false);
    }
  };

  const handleRevoke = async () => {
    if (!wallet.connected || !revokeId.trim()) return;
    // TODO: build tx via CredentialClient.revokeCredential(), sign via wallet.signTransaction(), submit
    setRevokeResult(`Credential ${revokeId} revoked (reason: ${revokeReason}).`);
  };

  const handleExport = (format: ExportFormat) =>
    exportCredentials(filteredCredentials, format).catch((e) =>
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    );

  return (
    <>
      {/* Filter bar */}
      <div className="card">
        <h2>Credentials</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {FILTER_OPTIONS.map((type) => {
            const count = countByType(type);
            const isActive = activeFilter === type;
            return (
              <button
                key={type}
                onClick={() => setActiveFilter(type)}
                style={{
                  padding: "0.3rem 0.75rem",
                  borderRadius: "999px",
                  border: isActive ? "2px solid var(--accent-light)" : "2px solid var(--border-input)",
                  background: isActive ? "var(--card-bg-accent)" : "transparent",
                  color: isActive ? "var(--accent-light)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  fontWeight: isActive ? 600 : 400,
                }}
                aria-pressed={isActive}
              >
                {type}{" "}
                <span
                  style={{
                    background: isActive ? "var(--filter-badge-active-bg)" : "var(--border-input)",
                    color: isActive ? "var(--filter-badge-active-text)" : "var(--text-muted)",
                    borderRadius: "999px",
                    padding: "0 0.4rem",
                    fontSize: "0.75rem",
                    marginLeft: "0.25rem",
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {filteredCredentials.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            No {activeFilter} credentials found.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {filteredCredentials.map((cred) => (
              <li
                key={cred.id}
                style={{
                  background: "var(--cred-item-bg)",
                  borderRadius: "0.5rem",
                  padding: "0.6rem 1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "0.85rem",
                  color: "var(--text)",
                }}
              >
                <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>{cred.id}</span>
                <span className="badge badge-green">{cred.credentialType}</span>
              </li>
            ))}
          </ul>
        )}
        {filteredCredentials.length > 0 && (
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            {(["pdf", "json", "xml"] as ExportFormat[]).map((f) => (
              <button key={f} onClick={() => handleExport(f)}>
                Export {f.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Verify Credential</h2>
        <input
          placeholder="Credential ID (hex)"
          value={credId}
          onChange={(e) => setCredId(e.target.value)}
        />
        <button onClick={handleVerify} disabled={verifying || !credId}>
          {verifying ? "Verifying…" : "Verify"}
        </button>
        {verifyState !== "idle" && (
          <div style={{ marginTop: "1rem" }}>
            {verifyState === "valid" && (
              <span className="badge badge-green">Valid</span>
            )}
            {verifyState === "revoked" && (
              <span className="badge badge-red">Invalid — credential has been revoked</span>
            )}
            {verifyState === "expired" && (
              <span className="badge badge-red">Invalid — credential has expired</span>
            )}
            {verifyState === "not_found" && (
              <span className="badge badge-red">Invalid — credential not found</span>
            )}
            {(verifyState === "invalid" || verifyState === "unknown" as string) && (
              <span className="badge badge-red">Invalid</span>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Issue Credential</h2>
        {wallet.connected ? (
          <>
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "1rem" }}>
              Issuing as{" "}
              <span style={{ color: "var(--accent-light)" }}>
                {wallet.publicKey?.slice(0, 6)}…{wallet.publicKey?.slice(-4)}
              </span>
            </p>
            <input
              placeholder="Subject address (G…)"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
            <button onClick={handleIssue} disabled={issuing || !subject}>
              {issuing ? "Issuing…" : "Issue KYC Credential"}
            </button>
          </>
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            Connect your Freighter wallet to issue credentials as a registered issuer.
          </p>
        )}
        {issueResult && <pre className="result">{issueResult}</pre>}
      </div>

      <div className="card">
        <h2>Revoke Credential</h2>
        {wallet.connected ? (
          <>
            <input
              placeholder="Credential ID (hex)"
              value={revokeId}
              onChange={(e) => setRevokeId(e.target.value)}
            />
            <select
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value as RevocationReason)}
            >
              {REVOCATION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button onClick={handleRevoke} disabled={!revokeId}>
              Revoke
            </button>
          </>
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            Connect your wallet to revoke credentials you issued.
          </p>
        )}
        {revokeResult && <pre className="result">{revokeResult}</pre>}
      </div>
    </>
  );
}
