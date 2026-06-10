//! Small shared helpers.

use curve25519_dalek::scalar::Scalar;

/// Reduce a 64-byte uniform string to a field scalar. The canonical way to turn
/// 512 bits of entropy (or a SHA-512 digest) into a uniform `Scalar`.
pub fn scalar_from_wide(wide: &[u8; 64]) -> Scalar {
    Scalar::from_bytes_mod_order_wide(wide)
}

/// Sample a uniform field scalar from the OS RNG. Host-only (prover/issuer side).
#[cfg(feature = "rand")]
pub fn random_scalar() -> Scalar {
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut wide = [0u8; 64];
    OsRng.fill_bytes(&mut wide);
    Scalar::from_bytes_mod_order_wide(&wide)
}

/// Sample `N` uniform scalars.
#[cfg(feature = "rand")]
pub fn random_scalars<const N: usize>() -> [Scalar; N] {
    let mut out = [Scalar::zero(); N];
    for s in out.iter_mut() {
        *s = random_scalar();
    }
    out
}
