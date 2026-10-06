//! Voucher cryptography: ed25519 verification inside the program, the voucher
//! message, leaf and Merkle hashing.
//!
//! Verification follows the measured spike (`spikes/x402-batch`): the program
//! computes `k = SHA-512(R || A || M) mod L` itself and checks
//! `[s]B + [-k]A == R` with one two-point curve25519 multiscalar
//! multiplication. The ed25519 precompile is not used, so a voucher costs no
//! signature fee.
//!
//! SHA-512 comes from the `sol_sha512` syscall (SIMD-0512) when the crate is
//! built with the `sha512-syscall` feature (cluster builds). Without it the
//! program uses the portable SHA-512 below; the solana-program-test 1.18
//! runtime used by the test suite has no `sol_sha512`.

use solana_program::hash::hashv;

/// Domain tag of every voucher message.
pub const VOUCHER_TAG: &[u8; 8] = b"X402STL1";
/// Length of the signed voucher message.
pub const MSG_LEN: usize = 224;
/// Domain prefix of the per-ledger cluster salt.
pub const SALT_DOMAIN: &[u8] = b"x402-settle:domain:v1";

/// Compressed ed25519 base point.
pub const BASEPOINT: [u8; 32] = [
    0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
];

// ---------------------------------------------------------------------------
// Scalar arithmetic mod L (radix 2^52 Montgomery, the structure of
// curve25519-dalek's u64 backend). Taken from the spike; pinned by
// `scalar_vectors.in`.
// ---------------------------------------------------------------------------
const MASK: u64 = (1u64 << 52) - 1;
const L52: [u64; 5] = [0x2631a5cf5d3ed, 0xdea2f79cd6581, 0x14def9, 0, 0x100000000000];
const R52: [u64; 5] = [0xf48bd6721e6ed, 0x3bab5ac67e45a, 0xfffffeb35e51b, 0xfffffffffffff, 0xfffffffffff];
const RR52: [u64; 5] = [0x9d265e952d13b, 0xd63c715bea69f, 0x5be65cb687604, 0x3dceec73d217f, 0x9411b7c309a];
const LFACTOR: u64 = 0x51da312547e1b;
const L64: [u64; 4] = [0x5812631a5cf5d3ed, 0x14def9dea2f79cd6, 0, 0x1000000000000000];

#[inline(always)]
fn m(a: u64, b: u64) -> u128 {
    (a as u128) * (b as u128)
}

fn sub52(a: &[u64; 5], b: &[u64; 5]) -> [u64; 5] {
    let mut d = [0u64; 5];
    let mut borrow: u64 = 0;
    for i in 0..5 {
        borrow = a[i].wrapping_sub(b[i] + (borrow >> 63));
        d[i] = borrow & MASK;
    }
    let under = 0u64.wrapping_sub(borrow >> 63);
    let mut carry: u64 = 0;
    for i in 0..5 {
        carry = (carry >> 52) + d[i] + (L52[i] & under);
        d[i] = carry & MASK;
    }
    d
}

pub fn add52(a: &[u64; 5], b: &[u64; 5]) -> [u64; 5] {
    let mut s = [0u64; 5];
    let mut carry: u64 = 0;
    for i in 0..5 {
        carry = a[i] + b[i] + (carry >> 52);
        s[i] = carry & MASK;
    }
    sub52(&s, &L52)
}

fn mont_mul(a: &[u64; 5], b: &[u64; 5]) -> [u64; 5] {
    let mut z = [0u128; 9];
    for i in 0..5 {
        for j in 0..5 {
            z[i + j] += m(a[i], b[j]);
        }
    }
    #[inline(always)]
    fn part1(sum: u128) -> (u128, u64) {
        let p = (sum as u64).wrapping_mul(LFACTOR) & MASK;
        ((sum + m(p, L52[0])) >> 52, p)
    }
    #[inline(always)]
    fn part2(sum: u128) -> (u128, u64) {
        (sum >> 52, (sum as u64) & MASK)
    }
    let l = &L52;
    let (c, n0) = part1(z[0]);
    let (c, n1) = part1(c + z[1] + m(n0, l[1]));
    let (c, n2) = part1(c + z[2] + m(n0, l[2]) + m(n1, l[1]));
    let (c, n3) = part1(c + z[3] + m(n1, l[2]) + m(n2, l[1]));
    let (c, n4) = part1(c + z[4] + m(n0, l[4]) + m(n2, l[2]) + m(n3, l[1]));
    let (c, r0) = part2(c + z[5] + m(n1, l[4]) + m(n3, l[2]) + m(n4, l[1]));
    let (c, r1) = part2(c + z[6] + m(n2, l[4]) + m(n4, l[2]));
    let (c, r2) = part2(c + z[7] + m(n3, l[4]));
    let (c, r3) = part2(c + z[8] + m(n4, l[4]));
    let r4 = c as u64;
    sub52(&[r0, r1, r2, r3, r4], &L52)
}

#[inline(always)]
fn rd64(b: &[u8], o: usize) -> u64 {
    let mut w = [0u8; 8];
    w.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(w)
}

/// 64-byte little-endian integer reduced mod L, as 52-bit limbs.
pub fn reduce_wide(b: &[u8; 64]) -> [u64; 5] {
    let mut w = [0u64; 8];
    for (i, x) in w.iter_mut().enumerate() {
        *x = rd64(b, 8 * i);
    }
    let lo = [
        w[0] & MASK,
        ((w[0] >> 52) | (w[1] << 12)) & MASK,
        ((w[1] >> 40) | (w[2] << 24)) & MASK,
        ((w[2] >> 28) | (w[3] << 36)) & MASK,
        ((w[3] >> 16) | (w[4] << 48)) & MASK,
    ];
    let hi = [
        (w[4] >> 4) & MASK,
        ((w[4] >> 56) | (w[5] << 8)) & MASK,
        ((w[5] >> 44) | (w[6] << 20)) & MASK,
        ((w[6] >> 32) | (w[7] << 32)) & MASK,
        w[7] >> 20,
    ];
    add52(&mont_mul(&hi, &RR52), &mont_mul(&lo, &R52))
}

pub fn limbs_to_bytes(l: &[u64; 5]) -> [u8; 32] {
    let w = [
        l[0] | (l[1] << 52),
        (l[1] >> 12) | (l[2] << 40),
        (l[2] >> 24) | (l[3] << 28),
        (l[3] >> 36) | (l[4] << 16),
    ];
    let mut out = [0u8; 32];
    for i in 0..4 {
        out[8 * i..8 * i + 8].copy_from_slice(&w[i].to_le_bytes());
    }
    out
}

/// `-k mod L`.
pub fn neg52(k: &[u64; 5]) -> [u64; 5] {
    sub52(&[0u64; 5], k)
}

/// True if the 32-byte little-endian scalar is below L.
pub fn is_canonical_scalar(s: &[u8]) -> bool {
    for i in (0..4).rev() {
        let v = rd64(s, 8 * i);
        if v < L64[i] {
            return true;
        }
        if v > L64[i] {
            return false;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Payer key checks (done once, when the escrow opens).
// ---------------------------------------------------------------------------

/// y coordinates (sign bit cleared) of the points of order 1, 2, 4 and 8.
const SMALL_ORDER_Y: [[u8; 32]; 5] = [
    // y = 0 (order 4)
    [0; 32],
    // y = 1 (identity)
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // y = p - 1 (order 2)
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ],
    // order 8
    [
        0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0,
        0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05,
    ],
    [
        0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f,
        0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
    ],
];

/// p = 2^255 - 19 as four little-endian u64 words.
const P64: [u64; 4] = [0xffffffffffffffed, 0xffffffffffffffff, 0xffffffffffffffff, 0x7fffffffffffffff];

/// Strict payer key check: the y coordinate is canonical (below p) and the
/// point is not of small order. A key that fails can produce signatures that
/// verify for more than one message under the cofactorless check, so such a
/// key cannot own an escrow. Points that do not decompress at all are refused
/// later by the curve syscall.
pub fn is_strict_pubkey(pk: &[u8; 32]) -> bool {
    let mut y = *pk;
    y[31] &= 0x7f;
    // y < p
    let mut below = false;
    for i in (0..4).rev() {
        let v = rd64(&y, 8 * i);
        if v < P64[i] {
            below = true;
            break;
        }
        if v > P64[i] {
            return false;
        }
    }
    if !below {
        return false;
    }
    !SMALL_ORDER_Y.iter().any(|s| *s == y)
}

// ---------------------------------------------------------------------------
// SHA-512
// ---------------------------------------------------------------------------

#[cfg(not(all(target_os = "solana", feature = "sha512-syscall")))]
mod soft512 {
    const K: [u64; 80] = [
        0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc,
        0x3956c25bf348b538, 0x59f111f1b605d019, 0x923f82a4af194f9b, 0xab1c5ed5da6d8118,
        0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
        0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694,
        0xe49b69c19ef14ad2, 0xefbe4786384f25e3, 0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65,
        0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
        0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4,
        0xc6e00bf33da88fc2, 0xd5a79147930aa725, 0x06ca6351e003826f, 0x142929670a0e6e70,
        0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
        0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b,
        0xa2bfe8a14cf10364, 0xa81a664bbc423001, 0xc24b8b70d0f89791, 0xc76c51a30654be30,
        0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
        0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8,
        0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb, 0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3,
        0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
        0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b,
        0xca273eceea26619c, 0xd186b8c721c0c207, 0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178,
        0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
        0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c,
        0x4cc5d4becb3e42b6, 0x597f299cfc657e2a, 0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
    ];
    const IV: [u64; 8] = [
        0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
        0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
    ];

    fn compress(h: &mut [u64; 8], block: &[u8; 128]) {
        // 16-word rolling message schedule.
        let mut w = [0u64; 16];
        for (i, x) in w.iter_mut().enumerate() {
            let mut b = [0u8; 8];
            b.copy_from_slice(&block[8 * i..8 * i + 8]);
            *x = u64::from_be_bytes(b);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for t in 0..80 {
            let wt = if t < 16 {
                w[t]
            } else {
                let w15 = w[(t + 1) & 15];
                let w2 = w[(t + 14) & 15];
                let s0 = w15.rotate_right(1) ^ w15.rotate_right(8) ^ (w15 >> 7);
                let s1 = w2.rotate_right(19) ^ w2.rotate_right(61) ^ (w2 >> 6);
                let v = w[t & 15]
                    .wrapping_add(s0)
                    .wrapping_add(w[(t + 9) & 15])
                    .wrapping_add(s1);
                w[t & 15] = v;
                v
            };
            let s1 = e.rotate_right(14) ^ e.rotate_right(18) ^ e.rotate_right(41);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[t]).wrapping_add(wt);
            let s0 = a.rotate_right(28) ^ a.rotate_right(34) ^ a.rotate_right(39);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    pub fn sha512(parts: &[&[u8]]) -> [u8; 64] {
        let mut h = IV;
        let mut buf = [0u8; 128];
        let mut n = 0usize;
        let mut total: u64 = 0;
        for p in parts {
            let mut rest: &[u8] = p;
            while !rest.is_empty() {
                let take = (128 - n).min(rest.len());
                buf[n..n + take].copy_from_slice(&rest[..take]);
                n += take;
                rest = &rest[take..];
                if n == 128 {
                    compress(&mut h, &buf);
                    n = 0;
                }
            }
            total += p.len() as u64;
        }
        buf[n] = 0x80;
        n += 1;
        if n > 112 {
            for x in buf[n..].iter_mut() {
                *x = 0;
            }
            compress(&mut h, &buf);
            n = 0;
        }
        for x in buf[n..120].iter_mut() {
            *x = 0;
        }
        buf[120..128].copy_from_slice(&(total * 8).to_be_bytes());
        compress(&mut h, &buf);
        let mut out = [0u8; 64];
        for i in 0..8 {
            out[8 * i..8 * i + 8].copy_from_slice(&h[i].to_be_bytes());
        }
        out
    }
}

/// SHA-512 of the concatenation of `parts`.
#[cfg(not(all(target_os = "solana", feature = "sha512-syscall")))]
pub fn sha512(parts: &[&[u8]]) -> [u8; 64] {
    soft512::sha512(parts)
}

/// SHA-512 of the concatenation of `parts` (SIMD-0512 syscall).
#[cfg(all(target_os = "solana", feature = "sha512-syscall"))]
pub fn sha512(parts: &[&[u8]]) -> [u8; 64] {
    extern "C" {
        fn sol_sha512(vals: *const u8, val_len: u64, hash_result: *mut u8) -> u64;
    }
    let mut out = [0u8; 64];
    unsafe {
        sol_sha512(parts as *const _ as *const u8, parts.len() as u64, out.as_mut_ptr());
    }
    out
}

// ---------------------------------------------------------------------------
// ed25519
// ---------------------------------------------------------------------------

/// `[s]B + [neg_k]A`, compressed. `None` if A does not decompress.
#[cfg(target_os = "solana")]
fn double_mul(s: &[u8; 32], neg_k: &[u8; 32], a: &[u8; 32]) -> Option<[u8; 32]> {
    let mut scalars = [0u8; 64];
    scalars[0..32].copy_from_slice(s);
    scalars[32..64].copy_from_slice(neg_k);
    let mut points = [0u8; 64];
    points[0..32].copy_from_slice(&BASEPOINT);
    points[32..64].copy_from_slice(a);
    let mut out = [0u8; 32];
    // curve id 0 = CURVE25519_EDWARDS
    let rc = unsafe {
        solana_program::syscalls::sol_curve_multiscalar_mul(
            0,
            scalars.as_ptr(),
            points.as_ptr(),
            2,
            out.as_mut_ptr(),
        )
    };
    if rc == 0 {
        Some(out)
    } else {
        None
    }
}

#[cfg(not(target_os = "solana"))]
fn double_mul(s: &[u8; 32], neg_k: &[u8; 32], a: &[u8; 32]) -> Option<[u8; 32]> {
    use curve25519_dalek::{edwards::CompressedEdwardsY, edwards::EdwardsPoint, scalar::Scalar};
    let a = CompressedEdwardsY(*a).decompress()?;
    let s = Scalar::from_canonical_bytes(*s)?;
    let nk = Scalar::from_canonical_bytes(*neg_k)?;
    Some(EdwardsPoint::vartime_double_scalar_mul_basepoint(&nk, &a, &s).compress().to_bytes())
}

/// Cofactorless ed25519 verification of `sig` over `msg` by `pk`, with a
/// canonical `s` (no malleability). `pk` must already have passed
/// [`is_strict_pubkey`].
pub fn verify(pk: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    let mut s = [0u8; 32];
    s.copy_from_slice(&sig[32..64]);
    if !is_canonical_scalar(&s) {
        return false;
    }
    let h = sha512(&[&sig[0..32], pk, msg]);
    let k = reduce_wide(&h);
    let neg_k = limbs_to_bytes(&neg52(&k));
    match double_mul(&s, &neg_k, pk) {
        Some(r) => r[..] == sig[0..32],
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Voucher message, leaves, Merkle tree
// ---------------------------------------------------------------------------

/// Fields of a voucher that are not carried on the wire come from accounts:
/// the program id, the ledger's mint and cluster salt, the escrow or channel
/// scope, the payer and the payee.
#[allow(clippy::too_many_arguments)]
pub fn voucher_message(
    program_id: &[u8; 32],
    mint: &[u8; 32],
    salt: &[u8; 32],
    payer: &[u8; 32],
    payee: &[u8; 32],
    scope: u64,
    cumulative: u64,
    expiry_slot: u64,
    quote_hash: &[u8; 32],
) -> [u8; MSG_LEN] {
    let mut m = [0u8; MSG_LEN];
    m[0..8].copy_from_slice(VOUCHER_TAG);
    m[8..40].copy_from_slice(program_id);
    m[40..72].copy_from_slice(mint);
    m[72..104].copy_from_slice(salt);
    m[104..136].copy_from_slice(payer);
    m[136..168].copy_from_slice(payee);
    m[168..176].copy_from_slice(&scope.to_le_bytes());
    m[176..184].copy_from_slice(&cumulative.to_le_bytes());
    m[184..192].copy_from_slice(&expiry_slot.to_le_bytes());
    m[192..224].copy_from_slice(quote_hash);
    m
}

/// Per-ledger cluster salt: binds vouchers to this program, this mint and the
/// cluster on which the ledger was created (through a SlotHashes entry).
pub fn ledger_salt(program_id: &[u8; 32], mint: &[u8; 32], slot: u64, slot_hash: &[u8; 32]) -> [u8; 32] {
    hashv(&[SALT_DOMAIN, program_id, mint, &slot.to_le_bytes(), slot_hash]).to_bytes()
}

/// Leaf of a two-phase batch: the amount the voucher moves and its message.
pub fn batch_leaf(delta: u64, msg: &[u8; MSG_LEN]) -> [u8; 32] {
    hashv(&[&[0u8], &delta.to_le_bytes(), msg]).to_bytes()
}

/// Interior node of the batch tree.
pub fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[1u8], l, r]).to_bytes()
}

/// Root of a full subtree of height `h` whose leaves are all zero.
pub fn zero_root(h: u32) -> [u8; 32] {
    let mut z = [0u8; 32];
    for _ in 0..h {
        z = node(&z, &z);
    }
    z
}

/// Root of a subtree of height `h` (`2^h` leaves) holding `leaves` followed by
/// zero leaves. `leaves.len() <= 2^h <= 32`.
pub fn subtree_root(leaves: &[[u8; 32]], h: u32) -> [u8; 32] {
    let width = 1usize << h;
    let mut lvl = [[0u8; 32]; 32];
    lvl[..leaves.len()].copy_from_slice(leaves);
    let mut n = width;
    let mut zero = [0u8; 32];
    let mut live = leaves.len();
    while n > 1 {
        let half = n / 2;
        for i in 0..half {
            let l = 2 * i;
            if l >= live {
                lvl[i] = node(&zero, &zero);
            } else if l + 1 >= live {
                let a = lvl[l];
                lvl[i] = node(&a, &zero);
            } else {
                let (a, b) = (lvl[l], lvl[l + 1]);
                lvl[i] = node(&a, &b);
            }
        }
        zero = node(&zero, &zero);
        live = live.div_ceil(2);
        n = half;
    }
    lvl[0]
}

/// Number of levels above the chunk subtrees: `ceil(log2(num_chunks))`.
pub fn upper_depth(num_chunks: u32) -> u32 {
    let mut d = 0;
    while (1u32 << d) < num_chunks {
        d += 1;
    }
    d
}

/// Folds a chunk root up to the batch root with `proof` (sibling per level,
/// from the leaf level up).
pub fn fold_proof(mut acc: [u8; 32], index: u32, proof: &[[u8; 32]]) -> [u8; 32] {
    for (j, sib) in proof.iter().enumerate() {
        acc = if (index >> j) & 1 == 1 { node(sib, &acc) } else { node(&acc, sib) };
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hx(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn reduce_matches_python_vectors() {
        let v: &[(&str, &str)] = &include!("scalar_vectors.in");
        for (wide, red) in v {
            let w: [u8; 64] = hx(wide).try_into().unwrap();
            assert_eq!(limbs_to_bytes(&reduce_wide(&w)).to_vec(), hx(red));
            let k = reduce_wide(&w);
            assert_eq!(limbs_to_bytes(&add52(&k, &neg52(&k))), [0u8; 32]);
            assert!(is_canonical_scalar(&hx(red)));
        }
        assert!(!is_canonical_scalar(&limbs_to_bytes(&L52)));
    }

    #[test]
    fn sha512_known_answers() {
        // FIPS 180-2 "abc" and the empty string; 111/112/128/240-byte inputs
        // cross the padding boundaries.
        assert_eq!(
            sha512(&[b"abc"]).to_vec(),
            hx("ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f")
        );
        assert_eq!(
            sha512(&[]).to_vec(),
            hx("cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e")
        );
        for len in [111usize, 112, 127, 128, 129, 240, 288] {
            let data: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
            let split = len / 3;
            let a = sha512(&[&data]);
            let b = sha512(&[&data[..split], &data[split..]]);
            assert_eq!(a, b);
            use sha2::Digest;
            let r = sha2::Sha512::digest(&data);
            assert_eq!(a.to_vec(), r.to_vec(), "len {len}");
        }
    }

    #[test]
    fn small_order_keys_rejected() {
        for y in SMALL_ORDER_Y.iter() {
            let mut a = *y;
            assert!(!is_strict_pubkey(&a));
            a[31] |= 0x80;
            assert!(!is_strict_pubkey(&a));
        }
        // y = p (non-canonical encoding of 0)
        let mut p = [0xffu8; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        assert!(!is_strict_pubkey(&p));
        assert!(is_strict_pubkey(&BASEPOINT));
    }

    #[test]
    fn subtree_root_matches_naive() {
        let leaves: Vec<[u8; 32]> = (0..5u8).map(|i| [i + 1; 32]).collect();
        for h in 3..=5u32 {
            let mut full = vec![[0u8; 32]; 1 << h];
            full[..5].copy_from_slice(&leaves);
            while full.len() > 1 {
                full = full.chunks(2).map(|c| node(&c[0], &c[1])).collect();
            }
            assert_eq!(subtree_root(&leaves, h), full[0]);
        }
        assert_eq!(subtree_root(&[], 3), zero_root(3));
        assert_eq!(upper_depth(1), 0);
        assert_eq!(upper_depth(2), 1);
        assert_eq!(upper_depth(5), 3);
        assert_eq!(upper_depth(256), 8);
    }
}
