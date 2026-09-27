#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Vec,
};

mod types;
pub use types::{RevocationReason, RevocationRecord};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const CRED: Symbol = symbol_short!("CRED");
const IDSEQ: Symbol = symbol_short!("IDSEQ");

// ── Data types ────────────────────────────────────────────────────────────────

/// Credential types supported by the protocol.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum CredentialType {
    Kyc,
    Reputation,
    Achievement,
    Custom,
}

/// A verifiable credential issued to a subject.
#[contracttype]
#[derive(Clone)]
pub struct Credential {
    /// Unique credential ID (hash)
    pub id: BytesN<32>,
    /// DID of the credential subject
    pub subject: Address,
    /// Address of the trusted issuer
    pub issuer: Address,
    /// Credential type
    pub credential_type: CredentialType,
    /// Arbitrary claims (key-value)
    pub claims: Map<String, String>,
    /// Issuer's signature over the credential hash
    pub signature: Bytes,
    /// Issuance timestamp
    pub issued_at: u64,
    /// Optional expiry (0 = no expiry)
    pub expires_at: u64,
    /// Whether this credential has been revoked
    pub revoked: bool,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct CredentialManager;

#[contractimpl]
impl CredentialManager {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
    }

    /// Register a trusted issuer (admin only).
    pub fn add_issuer(env: Env, issuer: Address) {
        Self::require_admin(&env);
        let mut issuers = Self::get_issuers(&env);
        if !issuers.contains(&issuer) {
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events().publish((ISSUER, symbol_short!("added")), issuer);
        }
    }

    /// Remove a trusted issuer (admin only).
    pub fn remove_issuer(env: Env, issuer: Address) {
        Self::require_admin(&env);
        let issuers = Self::get_issuers(&env);
        let mut updated = Vec::new(&env);
        for i in issuers.iter() {
            if i != issuer {
                updated.push_back(i);
            }
        }
        env.storage().instance().set(&ISSUER, &updated);
    }

    // ── Credential lifecycle ──────────────────────────────────────────────────

    /// Issue a credential to a subject. Caller must be a registered issuer.
    pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: CredentialType,
        claims: Map<String, String>,
        signature: Bytes,
        expires_at: u64,
    ) -> BytesN<32> {
        issuer.require_auth();
        Self::require_issuer(&env, &issuer);

        let now = env.ledger().timestamp();
        let id = Self::generate_id(&env, now);

        let credential = Credential {
            id: id.clone(),
            subject: subject.clone(),
            issuer: issuer.clone(),
            credential_type,
            claims,
            signature,
            issued_at: now,
            expires_at,
            revoked: false,
        };

        let key = Self::cred_key(&id);
        env.storage().persistent().set(&key, &credential);

        // Index credential under subject
        let mut subject_creds = Self::fetch_subject_creds(&env, &subject);
        subject_creds.push_back(id.clone());
        let subject_key = Self::subject_key(&subject);
        env.storage().persistent().set(&subject_key, &subject_creds);

        env.events().publish((CRED, symbol_short!("issued")), (issuer, subject));

        id
    }

    /// Revoke a credential. Only the original issuer can revoke.
    pub fn revoke_credential(
        env: Env,
        issuer: Address,
        credential_id: BytesN<32>,
        reason: RevocationReason,
    ) {
        issuer.require_auth();

        let key = Self::cred_key(&credential_id);
        let mut cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .expect("credential not found");

        if cred.issuer != issuer {
            panic!("only the issuer can revoke");
        }

        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);

        let record = RevocationRecord {
            credential_id: credential_id.clone(),
            issuer,
            reason,
            revoked_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&Self::revocation_key(&credential_id), &record);

        let reason_key = Self::reason_key(reason);
        let mut ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&reason_key)
            .unwrap_or_else(|| Vec::new(&env));
        ids.push_back(credential_id.clone());
        env.storage().persistent().set(&reason_key, &ids);

        env.events()
            .publish((CRED, symbol_short!("revoked")), (credential_id, reason));
    }

    /// Get the revocation record for a credential, if revoked.
    pub fn get_revocation(env: Env, credential_id: BytesN<32>) -> Option<RevocationRecord> {
        env.storage().persistent().get(&Self::revocation_key(&credential_id))
    }

    /// List credential IDs revoked for a given reason.
    pub fn get_revocations_by_reason(env: Env, reason: RevocationReason) -> Vec<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&Self::reason_key(reason))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Verify a credential is valid (not revoked, not expired).
    pub fn verify_credential(env: Env, credential_id: BytesN<32>) -> bool {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<(Symbol, BytesN<32>), Credential>(&key) {
            None => false,
            Some(cred) => {
                if cred.revoked {
                    return false;
                }
                if cred.expires_at > 0 && env.ledger().timestamp() > cred.expires_at {
                    return false;
                }
                true
            }
        }
    }

    /// Get a credential by ID.
    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Credential {
        let key = Self::cred_key(&credential_id);
        env.storage()
            .persistent()
            .get(&key)
            .expect("credential not found")
    }

    /// List all credential IDs for a subject.
    pub fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>> {
        Self::fetch_subject_creds(&env, &subject)
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();
    }

    fn require_issuer(env: &Env, issuer: &Address) {
        let issuers = Self::get_issuers(env);
        if !issuers.contains(issuer) {
            panic!("not a registered issuer");
        }
    }

    fn get_issuers(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&ISSUER)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn fetch_subject_creds(env: &Env, subject: &Address) -> Vec<BytesN<32>> {
        let key = Self::subject_key(subject);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Generate a unique 32-byte credential ID from the current timestamp and
    /// a per-contract sequence counter to prevent collisions within the same ledger.
    fn generate_id(env: &Env, timestamp: u64) -> BytesN<32> {
        let seq: u64 = env.storage().instance().get(&IDSEQ).unwrap_or(0);
        env.storage().instance().set(&IDSEQ, &(seq + 1));

        let mut data = Bytes::new(env);
        data.extend_from_array(&timestamp.to_be_bytes());
        data.extend_from_array(&seq.to_be_bytes());
        env.crypto().sha256(&data).into()
    }

    fn cred_key(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
        (CRED, id.clone())
    }

    fn revocation_key(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
        (symbol_short!("rvk"), id.clone())
    }

    fn reason_key(reason: RevocationReason) -> (Symbol, u32) {
        (symbol_short!("rvkrsn"), reason as u32)
    }

    fn subject_key(subject: &Address) -> (Symbol, Address) {
        (symbol_short!("sub"), subject.clone())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Bytes, Env, Map};

    fn setup() -> (Env, Address, CredentialManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

    /// issue_credential stores the credential and verify_credential returns true.
    #[test]
    fn test_issue_and_verify() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &claims,
            &sig,
            &0u64,
        );

        assert!(client.verify_credential(&cred_id));
    }

    /// revoke_credential marks the credential revoked; verify_credential returns false.
    #[test]
    fn test_revoke_credential() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        client.revoke_credential(&issuer, &cred_id, &RevocationReason::Compromised);
        assert!(!client.verify_credential(&cred_id));
    }

    /// issue_credential must panic when the caller is not a registered issuer.
    #[test]
    #[should_panic]
    fn test_issue_unauthorized_issuer() {
        let (env, _admin, client) = setup();

        let unauthorized = Address::generate(&env); // NOT registered
        let subject = Address::generate(&env);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        client.issue_credential(
            &unauthorized, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );
    }

    /// verify_credential returns false once the credential's expiry timestamp has passed.
    #[test]
    fn test_verify_expired_credential() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let expires_at = env.ledger().timestamp() + 100;

        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &expires_at,
        );

        // Valid before expiry
        assert!(client.verify_credential(&cred_id));

        // Advance ledger past expiry
        env.ledger().with_mut(|li| {
            li.timestamp = expires_at + 1;
        });

        // Must be invalid after expiry
        assert!(!client.verify_credential(&cred_id));
    }

    /// revoke_credential must panic when called by an address that did not issue the credential.
    #[test]
    #[should_panic]
    fn test_revoke_by_different_issuer() {
        let (env, _admin, client) = setup();

        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let subject = Address::generate(&env);

        client.add_issuer(&issuer1);
        client.add_issuer(&issuer2);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer1, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        // issuer2 attempts to revoke a credential they did not issue
        client.revoke_credential(&issuer2, &cred_id, &RevocationReason::Compromised);
    }

    /// get_credential returns all fields exactly as supplied at issuance.
    #[test]
    fn test_credential_stored_correctly() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let mut claims: Map<String, String> = Map::new(&env);
        claims.set(
            String::from_str(&env, "name"),
            String::from_str(&env, "Alice"),
        );
        let sig = Bytes::from_array(&env, &[1u8; 64]);
        let expires_at = 9999u64;

        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Achievement, &claims, &sig, &expires_at,
        );

        let cred = client.get_credential(&cred_id);
        assert_eq!(cred.issuer, issuer);
        assert_eq!(cred.subject, subject);
        assert_eq!(cred.credential_type, CredentialType::Achievement);
        assert_eq!(cred.expires_at, expires_at);
        assert!(!cred.revoked);
    }
}
