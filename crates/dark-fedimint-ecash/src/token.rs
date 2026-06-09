//! The redeem artifact — everything the on-chain redeem instruction needs, as a
//! serde-serializable bundle the e2e harness writes to JSON and the node script
//! feeds into instruction data.
//!
//! Wire layout the redeem program parses (all hex in JSON):
//!   y           : 32  — `Y = H2C(x)`, the unlinkable token point
//!   c           : 32  — `C = k·Y` (unblinded threshold signature)
//!   dleq        : 64  — `e ‖ z`  (Chaum–Pedersen proof C = k·Y under K)
//!   group_pub   : 32  — `K = k·G` (must match the on-chain stored mint key)
//!   nullifier   : 32  — `SHA256("eNULL-NULLIFIER-v1" ‖ Y)`, the on-chain PDA seed
//!
//! The token secret `x` never goes on-chain (kept for reference only). `Y` is the
//! unlinkable identifier the federation blind-signed without ever seeing it.

use crate::bdhke::hash_to_curve;
use crate::dleq::DleqProof;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// On-chain-matching nullifier: `SHA256("eNULL-NULLIFIER-v1" ‖ Y)`. Mirrors the
/// redeem program's `nullifier_of` (sol_sha256). 32-byte big-endian SHA-256.
pub fn nullifier_from_y(y: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"eNULL-NULLIFIER-v1");
    h.update(y);
    h.finalize().into()
}

/// A complete, redeemable token bundle.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RedeemArtifact {
    pub secret_hex: String,
    pub y_hex: String,
    pub c_hex: String,
    pub dleq_hex: String,
    pub group_pub_hex: String,
    pub nullifier_hex: String,
}

impl RedeemArtifact {
    pub fn new(secret: &[u8], c: [u8; 32], proof: DleqProof, group_pub: [u8; 32]) -> Self {
        let y = hash_to_curve(secret).compress().to_bytes();
        RedeemArtifact {
            secret_hex: hex(secret),
            y_hex: hex(&y),
            c_hex: hex(&c),
            dleq_hex: hex(&proof.to_bytes()),
            group_pub_hex: hex(&group_pub),
            nullifier_hex: hex(&nullifier_from_y(&y)),
        }
    }
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}
