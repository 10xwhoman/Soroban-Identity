use soroban_sdk::{contracttype, Address, BytesN};

/// Standardized reasons for revoking a credential.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum RevocationReason {
    Unspecified = 0,
    Compromised = 1,
    Expired = 2,
    Superseded = 3,
    IssuerRevoked = 4,
    SubjectRequest = 5,
    PolicyViolation = 6,
}

/// Record stored when a credential is revoked.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RevocationRecord {
    pub credential_id: BytesN<32>,
    pub issuer: Address,
    pub reason: RevocationReason,
    pub revoked_at: u64,
}
