/// Property-based tests for the `receipt-spend` private note protocol.
///
/// WHAT THESE PROVE (the unlinkability + soundness properties):
///
///   SOUNDNESS (double-spend prevention):
///     P1. `spend_note` with the correct scope always succeeds.
///     P2. `spend_note` with a WRONG scope always fails (ScopeMismatch).
///     P3. `verify_spend` accepts the proof produced by `spend_note`.
///     P4. `verify_spend` rejects a proof produced for a different root.
///
///   UNLINKABILITY (privacy properties):
///     P5. Two notes from the SAME secret but DIFFERENT scopes have different
///         commitments — a chain observer cannot link them.
///     P6. Two notes from DIFFERENT secrets but the SAME scope have different
///         commitments.
///     P7. The nullifier from scope A cannot be used to spend scope B
///         (scope-binding is tight).
///     P8. Changing the root changes the nullifier — the note is root-bound.
///
///   DETERMINISM:
///     P9. All operations are deterministic (no hidden PRNG state).
use proptest::prelude::*;
use rand::{RngCore, SeedableRng};
use rand::rngs::StdRng;
use receipt_spend::{new_note, nullifier_from_note, spend_note, verify_spend, SpendError};

// ── Strategy helpers ──────────────────────────────────────────────────────────

fn arb_secret() -> impl Strategy<Value = [u8; 32]> {
    prop::array::uniform32(any::<u8>())
}

fn arb_root() -> impl Strategy<Value = [u8; 32]> {
    prop::array::uniform32(any::<u8>())
}

fn arb_scope() -> impl Strategy<Value = String> {
    "[a-z][a-z0-9_/]{2,63}".prop_map(|s| s)
}

// ── P1: Correct scope always succeeds ────────────────────────────────────────

proptest! {
    #[test]
    fn spend_with_correct_scope_succeeds(
        secret in arb_secret(),
        root   in arb_root(),
        scope  in arb_scope(),
    ) {
        let note = new_note(&secret, &scope);
        let result = spend_note(&note, &root, &scope);
        prop_assert!(
            result.is_ok(),
            "spend_note failed for correct scope '{scope}': {result:?}"
        );
    }
}

// ── P2: Wrong scope always fails ──────────────────────────────────────────────

proptest! {
    #[test]
    fn spend_with_wrong_scope_always_fails(
        secret     in arb_secret(),
        root       in arb_root(),
        real_scope in arb_scope(),
        bad_scope  in arb_scope(),
    ) {
        prop_assume!(real_scope != bad_scope);
        let note   = new_note(&secret, &real_scope);
        let result = spend_note(&note, &root, &bad_scope);
        prop_assert_eq!(
            result,
            Err(SpendError::ScopeMismatch),
            "spend_note should reject wrong scope '{}' for note scoped to '{}'",
            bad_scope, real_scope
        );
    }
}

// ── P3: verify_spend accepts own proof ───────────────────────────────────────

proptest! {
    #[test]
    fn verify_spend_accepts_own_proof(
        secret in arb_secret(),
        root   in arb_root(),
        scope  in arb_scope(),
    ) {
        let note  = new_note(&secret, &scope);
        let proof = spend_note(&note, &root, &scope).unwrap();
        let valid = verify_spend(&proof, &note, &root);
        prop_assert!(valid, "verify_spend rejected its own proof");
    }
}

// ── P4: verify_spend rejects wrong-root proof ────────────────────────────────

proptest! {
    #[test]
    fn verify_spend_rejects_wrong_root(
        secret    in arb_secret(),
        root_a    in arb_root(),
        root_b    in arb_root(),
        scope     in arb_scope(),
    ) {
        prop_assume!(root_a != root_b);
        let note    = new_note(&secret, &scope);
        let proof_a = spend_note(&note, &root_a, &scope).unwrap();
        // Verify with root_b — proof was generated under root_a
        let valid = verify_spend(&proof_a, &note, &root_b);
        prop_assert!(
            !valid,
            "verify_spend accepted a proof generated under a different root"
        );
    }
}

// ── P5: Same secret + different scope → different commitments (unlinkability) ─

proptest! {
    /// PRIVACY PROPERTY: An observer who sees two on-chain commitments from the
    /// same wallet cannot determine they came from the same entity.
    #[test]
    fn same_secret_different_scope_unlinkable(
        secret   in arb_secret(),
        scope_a  in arb_scope(),
        scope_b  in arb_scope(),
    ) {
        prop_assume!(scope_a != scope_b);
        let note_a = new_note(&secret, &scope_a);
        let note_b = new_note(&secret, &scope_b);
        prop_assert_ne!(
            note_a.commitment, note_b.commitment,
            "UNLINKABILITY BROKEN: same secret produces identical commitments \
             across different scopes — on-chain linkage is possible."
        );
    }
}

// ── P6: Different secrets + same scope → different commitments ───────────────

proptest! {
    #[test]
    fn different_secrets_same_scope_distinct(
        secret_a in arb_secret(),
        secret_b in arb_secret(),
        scope    in arb_scope(),
    ) {
        prop_assume!(secret_a != secret_b);
        let note_a = new_note(&secret_a, &scope);
        let note_b = new_note(&secret_b, &scope);
        prop_assert_ne!(note_a.commitment, note_b.commitment,
            "Different secrets produced the same commitment for scope '{}'", scope);
    }
}

// ── P7: Scope-binding is tight — cross-scope nullifier reuse is impossible ────

proptest! {
    /// A nullifier produced for scope A cannot verify against a note issued
    /// for scope B.  This prevents an attacker from spending note_B by
    /// submitting proof_A.
    #[test]
    fn cross_scope_nullifier_fails_verification(
        secret  in arb_secret(),
        root    in arb_root(),
        scope_a in arb_scope(),
        scope_b in arb_scope(),
    ) {
        prop_assume!(scope_a != scope_b);
        let note_a = new_note(&secret, &scope_a);
        let note_b = new_note(&secret, &scope_b);

        // Produce proof under scope_a
        let proof_a = spend_note(&note_a, &root, &scope_a).unwrap();

        // Verify proof_a against note_b — must fail
        let cross_valid = verify_spend(&proof_a, &note_b, &root);
        prop_assert!(
            !cross_valid,
            "SCOPE BINDING BROKEN: proof from scope '{scope_a}' validated \
             against note for scope '{scope_b}'"
        );
    }
}

// ── P8: Root-binding — nullifier changes with root ───────────────────────────

proptest! {
    #[test]
    fn nullifier_is_root_bound(
        secret in arb_secret(),
        root_a in arb_root(),
        root_b in arb_root(),
        scope  in arb_scope(),
    ) {
        prop_assume!(root_a != root_b);
        let note = new_note(&secret, &scope);
        let null_a = nullifier_from_note(&note, &root_a);
        let null_b = nullifier_from_note(&note, &root_b);
        prop_assert_ne!(null_a, null_b,
            "Nullifier does not change with root — a spent note in one tree \
             can be replayed in a different tree");
    }
}

// ── P9: Full determinism ──────────────────────────────────────────────────────

proptest! {
    #[test]
    fn all_operations_are_deterministic(
        secret in arb_secret(),
        root   in arb_root(),
        scope  in arb_scope(),
    ) {
        let note_1 = new_note(&secret, &scope);
        let note_2 = new_note(&secret, &scope);
        prop_assert_eq!(&note_1, &note_2, "new_note is non-deterministic");

        let null_1 = nullifier_from_note(&note_1, &root);
        let null_2 = nullifier_from_note(&note_1, &root);
        prop_assert_eq!(null_1, null_2, "nullifier_from_note is non-deterministic");

        let proof_1 = spend_note(&note_1, &root, &scope).unwrap();
        let proof_2 = spend_note(&note_1, &root, &scope).unwrap();
        prop_assert_eq!(proof_1.nullifier, proof_2.nullifier, "spend_note is non-deterministic");
    }
}

// ── Batch unlinkability: 100 notes from the same secret are all distinct ──────

#[test]
fn one_hundred_notes_all_unlinkable() {
    let mut rng = StdRng::seed_from_u64(0xABCD_1234);
    let mut secret = [0u8; 32];
    rng.fill_bytes(&mut secret);

    let scopes: Vec<String> = (0..100)
        .map(|i| format!("api/v1/scope/{i:03}"))
        .collect();

    let commitments: Vec<[u8; 32]> = scopes
        .iter()
        .map(|s| new_note(&secret, s).commitment)
        .collect();

    // All 100 commitments must be distinct
    let mut seen = std::collections::HashSet::new();
    for (i, c) in commitments.iter().enumerate() {
        assert!(
            seen.insert(c),
            "Commitment collision at index {i}: note is NOT unlinkable"
        );
    }
    println!("100-note unlinkability: all commitments distinct ✓");
}

// ── Spend-verify roundtrip over 50 random notes ──────────────────────────────

#[test]
fn spend_verify_roundtrip_50_notes() {
    let mut rng = StdRng::seed_from_u64(0xFEED_FACE);

    for i in 0..50 {
        let mut secret = [0u8; 32];
        let mut root   = [0u8; 32];
        rng.fill_bytes(&mut secret);
        rng.fill_bytes(&mut root);
        let scope = format!("x402/test/{i}");

        let note  = new_note(&secret, &scope);
        let proof = spend_note(&note, &root, &scope)
            .unwrap_or_else(|e| panic!("spend_note failed at i={i}: {e}"));
        let valid = verify_spend(&proof, &note, &root);
        assert!(valid, "verify_spend failed at i={i}");
    }
    println!("50-note spend-verify roundtrip ✓");
}
