//! DLEQ (Chaum–Pedersen) proof that the SAME `k` satisfies `K = k·G` and
//! `C = k·Y`, without revealing `k`. This is what the on-chain redeem checks:
//! given the public mint key `K`, the token point `Y = H2C(secret)`, and the
//! unblinded signature `C`, a valid DLEQ proves `C` is a genuine mint signature
//! on `Y` — so the chain never needs `k`.
//!
//! Non-interactive (Fiat–Shamir). Proof = `(e, z)` two scalars (64 bytes).
//!
//! Verification (the on-chain hot path) is two double-scalar-mults plus one
//! SHA-512 — no Groth16, no pairing. `no_std`, so the redeem program links it
//! directly.
//!
//!   prove:  s ← random;  R1 = s·G,  R2 = s·Y
//!           e = H(G, K, Y, C, R1, R2)
//!           z = s + e·k
//!   verify: R1' = z·G − e·K   (= s·G,  iff K = k·G)
//!           R2' = z·Y − e·C   (= s·Y,  iff C = k·Y, same k)
//!           accept iff e == H(G, K, Y, C, R1', R2')

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

#[cfg(not(feature = "std"))]
extern crate alloc;

/// A non-interactive DLEQ proof: challenge `e` and response `z`, each a 32-byte
/// canonical scalar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DleqProof {
    pub e: [u8; 32],
    pub z: [u8; 32],
}

impl DleqProof {
    /// Serialize as `e ‖ z` (64 bytes) for instruction data.
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&self.e);
        out[32..].copy_from_slice(&self.z);
        out
    }
    /// Parse from `e ‖ z` (64 bytes).
    pub fn from_bytes(b: &[u8; 64]) -> Self {
        let mut e = [0u8; 32];
        let mut z = [0u8; 32];
        e.copy_from_slice(&b[..32]);
        z.copy_from_slice(&b[32..]);
        DleqProof { e, z }
    }
}

/// Fiat–Shamir challenge: `e = H(G, K, Y, C, R1, R2) mod ℓ`.
///
/// Binding `Y` and `C` (the per-token statement) into the hash makes the proof
/// non-transferable to a different token; binding `G` and `K` pins the mint key.
fn challenge(
    k_pub: &CompressedRistretto,
    y: &CompressedRistretto,
    c: &CompressedRistretto,
    r1: &CompressedRistretto,
    r2: &CompressedRistretto,
) -> Scalar {
    let mut h = Sha512::new();
    h.update(b"eNULL-DLEQ-v1");
    h.update(G.compress().as_bytes());
    h.update(k_pub.as_bytes());
    h.update(y.as_bytes());
    h.update(c.as_bytes());
    h.update(r1.as_bytes());
    h.update(r2.as_bytes());
    let d = h.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&d);
    Scalar::from_bytes_mod_order_wide(&wide)
}

/// Prover (mint side, knows `k`): build a DLEQ for `(Y, C)` under key `k`.
/// `nonce` MUST be uniformly random and never reused.
///
/// Host-side only (the prover never runs on-chain), but kept `no_std`-clean.
pub fn prove_dleq(k: &Scalar, y: &RistrettoPoint, nonce: Scalar) -> DleqProof {
    let k_pub = (k * G).compress();
    let c = (k * y).compress();
    let r1 = (nonce * G).compress();
    let r2 = (nonce * y).compress();
    let e = challenge(&k_pub, &y.compress(), &c, &r1, &r2);
    let z = nonce + e * k;
    DleqProof {
        e: e.to_bytes(),
        z: z.to_bytes(),
    }
}

/// Verifier (the on-chain hot path): does `proof` prove that `C = k·Y` for the
/// same `k` as `K = k·G`?  All inputs are compressed-Ristretto byte encodings.
///
/// Returns `false` on any malformed point/scalar rather than panicking — the
/// redeem program turns `false` into a clean custom error.
pub fn verify_dleq(
    k_pub_bytes: &[u8; 32],
    y_bytes: &[u8; 32],
    c_bytes: &[u8; 32],
    proof: &DleqProof,
) -> bool {
    let k_pub_c = CompressedRistretto(*k_pub_bytes);
    let y_c = CompressedRistretto(*y_bytes);
    let c_c = CompressedRistretto(*c_bytes);

    let (k_pub, y, c) = match (k_pub_c.decompress(), y_c.decompress(), c_c.decompress()) {
        (Some(a), Some(b), Some(d)) => (a, b, d),
        _ => return false,
    };

    let e = match Scalar::from_canonical_bytes(proof.e) {
        Some(s) => s,
        None => return false,
    };
    let z = match Scalar::from_canonical_bytes(proof.z) {
        Some(s) => s,
        None => return false,
    };

    // R1' = z·G − e·K ;  R2' = z·Y − e·C
    let r1 = (z * G) - (e * k_pub);
    let r2 = (z * y) - (e * c);

    let e_check = challenge(&k_pub_c, &y_c, &c_c, &r1.compress(), &r2.compress());
    // Recomputed challenge must equal the proof's challenge.
    e_check.to_bytes() == proof.e
}

#[cfg(test)]
mod tests {
    use super::super::bdhke::hash_to_curve;
    use super::*;
    use rand::rngs::OsRng;
    use rand::RngCore;

    fn rs() -> Scalar {
        let mut wide = [0u8; 64];
        OsRng.fill_bytes(&mut wide);
        Scalar::from_bytes_mod_order_wide(&wide)
    }

    #[test]
    fn dleq_roundtrip_accepts() {
        let k = rs();
        let y = hash_to_curve(b"some-secret");
        let nonce = rs();
        let proof = prove_dleq(&k, &y, nonce);

        let k_pub = (k * G).compress().to_bytes();
        let c = (k * y).compress().to_bytes();
        let y_b = y.compress().to_bytes();
        assert!(verify_dleq(&k_pub, &y_b, &c, &proof));
    }

    #[test]
    fn dleq_wrong_c_rejected() {
        let k = rs();
        let y = hash_to_curve(b"secret");
        let proof = prove_dleq(&k, &y, rs());
        let k_pub = (k * G).compress().to_bytes();
        // C for a DIFFERENT k — DLEQ must reject.
        let k2 = rs();
        let bad_c = (k2 * y).compress().to_bytes();
        let y_b = y.compress().to_bytes();
        assert!(!verify_dleq(&k_pub, &y_b, &bad_c, &proof));
    }

    #[test]
    fn dleq_wrong_y_rejected() {
        let k = rs();
        let y = hash_to_curve(b"secret");
        let proof = prove_dleq(&k, &y, rs());
        let k_pub = (k * G).compress().to_bytes();
        let c = (k * y).compress().to_bytes();
        // Verify against a different Y (different token) — must reject.
        let y2 = hash_to_curve(b"other").compress().to_bytes();
        assert!(!verify_dleq(&k_pub, &y2, &c, &proof));
    }

    #[test]
    fn dleq_tampered_proof_rejected() {
        let k = rs();
        let y = hash_to_curve(b"secret");
        let mut proof = prove_dleq(&k, &y, rs());
        let k_pub = (k * G).compress().to_bytes();
        let c = (k * y).compress().to_bytes();
        let y_b = y.compress().to_bytes();
        proof.z[0] ^= 0x01; // flip a bit
        assert!(!verify_dleq(&k_pub, &y_b, &c, &proof));
    }
}
