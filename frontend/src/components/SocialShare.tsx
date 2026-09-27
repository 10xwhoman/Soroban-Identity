import React, { useEffect, useMemo, useState } from 'react';
import type { Credential } from '../../../sdk/src/types';
import { useToast } from '../context/ToastContext';
import {
  SHARE_DESCRIPTION,
  SHARE_TITLE,
  buildPlatformUrl,
  buildShareText,
  buildVerificationUrl,
  canUseNativeShare,
  getSocialShareStats,
  loadPrivacyOptions,
  savePrivacyOptions,
  trackSocialShare,
  type SharePrivacyOptions,
  type SocialPlatform,
} from '../utils/socialShare';

interface SocialShareProps {
  credential: Pick<Credential, 'id' | 'credentialType' | 'issuer' | 'revoked' | 'expiresAt'>;
}

const PLATFORMS: { id: 'twitter' | 'linkedin' | 'whatsapp'; label: string; color: string }[] = [
  { id: 'twitter', label: 'X / Twitter', color: '#000000' },
  { id: 'linkedin', label: 'LinkedIn', color: '#0a66c2' },
  { id: 'whatsapp', label: 'WhatsApp', color: '#25d366' },
];

const buttonStyle = (color: string, disabled: boolean): React.CSSProperties => ({
  flex: '1 1 8rem',
  padding: '0.55rem 0.75rem',
  borderRadius: '0.375rem',
  border: 'none',
  background: color,
  color: '#ffffff',
  fontWeight: 500,
  fontSize: '0.85rem',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

/**
 * Share a public verification link for a credential on social platforms.
 *
 * Only the credential ID leaves the device. Claims are never included. The
 * user chooses what the share text reveals and must acknowledge that the link
 * is public before any share button is enabled.
 */
export const SocialShare: React.FC<SocialShareProps> = ({ credential }) => {
  const toast = useToast();
  const [privacy, setPrivacy] = useState<SharePrivacyOptions>(loadPrivacyOptions);
  const [acknowledged, setAcknowledged] = useState(false);
  const [stats, setStats] = useState(getSocialShareStats);

  useEffect(() => savePrivacyOptions(privacy), [privacy]);

  const expired = credential.expiresAt > 0 && credential.expiresAt * 1000 < Date.now();
  const shareable = !credential.revoked && !expired;
  const disabled = !shareable || !acknowledged;

  const previewUrl = useMemo(() => buildVerificationUrl(credential.id), [credential.id]);
  const text = buildShareText(credential, privacy);

  const record = (platform: SocialPlatform) => {
    trackSocialShare(platform, credential, privacy);
    setStats(getSocialShareStats());
  };

  const shareTo = (platform: 'twitter' | 'linkedin' | 'whatsapp') => {
    if (disabled) return;
    const url = buildVerificationUrl(credential.id, platform);
    window.open(buildPlatformUrl(platform, url, text), '_blank', 'noopener,noreferrer,width=600,height=600');
    record(platform);
  };

  const shareNative = async () => {
    if (disabled) return;
    try {
      await navigator.share({ title: SHARE_TITLE, text, url: buildVerificationUrl(credential.id, 'native') });
      record('native');
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') toast.error('Sharing failed.');
    }
  };

  const copyLink = async () => {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(buildVerificationUrl(credential.id, 'copy'));
      record('copy');
      toast.success('Verification link copied!');
    } catch {
      toast.error('Failed to copy to clipboard.');
    }
  };

  const toggle = (key: keyof SharePrivacyOptions) => setPrivacy((p) => ({ ...p, [key]: !p[key] }));
  const totalShares = Object.values(stats).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <section aria-labelledby="social-share-title" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: '1.25rem' }}>
      <h4 id="social-share-title" style={{ margin: '0 0 0.35rem', fontSize: '1rem', fontWeight: 600 }}>
        Share a public verification link
      </h4>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted, #64748b)', margin: '0 0 1rem' }}>
        Anyone with this link can check on-chain that the credential is valid. Claims are never included.
      </p>

      {!shareable && (
        <p role="alert" style={{ fontSize: '0.85rem', color: 'var(--danger, #dc2626)', margin: '0 0 1rem' }}>
          This credential is {credential.revoked ? 'revoked' : 'expired'} and can't be shared publicly.
        </p>
      )}

      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 1rem', fontSize: '0.85rem' }}>
        <legend style={{ fontWeight: 500, marginBottom: '0.35rem' }}>Privacy</legend>
        <label style={{ display: 'block', marginBottom: '0.25rem' }}>
          <input type="checkbox" checked={privacy.includeType} onChange={() => toggle('includeType')} /> Mention the credential type
        </label>
        <label style={{ display: 'block', marginBottom: '0.25rem' }}>
          <input type="checkbox" checked={privacy.includeIssuer} onChange={() => toggle('includeIssuer')} /> Mention the issuer address
        </label>
        <label style={{ display: 'block', marginBottom: '0.25rem' }}>
          <input type="checkbox" checked={privacy.includeIdInAnalytics} onChange={() => toggle('includeIdInAnalytics')} /> Include
          the credential ID in local share analytics
        </label>
        <label style={{ display: 'block', marginTop: '0.5rem', fontWeight: 500 }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={() => setAcknowledged((a) => !a)}
            disabled={!shareable}
          />{' '}
          I understand this link is public and reveals the credential ID
        </label>
      </fieldset>

      <div aria-label="Link preview" style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: '0.5rem', overflow: 'hidden', marginBottom: '1rem' }}>
        <div
          aria-hidden="true"
          style={{
            height: '4.5rem',
            background: 'linear-gradient(135deg, #0f172a 0%, #2563eb 100%)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            padding: '0 1rem',
            fontWeight: 600,
          }}
        >
          ✓ Soroban Identity
        </div>
        <div style={{ padding: '0.6rem 0.75rem', background: 'var(--bg-accent, #f8fafc)' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted, #64748b)', textTransform: 'uppercase' }}>
            {new URL(previewUrl).host}
          </div>
          <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{SHARE_TITLE}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted, #64748b)' }}>{SHARE_DESCRIPTION}</div>
        </div>
        <div style={{ padding: '0.6rem 0.75rem', fontSize: '0.8rem', borderTop: '1px solid var(--border, #e2e8f0)' }}>
          <span style={{ color: 'var(--text-muted, #64748b)' }}>Message: </span>
          {text}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => shareTo(p.id)}
            disabled={disabled}
            aria-label={`Share verification link on ${p.label}`}
            style={buttonStyle(p.color, disabled)}
          >
            {p.label}
          </button>
        ))}
        {canUseNativeShare() && (
          <button type="button" onClick={() => void shareNative()} disabled={disabled} style={buttonStyle('#475569', disabled)}>
            More…
          </button>
        )}
        <button type="button" onClick={() => void copyLink()} disabled={disabled} style={buttonStyle('#64748b', disabled)}>
          Copy link
        </button>
      </div>

      {totalShares > 0 && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)', margin: '0.75rem 0 0' }}>
          Shared {totalShares} time{totalShares === 1 ? '' : 's'} from this device
          {' ('}
          {Object.entries(stats)
            .map(([platform, n]) => `${platform}: ${n}`)
            .join(', ')}
          {')'}
        </p>
      )}
    </section>
  );
};

export default SocialShare;
