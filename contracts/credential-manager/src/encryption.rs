//! Issue #947 (SC-21): encrypted credential claims with selective disclosure.
//!
//! On-chain storage is public, so this contract never sees plaintext or
//! symmetric keys. Encryption happens off-chain; the contract stores the
//! ciphertext and wrapped keys, enforces who may fetch them, and verifies
//! salted commitments when a holder discloses individual fields.
//!
//! Encryption standards (see `docs/credential-claim-encryption.md`):
//!
//! * Field encryption — `XChaCha20-Poly1305` AEAD with a random 32-byte data
//!   encryption key (DEK) per credential and a random 24-byte nonce per
//!   field. The field name is used as associated data.
//! * Key wrapping — ECIES over `X25519`: an ephemeral X25519 key agrees with
//!   the recipient's registered public key, `HKDF-SHA256` derives a
//!   wrapping key, and `XChaCha20-Poly1305` seals the DEK (32-byte DEK +
//!   16-byte tag = 48 bytes).
//! * Field commitments — `SHA-256(salt || u32_be(len(name)) || name || value)`
//!   with a random 32-byte salt per field. Commitments let a holder disclose a
//!   single field's plaintext and have it verified on-chain without revealing
//!   the rest of the credential.

use soroban_sdk::{
    contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Map, String, Symbol,
    Vec,
};

use crate::{ContractError, Credential, CredentialManager, CredentialManagerClient};

/// Per-owner registered encryption public key.
const ENC_KEY: Symbol = symbol_short!("ENCKEY");
/// Per-credential encryption metadata.
const ENC_META: Symbol = symbol_short!("ENCMETA");
/// Per-credential encrypted field map.
const ENC_FIELDS: Symbol = symbol_short!("ENCFLDS");
/// Per-(credential, reader) access grant carrying a wrapped DEK.
const ENC_GRANT: Symbol = symbol_short!("ENCGRNT");
/// Per-credential list of readers holding a grant.
const ENC_READERS: Symbol = symbol_short!("ENCRDRS");
const ENC_EVENT: Symbol = symbol_short!("ENC");

/// `X25519` key agreement (the only supported key algorithm).
pub const KEY_ALG_X25519: u32 = 0;
/// `XChaCha20-Poly1305` field encryption with ECIES/X25519 key wrapping.
pub const ENC_SCHEME_XCHACHA20_X25519: u32 = 0;

pub const MAX_ENCRYPTED_FIELDS: u32 = 32;
pub const MAX_FIELD_NAME_LEN: u32 = 64;
pub const MAX_FIELD_CIPHERTEXT_LEN: u32 = 4096;
pub const MAX_READERS_PER_CREDENTIAL: u32 = 50;
/// AEAD authentication tag length (Poly1305).
const AEAD_TAG_LEN: u32 = 16;
/// Wrapped DEK length: 32-byte key + 16-byte tag.
const WRAPPED_DEK_LEN: u32 = 32 + AEAD_TAG_LEN;

// ── Types ────────────────────────────────────────────────────────────────────

/// A registered encryption public key. Rotation bumps `version`; ciphertext
/// always records the key version it was wrapped for.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EncryptionKey {
    pub public_key: BytesN<32>,
    pub algorithm: u32,
    pub version: u32,
    pub registered_at: u64,
    pub revoked: bool,
}

/// One encrypted claim field.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EncryptedField {
    pub ciphertext: Bytes,
    pub nonce: BytesN<24>,
    /// Salted SHA-256 commitment to the plaintext (see module docs).
    pub commitment: BytesN<32>,
}

/// A credential DEK sealed to one recipient's X25519 public key.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WrappedKey {
    pub ephemeral_public_key: BytesN<32>,
    pub nonce: BytesN<24>,
    pub ciphertext: Bytes,
    /// Version of the recipient key this DEK was wrapped for.
    pub recipient_key_version: u32,
}

/// Encryption metadata attached to a credential.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EncryptionMetadata {
    pub scheme: u32,
    pub key_algorithm: u32,
    pub encrypted_fields: Vec<String>,
    pub encrypted_by: Address,
    pub encrypted_at: u64,
    /// Subject key version the DEK was first wrapped for.
    pub subject_key_version: u32,
}

/// Access grant allowing `reader` to fetch (a subset of) encrypted fields.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AccessGrant {
    pub wrapped_key: WrappedKey,
    /// Fields the reader may fetch. Empty means all encrypted fields.
    pub fields: Vec<String>,
    pub granted_by: Address,
    pub granted_at: u64,
    /// `0` means the grant never expires.
    pub expires_at: u64,
}

/// What an authorised reader gets back: the fields it may see plus its
/// wrapped DEK, from which it decrypts off-chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EncryptedClaimsView {
    pub fields: Map<String, EncryptedField>,
    pub wrapped_key: WrappedKey,
    pub metadata: EncryptionMetadata,
}

/// A holder-revealed plaintext for one field.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimDisclosure {
    pub field: String,
    pub value: Bytes,
    pub salt: BytesN<32>,
}

// ── Contract functions ────────────────────────────────────────────────────────

#[contractimpl]
impl CredentialManager {
    /// Register or rotate `owner`'s encryption public key. Returns the new
    /// key version (starts at 1).
    pub fn register_encryption_key(
        env: Env,
        owner: Address,
        public_key: BytesN<32>,
        algorithm: u32,
    ) -> Result<u32, ContractError> {
        owner.require_auth();
        if algorithm != KEY_ALG_X25519 {
            return Err(ContractError::UnsupportedEncryptionScheme);
        }
        if public_key == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(ContractError::InvalidEncryptionKey);
        }
        let key = (ENC_KEY, owner.clone());
        let version = env
            .storage()
            .persistent()
            .get::<_, EncryptionKey>(&key)
            .map(|k| k.version + 1)
            .unwrap_or(1);
        let record = EncryptionKey {
            public_key: public_key.clone(),
            algorithm,
            version,
            registered_at: env.ledger().timestamp(),
            revoked: false,
        };
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, crate::TTL_MAX, crate::TTL_MAX);
        env.events().publish(
            (ENC_EVENT, symbol_short!("key_reg")),
            (crate::EVENT_VERSION, owner, version, public_key),
        );
        Ok(version)
    }

    /// Mark `owner`'s current key as revoked. New wraps to it are rejected
    /// until a fresh key is registered.
    pub fn revoke_encryption_key(env: Env, owner: Address) -> Result<(), ContractError> {
        owner.require_auth();
        let key = (ENC_KEY, owner.clone());
        let mut record: EncryptionKey = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::EncryptionKeyNotFound)?;
        record.revoked = true;
        env.storage().persistent().set(&key, &record);
        env.events().publish(
            (ENC_EVENT, symbol_short!("key_rev")),
            (crate::EVENT_VERSION, owner, record.version),
        );
        Ok(())
    }

    pub fn get_encryption_key(env: Env, owner: Address) -> Result<EncryptionKey, ContractError> {
        env.storage()
            .persistent()
            .get(&(ENC_KEY, owner))
            .ok_or(ContractError::EncryptionKeyNotFound)
    }

    /// Attach encrypted sensitive fields to an issued credential. Only the
    /// credential's issuer may call this, once. The subject is granted
    /// access to every field via `subject_key`.
    ///
    /// Sensitive fields must not also appear in the credential's plaintext
    /// `claims` map.
    pub fn attach_encrypted_claims(
        env: Env,
        issuer: Address,
        credential_id: BytesN<32>,
        fields: Map<String, EncryptedField>,
        subject_key: WrappedKey,
    ) -> Result<(), ContractError> {
        issuer.require_auth();
        Self::require_not_paused(&env)?;
        let cred = Self::load_live_credential(&env, &credential_id)?;
        if cred.issuer != issuer {
            return Err(ContractError::Unauthorized);
        }
        let meta_key = (ENC_META, credential_id.clone());
        if env.storage().persistent().has(&meta_key) {
            return Err(ContractError::EncryptedClaimsAlreadyAttached);
        }
        if fields.is_empty() || fields.len() > MAX_ENCRYPTED_FIELDS {
            return Err(ContractError::TooManyEncryptedFields);
        }

        let mut names: Vec<String> = Vec::new(&env);
        for (name, field) in fields.iter() {
            if name.len() == 0 || name.len() > MAX_FIELD_NAME_LEN {
                return Err(ContractError::InvalidEncryptedField);
            }
            if cred.claims.contains_key(name.clone()) {
                return Err(ContractError::SensitiveClaimInPlaintext);
            }
            let ct_len = field.ciphertext.len();
            if ct_len <= AEAD_TAG_LEN || ct_len > MAX_FIELD_CIPHERTEXT_LEN {
                return Err(ContractError::InvalidEncryptedField);
            }
            names.push_back(name);
        }

        let subject_enc = Self::require_active_key(&env, &cred.subject)?;
        Self::validate_wrapped_key(&subject_key, &subject_enc)?;

        let now = env.ledger().timestamp();
        let metadata = EncryptionMetadata {
            scheme: ENC_SCHEME_XCHACHA20_X25519,
            key_algorithm: KEY_ALG_X25519,
            encrypted_fields: names,
            encrypted_by: issuer.clone(),
            encrypted_at: now,
            subject_key_version: subject_enc.version,
        };
        let ttl = Self::ttl_for_credential(&env, cred.expires_at);
        let fields_key = (ENC_FIELDS, credential_id.clone());
        env.storage().persistent().set(&meta_key, &metadata);
        env.storage().persistent().set(&fields_key, &fields);
        env.storage().persistent().extend_ttl(&meta_key, ttl, ttl);
        env.storage().persistent().extend_ttl(&fields_key, ttl, ttl);

        Self::store_grant(
            &env,
            &credential_id,
            &cred.subject,
            AccessGrant {
                wrapped_key: subject_key,
                fields: Vec::new(&env),
                granted_by: issuer.clone(),
                granted_at: now,
                expires_at: 0,
            },
            ttl,
        )?;

        env.events().publish(
            (ENC_EVENT, symbol_short!("attached")),
            (crate::EVENT_VERSION, credential_id, issuer, fields.len()),
        );
        Ok(())
    }

    /// Subject grants `reader` access to `fields` (empty = all) by supplying
    /// the DEK re-wrapped to the reader's registered key. Re-granting
    /// replaces the previous grant.
    pub fn grant_claim_access(
        env: Env,
        subject: Address,
        credential_id: BytesN<32>,
        reader: Address,
        wrapped_key: WrappedKey,
        fields: Vec<String>,
        expires_at: u64,
    ) -> Result<(), ContractError> {
        subject.require_auth();
        Self::require_not_paused(&env)?;
        let cred = Self::load_live_credential(&env, &credential_id)?;
        if cred.subject != subject {
            return Err(ContractError::Unauthorized);
        }
        let metadata = Self::get_encryption_metadata(env.clone(), credential_id.clone())?;
        for f in fields.iter() {
            if !metadata.encrypted_fields.contains(&f) {
                return Err(ContractError::InvalidEncryptedField);
            }
        }
        let now = env.ledger().timestamp();
        if expires_at != 0 && expires_at <= now {
            return Err(ContractError::AccessGrantExpired);
        }
        let reader_enc = Self::require_active_key(&env, &reader)?;
        Self::validate_wrapped_key(&wrapped_key, &reader_enc)?;

        let ttl = Self::ttl_for_credential(&env, cred.expires_at);
        Self::store_grant(
            &env,
            &credential_id,
            &reader,
            AccessGrant {
                wrapped_key,
                fields: fields.clone(),
                granted_by: subject,
                granted_at: now,
                expires_at,
            },
            ttl,
        )?;
        env.events().publish(
            (ENC_EVENT, symbol_short!("granted")),
            (crate::EVENT_VERSION, credential_id, reader, fields.len(), expires_at),
        );
        Ok(())
    }

    /// Subject revokes a reader's grant. The subject's own grant cannot be
    /// revoked.
    pub fn revoke_claim_access(
        env: Env,
        subject: Address,
        credential_id: BytesN<32>,
        reader: Address,
    ) -> Result<(), ContractError> {
        subject.require_auth();
        let cred: Credential = env
            .storage()
            .persistent()
            .get(&Self::cred_key(&credential_id))
            .ok_or(ContractError::CredentialNotFound)?;
        if cred.subject != subject || reader == subject {
            return Err(ContractError::Unauthorized);
        }
        let grant_key = (ENC_GRANT, credential_id.clone(), reader.clone());
        if !env.storage().persistent().has(&grant_key) {
            return Err(ContractError::AccessDenied);
        }
        env.storage().persistent().remove(&grant_key);

        let readers_key = (ENC_READERS, credential_id.clone());
        let readers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&readers_key)
            .unwrap_or(Vec::new(&env));
        let mut kept: Vec<Address> = Vec::new(&env);
        for r in readers.iter() {
            if r != reader {
                kept.push_back(r);
            }
        }
        env.storage().persistent().set(&readers_key, &kept);

        env.events().publish(
            (ENC_EVENT, symbol_short!("revoked")),
            (crate::EVENT_VERSION, credential_id, reader),
        );
        Ok(())
    }

    /// Access-controlled fetch of encrypted fields. `reader` must authorise
    /// the call and hold an unexpired grant; the credential must be live.
    /// Only the fields covered by the grant are returned.
    pub fn get_encrypted_claims(
        env: Env,
        reader: Address,
        credential_id: BytesN<32>,
    ) -> Result<EncryptedClaimsView, ContractError> {
        reader.require_auth();
        Self::load_live_credential(&env, &credential_id)?;
        let metadata = Self::get_encryption_metadata(env.clone(), credential_id.clone())?;
        let grant: AccessGrant = env
            .storage()
            .persistent()
            .get(&(ENC_GRANT, credential_id.clone(), reader.clone()))
            .ok_or(ContractError::AccessDenied)?;
        if grant.expires_at != 0 && env.ledger().timestamp() >= grant.expires_at {
            return Err(ContractError::AccessGrantExpired);
        }
        let all: Map<String, EncryptedField> = env
            .storage()
            .persistent()
            .get(&(ENC_FIELDS, credential_id.clone()))
            .ok_or(ContractError::EncryptedClaimsNotFound)?;

        let fields = if grant.fields.is_empty() {
            all
        } else {
            let mut subset: Map<String, EncryptedField> = Map::new(&env);
            for name in grant.fields.iter() {
                if let Some(f) = all.get(name.clone()) {
                    subset.set(name, f);
                }
            }
            subset
        };

        env.events().publish(
            (ENC_EVENT, symbol_short!("accessed")),
            (crate::EVENT_VERSION, credential_id, reader),
        );
        Ok(EncryptedClaimsView {
            fields,
            wrapped_key: grant.wrapped_key,
            metadata,
        })
    }

    pub fn get_encryption_metadata(
        env: Env,
        credential_id: BytesN<32>,
    ) -> Result<EncryptionMetadata, ContractError> {
        env.storage()
            .persistent()
            .get(&(ENC_META, credential_id))
            .ok_or(ContractError::EncryptedClaimsNotFound)
    }

    /// Readers currently holding a grant for `credential_id` (subject included).
    pub fn get_claim_readers(env: Env, credential_id: BytesN<32>) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&(ENC_READERS, credential_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Partial disclosure: returns `true` when every disclosed (field, value,
    /// salt) triple matches the stored commitment for a live credential.
    /// Fields not listed stay confidential.
    pub fn verify_claim_disclosure(
        env: Env,
        credential_id: BytesN<32>,
        disclosures: Vec<ClaimDisclosure>,
    ) -> Result<bool, ContractError> {
        Self::load_live_credential(&env, &credential_id)?;
        if disclosures.is_empty() || disclosures.len() > MAX_ENCRYPTED_FIELDS {
            return Err(ContractError::InvalidEncryptedField);
        }
        let all: Map<String, EncryptedField> = env
            .storage()
            .persistent()
            .get(&(ENC_FIELDS, credential_id))
            .ok_or(ContractError::EncryptedClaimsNotFound)?;
        for d in disclosures.iter() {
            let stored = match all.get(d.field.clone()) {
                Some(f) => f,
                None => return Ok(false),
            };
            if Self::claim_commitment(env.clone(), d.field, d.value, d.salt)? != stored.commitment {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// `SHA-256(salt || u32_be(len(field)) || field || value)` — exposed so
    /// clients can check their off-chain commitment encoding.
    pub fn claim_commitment(
        env: Env,
        field: String,
        value: Bytes,
        salt: BytesN<32>,
    ) -> Result<BytesN<32>, ContractError> {
        if field.len() == 0 || field.len() > MAX_FIELD_NAME_LEN {
            return Err(ContractError::InvalidEncryptedField);
        }
        let mut preimage = Bytes::from_array(&env, &salt.to_array());
        let name = Self::string_bytes(&env, &field);
        preimage.extend_from_array(&name.len().to_be_bytes());
        preimage.append(&name);
        preimage.append(&value);
        Ok(env.crypto().sha256(&preimage).into())
    }
}

// ── Private helpers ──────────────────────────────────────────────────────────

impl CredentialManager {
    fn load_live_credential(env: &Env, id: &BytesN<32>) -> Result<Credential, ContractError> {
        let cred: Credential = env
            .storage()
            .persistent()
            .get(&Self::cred_key(id))
            .ok_or(ContractError::CredentialNotFound)?;
        if cred.revoked {
            return Err(ContractError::CredentialRevoked);
        }
        if cred.expires_at != 0 && env.ledger().timestamp() >= cred.expires_at {
            return Err(ContractError::CredentialExpired);
        }
        Ok(cred)
    }

    fn require_active_key(env: &Env, owner: &Address) -> Result<EncryptionKey, ContractError> {
        let key: EncryptionKey = env
            .storage()
            .persistent()
            .get(&(ENC_KEY, owner.clone()))
            .ok_or(ContractError::EncryptionKeyNotFound)?;
        if key.revoked {
            return Err(ContractError::EncryptionKeyRevoked);
        }
        Ok(key)
    }

    fn validate_wrapped_key(wrapped: &WrappedKey, recipient: &EncryptionKey) -> Result<(), ContractError> {
        if wrapped.ciphertext.len() != WRAPPED_DEK_LEN {
            return Err(ContractError::InvalidEncryptionKey);
        }
        if wrapped.recipient_key_version != recipient.version {
            return Err(ContractError::InvalidEncryptionKey);
        }
        Ok(())
    }

    fn store_grant(
        env: &Env,
        credential_id: &BytesN<32>,
        reader: &Address,
        grant: AccessGrant,
        ttl: u32,
    ) -> Result<(), ContractError> {
        let readers_key = (ENC_READERS, credential_id.clone());
        let mut readers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&readers_key)
            .unwrap_or(Vec::new(env));
        if !readers.contains(reader) {
            if readers.len() >= MAX_READERS_PER_CREDENTIAL {
                return Err(ContractError::TooManyClaimReaders);
            }
            readers.push_back(reader.clone());
            env.storage().persistent().set(&readers_key, &readers);
            env.storage().persistent().extend_ttl(&readers_key, ttl, ttl);
        }
        let grant_key = (ENC_GRANT, credential_id.clone(), reader.clone());
        env.storage().persistent().set(&grant_key, &grant);
        env.storage().persistent().extend_ttl(&grant_key, ttl, ttl);
        Ok(())
    }

    /// UTF-8 bytes of a Soroban `String`. Callers must bound `s` by
    /// `MAX_FIELD_NAME_LEN` first.
    fn string_bytes(env: &Env, s: &String) -> Bytes {
        let mut buf = [0u8; MAX_FIELD_NAME_LEN as usize];
        let n = s.len() as usize;
        s.copy_into_slice(&mut buf[..n]);
        Bytes::from_slice(env, &buf[..n])
    }
}
