import { jsPDF } from "jspdf";
import QRCode from "qrcode";

export type ExportFormat = "json" | "xml" | "pdf";

export interface ExportableCredential {
  id: string;
  credentialType: string;
  subject: string;
  issuer?: string;
  claims?: Record<string, string>;
  issuedAt?: number;
  expiresAt?: number;
  revoked?: boolean;
  [key: string]: unknown;
}

/** Custom template: controls which fields are exported and their labels. */
export interface ExportTemplate {
  name: string;
  fields: { key: keyof ExportableCredential & string; label: string }[];
  title?: string;
}

export const DEFAULT_TEMPLATE: ExportTemplate = {
  name: "default",
  title: "Verifiable Credential",
  fields: [
    { key: "id", label: "Credential ID" },
    { key: "credentialType", label: "Type" },
    { key: "subject", label: "Subject" },
    { key: "issuer", label: "Issuer" },
    { key: "issuedAt", label: "Issued At" },
    { key: "expiresAt", label: "Expires At" },
    { key: "revoked", label: "Revoked" },
  ],
};

const fmt = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** JSON export with full metadata. */
export function toJson(creds: ExportableCredential[]): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), count: creds.length, credentials: creds },
    null,
    2
  );
}

/** XML export for enterprise integrations. */
export function toXml(creds: ExportableCredential[]): string {
  const item = (c: ExportableCredential) => {
    const fields = Object.entries(c)
      .filter(([k]) => k !== "claims")
      .map(([k, v]) => `    <${k}>${escapeXml(fmt(v))}</${k}>`)
      .join("\n");
    const claims = Object.entries(c.claims ?? {})
      .map(([k, v]) => `      <claim key="${escapeXml(k)}">${escapeXml(v)}</claim>`)
      .join("\n");
    return `  <credential>\n${fields}\n    <claims>${claims ? `\n${claims}\n    ` : ""}</claims>\n  </credential>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<credentials exportedAt="${new Date().toISOString()}">\n${creds
    .map(item)
    .join("\n")}\n</credentials>\n`;
}

/** PDF export: one page per credential, with a QR code of the credential ID. */
export async function toPdf(
  creds: ExportableCredential[],
  template: ExportTemplate = DEFAULT_TEMPLATE
): Promise<Blob> {
  const doc = new jsPDF();
  for (const [i, c] of creds.entries()) {
    if (i > 0) doc.addPage();
    doc.setFontSize(18);
    doc.text(template.title ?? "Credential", 15, 20);
    doc.setFontSize(10);
    let y = 35;
    for (const f of template.fields) {
      doc.text(`${f.label}: ${fmt(c[f.key])}`, 15, y, { maxWidth: 120 });
      y += 10;
    }
    for (const [k, v] of Object.entries(c.claims ?? {})) {
      doc.text(`${k}: ${v}`, 15, y, { maxWidth: 120 });
      y += 8;
    }
    const qr = await QRCode.toDataURL(JSON.stringify({ id: c.id, subject: c.subject }));
    doc.addImage(qr, "PNG", 145, 30, 50, 50);
  }
  return doc.output("blob");
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export one or many credentials (batch) in the given format and trigger a download. */
export async function exportCredentials(
  creds: ExportableCredential[],
  format: ExportFormat,
  template: ExportTemplate = DEFAULT_TEMPLATE
): Promise<void> {
  const base = creds.length === 1 ? `credential-${creds[0].id}` : `credentials-${Date.now()}`;
  if (format === "json") {
    download(new Blob([toJson(creds)], { type: "application/json" }), `${base}.json`);
  } else if (format === "xml") {
    download(new Blob([toXml(creds)], { type: "application/xml" }), `${base}.xml`);
  } else {
    download(await toPdf(creds, template), `${base}.pdf`);
  }
}
