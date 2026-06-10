//! Wire (de)serialization for the presentation, with canonical-encoding checks on
//! every field (spec Part 8, residual risk 7: a single un-checked field reopens
//! malleability).
//!
//! Layout — 448 bytes, all fields 32 bytes, fixed order:
//! ```text
//!   cx0 ‖ cx1 ‖ cy0 ‖ cy1 ‖ cy2 ‖ cv ‖ n            (7 compressed Ristretto points)
//!   e ‖ s_z ‖ s_z0 ‖ s_t ‖ s_attr0 ‖ s_attr1 ‖ s_attr2   (7 canonical scalars)
//! ```
//! Points are validated by `CompressedRistretto::decompress` (which rejects
//! non-canonical encodings); scalars by `Scalar::from_canonical_bytes` (which
//! rejects any value ≥ the group order). `from_bytes` returns `None` on any
//! malformed field — the gateway turns that into a clean rejection, never a panic.

use crate::present::Presentation;
use curve25519_dalek::ristretto::CompressedRistretto;
use curve25519_dalek::scalar::Scalar;

/// Serialized presentation length.
pub const PRESENTATION_WIRE_LEN: usize = 14 * 32;

impl Presentation {
    /// Serialize to the canonical 448-byte wire encoding.
    pub fn to_bytes(&self) -> [u8; PRESENTATION_WIRE_LEN] {
        let mut out = [0u8; PRESENTATION_WIRE_LEN];
        let points = [
            self.cx0, self.cx1, self.cy[0], self.cy[1], self.cy[2], self.cv, self.n,
        ];
        let scalars = [
            self.e,
            self.s_z,
            self.s_z0,
            self.s_t,
            self.s_attr[0],
            self.s_attr[1],
            self.s_attr[2],
        ];
        let mut off = 0;
        for p in points.iter() {
            out[off..off + 32].copy_from_slice(p.compress().as_bytes());
            off += 32;
        }
        for s in scalars.iter() {
            out[off..off + 32].copy_from_slice(s.as_bytes());
            off += 32;
        }
        out
    }

    /// Parse from the canonical wire encoding, validating every field. Returns
    /// `None` if the length is wrong, any point is a non-canonical Ristretto
    /// encoding, or any scalar is non-canonical.
    pub fn from_bytes(bytes: &[u8]) -> Option<Presentation> {
        if bytes.len() != PRESENTATION_WIRE_LEN {
            return None;
        }
        let mut off = 0;
        let mut next_point = || -> Option<curve25519_dalek::ristretto::RistrettoPoint> {
            let mut b = [0u8; 32];
            b.copy_from_slice(&bytes[off..off + 32]);
            off += 32;
            CompressedRistretto(b).decompress()
        };
        let cx0 = next_point()?;
        let cx1 = next_point()?;
        let cy0 = next_point()?;
        let cy1 = next_point()?;
        let cy2 = next_point()?;
        let cv = next_point()?;
        let n = next_point()?;

        let mut next_scalar = || -> Option<Scalar> {
            let mut b = [0u8; 32];
            b.copy_from_slice(&bytes[off..off + 32]);
            off += 32;
            Scalar::from_canonical_bytes(b)
        };
        let e = next_scalar()?;
        let s_z = next_scalar()?;
        let s_z0 = next_scalar()?;
        let s_t = next_scalar()?;
        let s_a0 = next_scalar()?;
        let s_a1 = next_scalar()?;
        let s_a2 = next_scalar()?;

        Some(Presentation {
            cx0,
            cx1,
            cy: [cy0, cy1, cy2],
            cv,
            n,
            e,
            s_z,
            s_z0,
            s_t,
            s_attr: [s_a0, s_a1, s_a2],
        })
    }
}
