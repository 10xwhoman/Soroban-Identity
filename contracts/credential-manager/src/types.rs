use soroban_sdk::{contracttype, Address, Bytes, BytesN, Map, String, Vec};

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum CredentialType {
    Kyc,
    Reputation,
    Achievement,
    Custom,
}

/// Auto-renewal policy for a recurring credential. #869
///
/// When attached to a credential, the credential may be automatically
/// renewed on verification once it is within `renewal_period` seconds of
/// expiry. `renewal_period` is expressed in seconds and is expected to be
/// one of the supported periods (30/60/90 days).
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct RenewalPolicy {
    /// Whether auto-renewal is enabled for this credential.
    pub enabled: bool,
    /// Renewal window in seconds before `expires_at` (e.g. 30/60/90 days).
    pub renewal_period: u64,
    /// Number of times the credential has been auto-renewed so far.
    pub renewal_count: u32,
}

impl RenewalPolicy {
    /// 30 days in seconds.
    pub const PERIOD_30_DAYS: u64 = 30 * 24 * 60 * 60;
    /// 60 days in seconds.
    pub const PERIOD_60_DAYS: u64 = 60 * 24 * 60 * 60;
    /// 90 days in seconds.
    pub const PERIOD_90_DAYS: u64 = 90 * 24 * 60 * 60;

    /// Returns `true` when `period` is one of the supported renewal periods.
    pub fn is_supported_period(period: u64) -> bool {
        period == Self::PERIOD_30_DAYS
            || period == Self::PERIOD_60_DAYS
            || period == Self::PERIOD_90_DAYS
    }

    /// Returns `true` when the credential should be auto-renewed at `now`.
    ///
    /// Auto-renewal applies only when the policy is enabled, the credential
    /// has a finite expiry (`expires_at != 0`), and `now` has reached the
    /// renewal window (`expires_at - renewal_period`). Uses saturating
    /// arithmetic so arbitrary timestamps cannot panic or overflow. #869
    pub fn should_renew_at(&self, expires_at: u64, now: u64) -> bool {
        if !self.enabled || expires_at == 0 {
            return false;
        }
        let window_start = expires_at.saturating_sub(self.renewal_period);
        now >= window_start
    }
}

#[contracttype]
#[derive(Clone)]
pub struct Credential {
    pub id: BytesN<32>,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: CredentialType,
    pub claims: Map<String, String>,
    pub signature: Bytes,
    pub issued_at: u64,
    pub version: u32,
    pub last_modified_at: u64,
    /// Unix timestamp after which the credential becomes active.
    /// `0` means the credential is active immediately (no time-lock). #731
    pub activation_time: u64,
    pub expires_at: u64,
    pub revoked: bool,
    /// When `true` the pending activation has been cancelled by the issuer.
    /// A cancelled credential can never be activated and is treated as
    /// equivalent to revoked for all verification purposes. #731
    pub activation_cancelled: bool,
    /// Optional auto-renewal policy for recurring credentials. #869
    pub renewal_policy: Option<RenewalPolicy>,
}

/// Maximum number of prerequisite levels that may be traversed when verifying
/// a credential's dependency chain. #814
pub const MAX_DEPENDENCY_DEPTH: u32 = 5;

impl Credential {
    /// Returns `true` when the credential is currently active at `now`.
    ///
    /// A credential is active when it has not been revoked, its pending
    /// activation has not been cancelled, it has already reached its
    /// `activation_time` (or has no time-lock), and it has not yet expired.
    ///
    /// This is the single source of truth for the time-lock/expiry checks
    /// exercised by the `fuzz_issue_credential` target. It is written with
    /// saturating arithmetic and explicit ordering so that arbitrary fuzzer
    /// inputs (including `expires_at == 0`, `activation_time > expires_at`,
    /// and `u64::MAX` timestamps) can never panic or overflow. #781
    pub fn is_active_at(&self, now: u64) -> bool {
        if self.revoked || self.activation_cancelled {
            return false;
        }

        // `0` means "no time-lock": active immediately.
        if self.activation_time != 0 && now < self.activation_time {
            return false;
        }

        // `0` means "never expires".
        if self.expires_at != 0 && now >= self.expires_at {
            return false;
        }

        true
    }

    /// Returns `true` when this credential is due for auto-renewal at `now`.
    /// #869
    pub fn should_auto_renew_at(&self, now: u64) -> bool {
        match &self.renewal_policy {
            Some(policy) => policy.should_renew_at(self.expires_at, now),
            None => false,
        }
    }
}

/// Standardized reason a credential was revoked. Loosely follows the
/// X.509 CRL reason codes (RFC 5280 §5.3.1). Must stay in sync with the
/// `RevocationReason` exported by the contract in `lib.rs`. #951
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum RevocationReason {
    Unspecified = 0,
    KeyCompromise = 1,
    IssuerCompromise = 2,
    AffiliationChanged = 3,
    Superseded = 4,
    CessationOfOperation = 5,
    PrivilegeWithdrawn = 6,
    Fraudulent = 7,
    SubjectRequest = 8,
    DependencyRevoked = 9,
}

/// Revocation metadata persisted for each revoked credential. #951
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RevocationRecord {
    pub credential_id: BytesN<32>,
    pub reason: RevocationReason,
    pub revoked_by: Address,
    pub revoked_at: u64,
}
