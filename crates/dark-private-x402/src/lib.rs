//! dark-private-x402
//!
//! **Complete private x402 payment pipeline.**
//!
//! Integrates five primitives into one coherent end-to-end flow:
//! - `dark-stealth-address`   — BN254 G1 ECDH address derivation (receiver unlinkability)
//! - `dark-withdrawal-bundle` — note → Merkle proof → 352-byte gate instruction
//! - `dark-merkle-accumulator`— append-only Merkle tree for note commitments
//!
//! ## Flow
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────┐
//! │ SENDER (Bob)                                                         │
//! │                                                                      │
//! │ 1. Fetch Alice's StealthMetaAddress (published off-chain or on-chain)│
//! │ 2. send_private_payment(meta, ephem_secret, value, tree)             │
//! │    → ephem_pub      = ephem_secret * G1  (published)                 │
//! │    → stealth_addr   = spend_pub + ECDH(ephem_secret, view_pub) * G1  │
//! │    → recipient_key  = stealth_addr.x  ← bridges stealth → note      │
//! │    → randomness     = SHA256("priv-x402-rand-v1" || ephem_secret)    │
//! │    → ShieldedNote   = create_note(value, randomness, recipient_key)  │
//! │    → leaf_index     = deposit_note(tree, note)                       │
//! │    → PaymentEnvelope { stealth_payment, note, note_secret, leaf }    │
//! │                                                                      │
//! │ RECEIVER (Alice)                                                     │
//! │                                                                      │
//! │ 3. receive_private_payment(spend_secret, envelope, tree)             │
//! │    → scan_payment(spend_secret, stealth_payment) → StealthSpendKey   │
//! │    → build_withdrawal(note, note_secret, tree, leaf_index)           │
//! │    → instruction_data(bundle) → [u8; 352]  ← dark_bn254_gate input  │
//! │    → ReceivedPayment { spend_key, bundle, gate_ix }                  │
//! └─────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## Privacy guarantees
//!
//! | Property | Mechanism |
//! |---|---|
//! | Receiver unlinkability | BN254 G1 ECDH — stealth addr unique per payment |
//! | Value hiding | Commitment = poseidon(value, randomness, recipient_key) |
//! | Spend binding | Nullifier = poseidon(commitment, note_secret, root) |
//! | Double-spend prevention | Nullifier recorded on-chain by dark_nullifier_banks |
//! | Cross-snapshot replay | Root-bound nullifier — different root → different nullifier |
//!
//! mainnet_ready = false — devnet only until security audit.

use dark_merkle_accumulator::{new_accumulator, MerkleAcc};
pub use dark_stealth_address::create_meta_address;
use dark_stealth_address::{
    create_payment as stealth_create_payment, scan_payment as stealth_scan, StealthMetaAddress,
    StealthPayment, StealthSpendKey,
};
use dark_withdrawal_bundle::{
    build_withdrawal, create_note, deposit_note, derive_note_secret, instruction_data, NoteSecret,
    ShieldedNote, WithdrawalBundle, WithdrawalError,
};
use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

/// What the sender keeps after creating a payment.
///
/// Bob holds `note_secret` as proof-of-payment — he can prove he paid
/// by revealing the note opening `(value, randomness, recipient_key)`.
#[derive(Debug, Clone)]
pub struct PaymentEnvelope {
    /// The stealth payment (published on-chain: ephem_pub + stealth_addr).
    pub stealth_payment: StealthPayment,
    /// The shielded note (commitment deposited into Merkle tree).
    pub note: ShieldedNote,
    /// Note secret — held by sender as payment proof; must stay private until reveal.
    pub note_secret: NoteSecret,
    /// Leaf index in the Merkle tree where the commitment was inserted.
    pub leaf_index: usize,
    /// Service scope hash (binds payment to a specific API endpoint).
    pub service_scope_hash: [u8; 32],
    /// Always false.
    pub mainnet_ready: bool,
}

/// What the receiver gets after detecting and claiming their payment.
#[derive(Debug, Clone)]
pub struct ReceivedPayment {
    /// The one-time spend key derived from the stealth payment.
    /// Used to authorize the on-chain withdrawal transaction.
    pub spend_key: StealthSpendKey,
    /// Full withdrawal bundle (nullifier + Merkle proof + proof_bytes).
    pub withdrawal: WithdrawalBundle,
    /// Ready-to-submit 352-byte instruction for `dark_bn254_gate`.
    pub gate_instruction: [u8; 352],
    /// Amount in lamports that was received.
    pub value: u64,
    /// Always false.
    pub mainnet_ready: bool,
}

/// Errors from this crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrivateX402Error {
    /// A secret key is all-zero.
    ZeroSecret,
    /// Amount is zero.
    ZeroAmount,
    /// The ephemeral secret is all-zero.
    ZeroEphemeralSecret,
    /// Stealth address derivation failed (curve error).
    StealthError(String),
    /// Note creation or withdrawal failed.
    WithdrawalError(String),
    /// Could not insert note into Merkle tree.
    TreeFull,
}

impl From<dark_stealth_address::StealthError> for PrivateX402Error {
    fn from(e: dark_stealth_address::StealthError) -> Self {
        Self::StealthError(format!("{}", e))
    }
}

impl From<WithdrawalError> for PrivateX402Error {
    fn from(e: WithdrawalError) -> Self {
        Self::WithdrawalError(format!("{}", e))
    }
}

impl From<dark_merkle_accumulator::AccError> for PrivateX402Error {
    fn from(_: dark_merkle_accumulator::AccError) -> Self {
        Self::TreeFull
    }
}

impl std::fmt::Display for PrivateX402Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroSecret => write!(f, "secret key is all-zero"),
            Self::ZeroAmount => write!(f, "amount is zero"),
            Self::ZeroEphemeralSecret => write!(f, "ephemeral secret is all-zero"),
            Self::StealthError(s) => write!(f, "stealth error: {}", s),
            Self::WithdrawalError(s) => write!(f, "withdrawal error: {}", s),
            Self::TreeFull => write!(f, "Merkle tree is full"),
        }
    }
}

impl std::error::Error for PrivateX402Error {}

// ── Helper ────────────────────────────────────────────────────────────────────

/// Derive note randomness from the ephemeral secret and service scope.
///
/// Formula: `SHA256("priv-x402-rand-v1" || ephem_secret || service_scope_hash)`
///
/// This ensures each note has unique randomness without requiring the sender
/// to store an extra random value.
pub fn derive_randomness(ephem_secret: &[u8; 32], service_scope_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"priv-x402-rand-v1");
    h.update(ephem_secret.as_slice());
    h.update(service_scope_hash.as_slice());
    h.finalize().into()
}

/// Derive service scope hash from a URL or service identifier string.
pub fn service_scope_hash(service_url: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"priv-x402-scope-v1");
    h.update(service_url.as_bytes());
    h.finalize().into()
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Create a shared Merkle accumulator for note commitments (depth-16, 65 536 leaves).
///
/// In production this would be a canonical on-chain Merkle tree; in devnet
/// it's an in-memory accumulator shared between sender and receiver.
pub fn new_commitment_tree(tree_nonce: &[u8; 32]) -> MerkleAcc {
    new_accumulator(16, tree_nonce).expect("depth 16 is always valid")
}

/// **Sender side**: create a private x402 payment addressed to `meta`.
///
/// # What this does
///
/// 1. Derives the stealth address for this payment:
///    `stealth_addr = spend_pub + ECDH(ephem_secret, view_pub) * G1`
/// 2. Uses `stealth_addr.x` as the `recipient_key` in the shielded note —
///    creating a cryptographic binding between the stealth address and the note.
/// 3. Deposits the note commitment into `tree`.
/// 4. Returns a `PaymentEnvelope` the sender keeps for payment proof.
///
/// The sender publishes `envelope.stealth_payment` (ephem_pub + stealth_addr)
/// so the recipient can scan for incoming payments.
pub fn send_private_payment(
    meta: &StealthMetaAddress,
    ephem_secret: &[u8; 32],
    value: u64,
    service_url: &str,
    tree: &mut MerkleAcc,
) -> Result<PaymentEnvelope, PrivateX402Error> {
    if value == 0 {
        return Err(PrivateX402Error::ZeroAmount);
    }
    if ephem_secret == &[0u8; 32] {
        return Err(PrivateX402Error::ZeroEphemeralSecret);
    }

    // 1. Stealth payment
    let stealth_payment = stealth_create_payment(meta, ephem_secret, value)?;

    // 2. Derive note parameters
    let scope_hash = service_scope_hash(service_url);
    let randomness = derive_randomness(ephem_secret, &scope_hash);
    // recipient_key = stealth_addr.x  (bridges ECDH address to note commitment)
    let recipient_key = stealth_payment.stealth_addr.x;

    // 3. Create and deposit note
    let note = create_note(value, &randomness, &recipient_key)?;
    let leaf_index = tree.leaves.len(); // position before deposit
    deposit_note(tree, &note)?;

    // 4. Derive note secret (sender holds for proof-of-payment)
    // Formula: SHA256("priv-x402-note-secret-v1" || ephem_secret || scope_hash)
    let mut h = Sha256::new();
    h.update(b"priv-x402-note-secret-v1");
    h.update(ephem_secret.as_slice());
    h.update(scope_hash.as_slice());
    let root_secret: [u8; 32] = h.finalize().into();
    let note_secret = derive_note_secret(&root_secret);

    Ok(PaymentEnvelope {
        stealth_payment,
        note,
        note_secret,
        leaf_index,
        service_scope_hash: scope_hash,
        mainnet_ready: false,
    })
}

/// **Receiver side**: scan an envelope and claim the payment if it's addressed to us.
///
/// Uses the view key (derived from `spend_secret`) to check if
/// `envelope.stealth_payment` was sent to this recipient.
///
/// If the payment is ours:
/// - Derives the one-time spend key
/// - Builds the withdrawal bundle (Merkle inclusion proof + nullifier)
/// - Returns the 352-byte gate instruction ready for `dark_bn254_gate`
///
/// Returns `Ok(None)` if the payment was addressed to someone else.
pub fn receive_private_payment(
    spend_secret: &[u8; 32],
    envelope: &PaymentEnvelope,
    tree: &MerkleAcc,
) -> Result<Option<ReceivedPayment>, PrivateX402Error> {
    if spend_secret == &[0u8; 32] {
        return Err(PrivateX402Error::ZeroSecret);
    }

    // 1. Scan — returns Some(StealthSpendKey) iff this is our payment
    let maybe_key = stealth_scan(spend_secret, &envelope.stealth_payment)?;
    let spend_key = match maybe_key {
        Some(k) => k,
        None => return Ok(None),
    };

    // 2. Build withdrawal bundle from the shielded note
    let withdrawal = build_withdrawal(
        &envelope.note,
        &envelope.note_secret,
        tree,
        envelope.leaf_index,
    )?;

    let gate_instruction = instruction_data(&withdrawal);
    let value = withdrawal.value;

    Ok(Some(ReceivedPayment {
        spend_key,
        withdrawal,
        gate_instruction,
        value,
        mainnet_ready: false,
    }))
}

/// Verify the 352-byte gate instruction has the correct wire format.
///
/// This is a sanity check — the real verification happens on-chain in `dark_bn254_gate`.
pub fn verify_gate_instruction_format(ix: &[u8; 352]) -> bool {
    // Devnet: proof must start with [0xDE, 0xAD]
    if ix[0] != 0xDE || ix[1] != 0xAD {
        return false;
    }
    // Merkle root (offset 256..288) must be non-zero
    if ix[256..288].iter().all(|&b| b == 0) {
        return false;
    }
    // Nullifier (offset 288..320) must be non-zero
    if ix[288..320].iter().all(|&b| b == 0) {
        return false;
    }
    // Amount (first 8 bytes of offset 320..352) must be non-zero
    if ix[320..328].iter().all(|&b| b == 0) {
        return false;
    }
    true
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn spend_secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s[1] = 0x01;
        s
    }

    fn ephem_secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xEF;
        s[1] = b;
        s[2] = 0x01;
        s
    }

    fn tree_nonce(b: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = b;
        n
    }

    // ── Test 1: full roundtrip — send and receive ────────────────────────────
    #[test]
    fn test_full_send_receive_roundtrip() {
        let alice_secret = spend_secret(1);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(1));

        let envelope = send_private_payment(
            &meta,
            &ephem_secret(1),
            1_000_000,
            "https://api.darknull.example/service/1",
            &mut tree,
        )
        .unwrap();

        let received = receive_private_payment(&alice_secret, &envelope, &tree)
            .unwrap()
            .expect("Alice must detect her own payment");

        assert_eq!(received.value, 1_000_000);
        assert!(!received.mainnet_ready);
    }

    // ── Test 2: wrong spend secret cannot claim payment ──────────────────────
    #[test]
    fn test_wrong_secret_cannot_receive() {
        let alice_secret = spend_secret(2);
        let bob_secret = spend_secret(99);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(2));

        let envelope = send_private_payment(
            &meta,
            &ephem_secret(2),
            500_000,
            "https://api.darknull.example/service/2",
            &mut tree,
        )
        .unwrap();

        let result = receive_private_payment(&bob_secret, &envelope, &tree).unwrap();
        assert!(
            result.is_none(),
            "Bob must not be able to claim Alice's payment"
        );
    }

    // ── Test 3: gate instruction has correct 352-byte format ─────────────────
    #[test]
    fn test_gate_instruction_format() {
        let alice_secret = spend_secret(3);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(3));

        let envelope = send_private_payment(
            &meta,
            &ephem_secret(3),
            750_000,
            "https://api.darknull.example/service/3",
            &mut tree,
        )
        .unwrap();

        let received = receive_private_payment(&alice_secret, &envelope, &tree)
            .unwrap()
            .unwrap();

        assert_eq!(received.gate_instruction.len(), 352);
        assert!(verify_gate_instruction_format(&received.gate_instruction));
    }

    // ── Test 4: devnet proof prefix is present ───────────────────────────────
    #[test]
    fn test_devnet_proof_prefix() {
        let alice_secret = spend_secret(4);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(4));

        let envelope = send_private_payment(
            &meta,
            &ephem_secret(4),
            250_000,
            "https://api.darknull.example/service/4",
            &mut tree,
        )
        .unwrap();

        let received = receive_private_payment(&alice_secret, &envelope, &tree)
            .unwrap()
            .unwrap();

        assert_eq!(
            received.gate_instruction[0], 0xDE,
            "devnet proof must start with 0xDE"
        );
        assert_eq!(
            received.gate_instruction[1], 0xAD,
            "devnet proof must have 0xAD as second byte"
        );
    }

    // ── Test 5: nullifier is non-zero and changes with different payments ────
    #[test]
    fn test_nullifiers_unique_per_payment() {
        let alice_secret = spend_secret(5);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(5));

        let e1 = send_private_payment(
            &meta,
            &ephem_secret(0xA1),
            100_000,
            "https://api.darknull.example/svc/a",
            &mut tree,
        )
        .unwrap();
        let e2 = send_private_payment(
            &meta,
            &ephem_secret(0xA2),
            100_000,
            "https://api.darknull.example/svc/b",
            &mut tree,
        )
        .unwrap();

        let r1 = receive_private_payment(&alice_secret, &e1, &tree)
            .unwrap()
            .unwrap();
        let r2 = receive_private_payment(&alice_secret, &e2, &tree)
            .unwrap()
            .unwrap();

        assert_ne!(
            r1.withdrawal.nullifier, r2.withdrawal.nullifier,
            "each payment must produce a unique nullifier"
        );
    }

    // ── Test 6: Merkle root in instruction matches tree root ────────────────
    #[test]
    fn test_merkle_root_matches_tree() {
        let alice_secret = spend_secret(6);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(6));

        let envelope = send_private_payment(
            &meta,
            &ephem_secret(6),
            300_000,
            "https://api.darknull.example/service/6",
            &mut tree,
        )
        .unwrap();

        let received = receive_private_payment(&alice_secret, &envelope, &tree)
            .unwrap()
            .unwrap();

        // Root in instruction data (bytes 256..288) must match tree root
        let ix_root: [u8; 32] = received.gate_instruction[256..288].try_into().unwrap();
        assert_eq!(
            ix_root, tree.root,
            "instruction Merkle root must match current tree root"
        );
    }

    // ── Test 7: amount in instruction data is correct ────────────────────────
    #[test]
    fn test_amount_in_instruction_data() {
        let alice_secret = spend_secret(7);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(7));

        let envelope = send_private_payment(
            &meta,
            &ephem_secret(7),
            987_654,
            "https://api.darknull.example/service/7",
            &mut tree,
        )
        .unwrap();

        let received = receive_private_payment(&alice_secret, &envelope, &tree)
            .unwrap()
            .unwrap();

        let amount = u64::from_le_bytes(received.gate_instruction[320..328].try_into().unwrap());
        assert_eq!(amount, 987_654u64);
    }

    // ── Test 8: multiple payments to same Alice — each independent ───────────
    #[test]
    fn test_multiple_payments_same_recipient() {
        let alice_secret = spend_secret(8);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(8));

        let e1 = send_private_payment(
            &meta,
            &ephem_secret(0xB1),
            100_000,
            "https://api.darknull.example/svc/1",
            &mut tree,
        )
        .unwrap();
        let e2 = send_private_payment(
            &meta,
            &ephem_secret(0xB2),
            200_000,
            "https://api.darknull.example/svc/2",
            &mut tree,
        )
        .unwrap();
        let e3 = send_private_payment(
            &meta,
            &ephem_secret(0xB3),
            300_000,
            "https://api.darknull.example/svc/3",
            &mut tree,
        )
        .unwrap();

        let r1 = receive_private_payment(&alice_secret, &e1, &tree)
            .unwrap()
            .unwrap();
        let r2 = receive_private_payment(&alice_secret, &e2, &tree)
            .unwrap()
            .unwrap();
        let r3 = receive_private_payment(&alice_secret, &e3, &tree)
            .unwrap()
            .unwrap();

        assert_eq!(r1.value, 100_000);
        assert_eq!(r2.value, 200_000);
        assert_eq!(r3.value, 300_000);
        assert_ne!(r1.withdrawal.nullifier, r2.withdrawal.nullifier);
        assert_ne!(r2.withdrawal.nullifier, r3.withdrawal.nullifier);
    }

    // ── Test 9: zero amount rejected ────────────────────────────────────────
    #[test]
    fn test_zero_amount_rejected() {
        let meta = create_meta_address(&spend_secret(9)).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(9));
        let err =
            send_private_payment(&meta, &ephem_secret(9), 0, "https://example.com", &mut tree)
                .unwrap_err();
        assert_eq!(err, PrivateX402Error::ZeroAmount);
    }

    // ── Test 10: zero receive secret rejected ────────────────────────────────
    #[test]
    fn test_zero_receive_secret_rejected() {
        let meta = create_meta_address(&spend_secret(10)).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(10));
        let envelope = send_private_payment(
            &meta,
            &ephem_secret(10),
            100_000,
            "https://example.com",
            &mut tree,
        )
        .unwrap();
        let err = receive_private_payment(&[0u8; 32], &envelope, &tree).unwrap_err();
        assert_eq!(err, PrivateX402Error::ZeroSecret);
    }

    // ── Test 11: service_scope_hash is deterministic ─────────────────────────
    #[test]
    fn test_service_scope_hash_deterministic() {
        let h1 = service_scope_hash("https://api.darknull.example/v1/pay");
        let h2 = service_scope_hash("https://api.darknull.example/v1/pay");
        assert_eq!(h1, h2);
        let h3 = service_scope_hash("https://api.darknull.example/v1/other");
        assert_ne!(h1, h3);
    }

    // ── Test 12: note commitment changes with service scope ──────────────────
    #[test]
    fn test_different_scope_different_commitment() {
        let meta = create_meta_address(&spend_secret(12)).unwrap();
        let ephem = ephem_secret(12);

        let mut tree1 = new_commitment_tree(&tree_nonce(0xC1));
        let mut tree2 = new_commitment_tree(&tree_nonce(0xC2));

        let e1 = send_private_payment(
            &meta,
            &ephem,
            100_000,
            "https://api.darknull.example/svc/A",
            &mut tree1,
        )
        .unwrap();
        let e2 = send_private_payment(
            &meta,
            &ephem,
            100_000,
            "https://api.darknull.example/svc/B",
            &mut tree2,
        )
        .unwrap();

        assert_ne!(
            e1.note.commitment, e2.note.commitment,
            "different service scopes must produce different note commitments"
        );
    }

    // ── Test 13: stealth payment fields are non-zero ─────────────────────────
    #[test]
    fn test_stealth_payment_fields_non_zero() {
        let meta = create_meta_address(&spend_secret(13)).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(13));
        let envelope = send_private_payment(
            &meta,
            &ephem_secret(13),
            50_000,
            "https://api.darknull.example/service/13",
            &mut tree,
        )
        .unwrap();

        // Stealth address must be a real curve point (not zero)
        assert_ne!(envelope.stealth_payment.stealth_addr.x, [0u8; 32]);
        assert_ne!(envelope.stealth_payment.ephem_pub.x, [0u8; 32]);
        assert!(!envelope.mainnet_ready);
    }

    // ── Test 14: one-time spend key is non-zero ──────────────────────────────
    #[test]
    fn test_one_time_spend_key_nonzero() {
        let alice_secret = spend_secret(14);
        let meta = create_meta_address(&alice_secret).unwrap();
        let mut tree = new_commitment_tree(&tree_nonce(14));

        let envelope = send_private_payment(
            &meta,
            &ephem_secret(14),
            200_000,
            "https://api.darknull.example/service/14",
            &mut tree,
        )
        .unwrap();

        let received = receive_private_payment(&alice_secret, &envelope, &tree)
            .unwrap()
            .unwrap();

        assert_ne!(received.spend_key.one_time_secret, [0u8; 32]);
        assert!(!received.spend_key.mainnet_ready);
    }

    // ── Test 15: verify_gate_instruction_format rejects zero proof ───────────
    #[test]
    fn test_gate_instruction_format_validator() {
        let mut bad_ix = [0u8; 352];
        assert!(
            !verify_gate_instruction_format(&bad_ix),
            "all-zero instruction must fail format check"
        );

        bad_ix[0] = 0xDE;
        bad_ix[1] = 0xAD;
        bad_ix[256] = 0x01; // non-zero root
        bad_ix[288] = 0x02; // non-zero nullifier
        bad_ix[320] = 0x03; // non-zero amount
        assert!(
            verify_gate_instruction_format(&bad_ix),
            "well-formed instruction must pass format check"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_derive_randomness_scope_sensitive() {
        let ephem = ephem_secret(0xAA);
        let scope_a = service_scope_hash("https://api.darknull.example/svc/A");
        let scope_b = service_scope_hash("https://api.darknull.example/svc/B");
        let r1 = derive_randomness(&ephem, &scope_a);
        let r2 = derive_randomness(&ephem, &scope_b);
        assert_ne!(r1, r2, "different scopes must produce different randomness");
    }
}
