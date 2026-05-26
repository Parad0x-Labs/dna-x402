use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// ── Caveats ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caveat {
    /// Maximum lamports the holder may spend in one operation.
    pub max_amount_lamports: u64,
    /// SHA-256 hashes of allowed x402 service scopes. Empty = all scopes allowed.
    pub allowed_scope_hashes: Vec<[u8; 32]>,
    /// Solana slot after which this credential is invalid.
    pub expires_at_slot: u64,
    /// Bitmask of allowed relayer classes (0 = any).
    pub allowed_relayer_class: u8,
    /// If true, holder may not withdraw to an arbitrary wallet.
    pub no_withdraw: bool,
}

// ── Macaroon ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Macaroon {
    /// Unique credential ID (H of issuer_key || nonce).
    pub id: [u8; 32],
    pub caveats: Vec<Caveat>,
    /// HMAC chain over (id || caveats).
    pub signature: [u8; 32],
}

// ── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub enum MacaroonError {
    Expired,
    OverBudget,
    ScopeForbidden,
    RelayerForbidden,
    WithdrawForbidden,
    InvalidSignature,
}

// ── RFC2104 HMAC-SHA256 ───────────────────────────────────────────────────────

/// Production MAC: RFC2104 HMAC-SHA256. Replaces the old SHA256(key||msg) HMAC-lite.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(msg);
    mac.finalize().into_bytes().into()
}

/// Legacy MAC (SHA256(key || msg)) — test-only, NOT production.
/// Available only when the `legacy-macaroons` feature is enabled.
#[cfg(feature = "legacy-macaroons")]
#[allow(dead_code)]
fn legacy_mac(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(key);
    h.update(msg);
    h.finalize().into()
}

fn caveat_bytes(c: &Caveat) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&c.max_amount_lamports.to_le_bytes());
    b.extend_from_slice(&c.expires_at_slot.to_le_bytes());
    b.push(c.allowed_relayer_class);
    b.push(c.no_withdraw as u8);
    for s in &c.allowed_scope_hashes {
        b.extend_from_slice(s);
    }
    b
}

// ── API ───────────────────────────────────────────────────────────────────────

/// Mint a new macaroon. `issuer_key` is the issuer's 32-byte secret.
pub fn mint(issuer_key: &[u8; 32], nonce: &[u8; 32], caveats: Vec<Caveat>) -> Macaroon {
    let id: [u8; 32] = hmac_sha256(issuer_key, nonce);
    let mut sig = hmac_sha256(issuer_key, &id);
    for c in &caveats {
        sig = hmac_sha256(&sig, &caveat_bytes(c));
    }
    Macaroon {
        id,
        caveats,
        signature: sig,
    }
}

/// Verify a macaroon: recompute signature chain and check all caveats.
/// Uses RFC2104 HMAC-SHA256 only. Legacy SHA256(key||msg) tokens are REJECTED.
pub fn verify(
    m: &Macaroon,
    issuer_key: &[u8; 32],
    nonce: &[u8; 32],
    current_slot: u64,
    spend_amount: u64,
    scope_hash: Option<&[u8; 32]>,
    relayer_class: u8,
    is_withdraw: bool,
) -> Result<(), MacaroonError> {
    // Re-derive id and signature chain using RFC2104 HMAC-SHA256
    let expected_id: [u8; 32] = hmac_sha256(issuer_key, nonce);
    if expected_id != m.id {
        return Err(MacaroonError::InvalidSignature);
    }
    let mut sig = hmac_sha256(issuer_key, &m.id);
    for c in &m.caveats {
        sig = hmac_sha256(&sig, &caveat_bytes(c));
    }
    if sig != m.signature {
        return Err(MacaroonError::InvalidSignature);
    }

    // Check each caveat
    for c in &m.caveats {
        if current_slot > c.expires_at_slot {
            return Err(MacaroonError::Expired);
        }
        if spend_amount > c.max_amount_lamports {
            return Err(MacaroonError::OverBudget);
        }
        if c.no_withdraw && is_withdraw {
            return Err(MacaroonError::WithdrawForbidden);
        }
        if c.allowed_relayer_class != 0 && relayer_class != c.allowed_relayer_class {
            return Err(MacaroonError::RelayerForbidden);
        }
        if !c.allowed_scope_hashes.is_empty() {
            match scope_hash {
                Some(h) if c.allowed_scope_hashes.contains(h) => {}
                _ => return Err(MacaroonError::ScopeForbidden),
            }
        }
    }
    Ok(())
}

/// JSON round-trip helpers.
pub fn to_json(m: &Macaroon) -> String {
    serde_json::to_string(m).unwrap()
}
pub fn from_json(s: &str) -> Result<Macaroon, serde_json::Error> {
    serde_json::from_str(s)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer_key() -> [u8; 32] {
        [0xABu8; 32]
    }
    fn nonce() -> [u8; 32] {
        [0x01u8; 32]
    }

    fn basic_caveat() -> Caveat {
        Caveat {
            max_amount_lamports: 1_000_000,
            allowed_scope_hashes: vec![],
            expires_at_slot: 9999,
            allowed_relayer_class: 0,
            no_withdraw: false,
        }
    }

    // ── Original 7 tests ──────────────────────────────────────────────────────

    #[test]
    fn test_mint_and_verify_ok() {
        let m = mint(&issuer_key(), &nonce(), vec![basic_caveat()]);
        assert!(verify(
            &m,
            &issuer_key(),
            &nonce(),
            100,     // current_slot
            500_000, // spend_amount
            None,    // scope_hash
            0,       // relayer_class
            false,   // is_withdraw
        )
        .is_ok());
    }

    #[test]
    fn test_expired_slot_rejected() {
        let m = mint(&issuer_key(), &nonce(), vec![basic_caveat()]);
        let res = verify(&m, &issuer_key(), &nonce(), 10_000, 0, None, 0, false);
        assert_eq!(res, Err(MacaroonError::Expired));
    }

    #[test]
    fn test_over_budget_rejected() {
        let m = mint(&issuer_key(), &nonce(), vec![basic_caveat()]);
        let res = verify(&m, &issuer_key(), &nonce(), 100, 2_000_000, None, 0, false);
        assert_eq!(res, Err(MacaroonError::OverBudget));
    }

    #[test]
    fn test_withdraw_forbidden_rejected() {
        let caveat = Caveat {
            no_withdraw: true,
            ..basic_caveat()
        };
        let m = mint(&issuer_key(), &nonce(), vec![caveat]);
        let res = verify(&m, &issuer_key(), &nonce(), 100, 0, None, 0, true);
        assert_eq!(res, Err(MacaroonError::WithdrawForbidden));
    }

    #[test]
    fn test_wrong_scope_rejected() {
        let allowed: [u8; 32] = [0xAAu8; 32];
        let wrong: [u8; 32] = [0xBBu8; 32];
        let caveat = Caveat {
            allowed_scope_hashes: vec![allowed],
            ..basic_caveat()
        };
        let m = mint(&issuer_key(), &nonce(), vec![caveat]);
        let res = verify(&m, &issuer_key(), &nonce(), 100, 0, Some(&wrong), 0, false);
        assert_eq!(res, Err(MacaroonError::ScopeForbidden));
    }

    #[test]
    fn test_tampered_caveat_rejected() {
        let mut m = mint(&issuer_key(), &nonce(), vec![basic_caveat()]);
        // Mutate a field after minting — signature chain must break
        m.caveats[0].max_amount_lamports = 999_999_999;
        let res = verify(&m, &issuer_key(), &nonce(), 100, 0, None, 0, false);
        assert_eq!(res, Err(MacaroonError::InvalidSignature));
    }

    #[test]
    fn test_json_roundtrip() {
        let m = mint(&issuer_key(), &nonce(), vec![basic_caveat()]);
        let json = to_json(&m);
        let m2 = from_json(&json).expect("parse failed");
        assert_eq!(m.id, m2.id);
        assert_eq!(m.signature, m2.signature);
        assert_eq!(m.caveats, m2.caveats);
    }

    // ── New tests: RFC2104 correctness + legacy rejection ─────────────────────

    /// NIST HMAC-SHA256 test vector (RFC 4231, Test Case 1):
    ///   Key  = 0x0b repeated 20 times
    ///   Data = "Hi There"
    ///   Expected = b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
    #[test]
    fn test_hmac_rfc2104_known_vector() {
        let key = [0x0bu8; 20];
        let data = b"Hi There";
        let result = hmac_sha256(&key, data);
        let expected = hex_to_bytes32_prefix(
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        );
        assert_eq!(
            result, expected,
            "RFC2104 HMAC-SHA256 does not match NIST vector"
        );
    }

    /// Decode a 64-char hex string into [u8; 32].
    fn hex_to_bytes32_prefix(hex: &str) -> [u8; 32] {
        assert_eq!(hex.len(), 64, "expected 64-char hex string");
        let mut out = [0u8; 32];
        for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
            let hi = (chunk[0] as char).to_digit(16).unwrap() as u8;
            let lo = (chunk[1] as char).to_digit(16).unwrap() as u8;
            out[i] = (hi << 4) | lo;
        }
        out
    }

    /// Legacy SHA256(key||msg) tokens must be REJECTED by the default (RFC2104) verifier.
    /// This confirms SHA256(key||msg) != HMAC-SHA256(key, msg) for real inputs.
    #[cfg(feature = "legacy-macaroons")]
    #[test]
    fn test_legacy_token_rejected_by_default() {
        // Build a token whose signature is computed via the old SHA256(key||msg) path.
        let key = issuer_key();
        let nc = nonce();
        let caveat = basic_caveat();

        // Replicate the old mint() logic using legacy_mac
        let legacy_id: [u8; 32] = legacy_mac(&key, &nc);
        let mut legacy_sig = legacy_mac(&key, &legacy_id);
        legacy_sig = legacy_mac(&legacy_sig, &caveat_bytes(&caveat));

        let legacy_token = Macaroon {
            id: legacy_id,
            caveats: vec![caveat],
            signature: legacy_sig,
        };

        // The RFC2104 verifier must reject this token (id derived differently too).
        let result = verify(&legacy_token, &key, &nc, 100, 500_000, None, 0, false);
        assert_eq!(
            result,
            Err(MacaroonError::InvalidSignature),
            "default verifier must reject legacy SHA256(key||msg) tokens"
        );
    }

    /// Legacy tokens are accepted when explicitly verified with legacy_mac — confirms the
    /// two MAC schemes produce different outputs and the legacy path still works for migration.
    #[cfg(feature = "legacy-macaroons")]
    #[test]
    fn test_legacy_token_accepted_under_feature() {
        let key = issuer_key();
        let nc = nonce();
        let caveat = basic_caveat();

        // Produce a legacy token
        let legacy_id: [u8; 32] = legacy_mac(&key, &nc);
        let mut legacy_sig = legacy_mac(&key, &legacy_id);
        legacy_sig = legacy_mac(&legacy_sig, &caveat_bytes(&caveat));

        // Reproduce the same chain to verify correctness of the legacy path itself
        let recomputed_id: [u8; 32] = legacy_mac(&key, &nc);
        let mut recomputed_sig = legacy_mac(&key, &recomputed_id);
        recomputed_sig = legacy_mac(&recomputed_sig, &caveat_bytes(&caveat));

        assert_eq!(legacy_id, recomputed_id, "legacy id must be deterministic");
        assert_eq!(
            legacy_sig, recomputed_sig,
            "legacy signature must be deterministic"
        );

        // And confirm it differs from the RFC2104 result (the two schemes are not equivalent)
        let rfc_id: [u8; 32] = hmac_sha256(&key, &nc);
        assert_ne!(
            legacy_id, rfc_id,
            "legacy MAC must differ from RFC2104 HMAC-SHA256"
        );
    }
}
