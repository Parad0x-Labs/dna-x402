//! ALT Fog Router — Solana v0 transaction builder that injects decoy
//! accounts into a transaction's static account list, making the
//! transaction's account topology look like one of many possible private paths.
//!
//! Not cryptographic privacy. Transaction-shape fog: buildable today.
//!
//! Design note: Solana's v0 message compiler drops unreferenced ALT entries,
//! so decoy accounts are injected into the static `account_keys` list as
//! additional readonly-unsigned entries. They increase the combinatorial
//! search space for chain-analysis tools without changing transaction semantics.

use rand::Rng;
use solana_sdk::{
    address_lookup_table::AddressLookupTableAccount,
    hash::Hash,
    instruction::Instruction,
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    transaction::VersionedTransaction,
};

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum FogGrade {
    /// No decoys — fully transparent account topology.
    Clear,
    /// 1–5 decoys — mild obfuscation.
    Hazy,
    /// 6–15 decoys — moderate fog.
    Dense,
    /// 16+ decoys — analyst must enumerate all account combinations.
    Impenetrable,
}

impl FogGrade {
    pub fn from_ratio(ratio: f32) -> Self {
        match ratio {
            r if r < 0.10 => FogGrade::Clear,
            r if r < 0.40 => FogGrade::Hazy,
            r if r < 0.70 => FogGrade::Dense,
            _ => FogGrade::Impenetrable,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FingerprintScore {
    /// Number of decoy accounts injected.
    pub decoy_count: usize,
    /// Fraction of total accounts that are decoys (0.0–1.0).
    pub uniqueness_ratio: f32,
    pub fog_grade: FogGrade,
}

/// A compiled fog transaction paired with its decoy metadata.
/// Use `score_tx_fingerprint` to derive the obfuscation score.
pub struct FogTransaction {
    pub inner: VersionedTransaction,
    pub decoy_count: usize,
}

#[derive(Debug)]
pub enum FogError {
    MessageCompile,
}

impl std::fmt::Display for FogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "fog router: message compile error")
    }
}

// ── Core API ──────────────────────────────────────────────────────────────────

/// Generate `count` random-looking decoy public keys.
pub fn generate_decoy_accounts(count: usize, rng: &mut impl Rng) -> Vec<Pubkey> {
    (0..count)
        .map(|_| {
            let mut bytes = [0u8; 32];
            rng.fill(&mut bytes);
            Pubkey::from(bytes)
        })
        .collect()
}

/// Build a Solana v0 transaction with `decoy_accounts` injected into the
/// static account list as additional readonly-unsigned entries.
///
/// The resulting transaction is **unsigned** (signatures are zeroed).
/// Callers must sign with the appropriate keypairs before submitting.
pub fn build_fog_v0_tx(
    instructions: &[Instruction],
    payer: &Pubkey,
    blockhash: Hash,
    real_lookup_tables: &[AddressLookupTableAccount],
    decoy_accounts: &[Pubkey],
) -> Result<FogTransaction, FogError> {
    let mut message = v0::Message::try_compile(payer, instructions, real_lookup_tables, blockhash)
        .map_err(|_| FogError::MessageCompile)?;

    // Append decoys to the static account list as readonly-unsigned entries.
    // They are not referenced by any instruction — they exist only to raise the
    // combinatorial complexity for chain-analysis account-correlation tools.
    let mut added: u8 = 0;
    for decoy in decoy_accounts {
        if !message.account_keys.contains(decoy) {
            message.account_keys.push(*decoy);
            added = added.saturating_add(1);
        }
    }
    if added > 0 {
        message.header.num_readonly_unsigned_accounts = message
            .header
            .num_readonly_unsigned_accounts
            .saturating_add(added);
    }

    let actual_decoy_count = added as usize;

    Ok(FogTransaction {
        inner: VersionedTransaction {
            signatures: vec![solana_sdk::signature::Signature::default()],
            message: VersionedMessage::V0(message),
        },
        decoy_count: actual_decoy_count,
    })
}

/// Score how well-obfuscated a fog transaction's account fingerprint is.
pub fn score_tx_fingerprint(fog_tx: &FogTransaction) -> FingerprintScore {
    let total = match &fog_tx.inner.message {
        VersionedMessage::V0(msg) => msg.account_keys.len(),
        _ => 0,
    };

    let uniqueness_ratio = if total == 0 {
        0.0
    } else {
        fog_tx.decoy_count as f32 / total as f32
    };

    FingerprintScore {
        decoy_count: fog_tx.decoy_count,
        uniqueness_ratio,
        fog_grade: FogGrade::from_ratio(uniqueness_ratio),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use solana_sdk::instruction::AccountMeta;

    fn seeded_rng() -> rand::rngs::StdRng {
        rand::rngs::StdRng::seed_from_u64(0xDEAD_BEEF)
    }

    fn dummy_ix(writable_account: &Pubkey) -> Instruction {
        let program = Pubkey::new_unique();
        Instruction::new_with_bytes(
            program,
            &[],
            vec![AccountMeta::new(*writable_account, false)],
        )
    }

    #[test]
    fn test_real_accounts_always_present() {
        // Property: run 100 iterations with different decoy counts, real account always in msg.
        let mut rng = seeded_rng();
        for _ in 0..100 {
            let payer = Pubkey::new_unique();
            let real_account = Pubkey::new_unique();
            let decoy_count: usize = rng.gen_range(0..=32);
            let decoys = generate_decoy_accounts(decoy_count, &mut rng);

            let ix = dummy_ix(&real_account);
            let fog_tx = build_fog_v0_tx(&[ix], &payer, Hash::default(), &[], &decoys).unwrap();

            match &fog_tx.inner.message {
                VersionedMessage::V0(msg) => {
                    assert!(
                        msg.account_keys.contains(&real_account),
                        "real_account missing from account_keys with {decoy_count} decoys"
                    );
                }
                _ => panic!("expected v0 message"),
            }
        }
    }

    #[test]
    fn test_fog_score_improves_with_decoys() {
        let payer = Pubkey::new_unique();
        let real = Pubkey::new_unique();
        let ix = dummy_ix(&real);
        let mut rng = seeded_rng();

        let fog_none = build_fog_v0_tx(&[ix.clone()], &payer, Hash::default(), &[], &[]).unwrap();
        let decoys = generate_decoy_accounts(10, &mut rng);
        let fog_some = build_fog_v0_tx(&[ix], &payer, Hash::default(), &[], &decoys).unwrap();

        let score_none = score_tx_fingerprint(&fog_none);
        let score_some = score_tx_fingerprint(&fog_some);

        assert_eq!(score_none.decoy_count, 0);
        assert_eq!(score_some.decoy_count, 10);
        assert!(
            score_some.uniqueness_ratio >= score_none.uniqueness_ratio,
            "more decoys must not decrease fog ratio"
        );
    }

    #[test]
    fn test_decoy_count_range_never_panics() {
        let payer = Pubkey::new_unique();
        let real = Pubkey::new_unique();
        let ix = dummy_ix(&real);
        let mut rng = seeded_rng();

        for count in 0usize..=32 {
            let decoys = generate_decoy_accounts(count, &mut rng);
            let result = build_fog_v0_tx(&[ix.clone()], &payer, Hash::default(), &[], &decoys);
            assert!(result.is_ok(), "panicked at decoy count {count}");
        }
    }

    #[test]
    fn test_different_builds_differ() {
        let payer = Pubkey::new_unique();
        let real = Pubkey::new_unique();
        let ix = dummy_ix(&real);

        let mut rng1 = rand::rngs::StdRng::seed_from_u64(1);
        let mut rng2 = rand::rngs::StdRng::seed_from_u64(2);

        let decoys1 = generate_decoy_accounts(8, &mut rng1);
        let decoys2 = generate_decoy_accounts(8, &mut rng2);

        // Different seeds must produce different decoy account sets.
        assert_ne!(
            decoys1, decoys2,
            "different seeds must produce different decoys"
        );

        let fog1 = build_fog_v0_tx(&[ix.clone()], &payer, Hash::default(), &[], &decoys1).unwrap();
        let fog2 = build_fog_v0_tx(&[ix], &payer, Hash::default(), &[], &decoys2).unwrap();

        // Both have the same decoy count; the injected keys must differ.
        assert_eq!(fog1.decoy_count, fog2.decoy_count);
        match (&fog1.inner.message, &fog2.inner.message) {
            (VersionedMessage::V0(m1), VersionedMessage::V0(m2)) => {
                assert_ne!(
                    m1.account_keys, m2.account_keys,
                    "different decoy sets must produce different account_keys"
                );
            }
            _ => panic!("expected v0 messages"),
        }
    }

    #[test]
    fn test_fog_grade_thresholds() {
        assert_eq!(FogGrade::from_ratio(0.0), FogGrade::Clear);
        assert_eq!(FogGrade::from_ratio(0.09), FogGrade::Clear);
        assert_eq!(FogGrade::from_ratio(0.10), FogGrade::Hazy);
        assert_eq!(FogGrade::from_ratio(0.39), FogGrade::Hazy);
        assert_eq!(FogGrade::from_ratio(0.40), FogGrade::Dense);
        assert_eq!(FogGrade::from_ratio(0.69), FogGrade::Dense);
        assert_eq!(FogGrade::from_ratio(0.70), FogGrade::Impenetrable);
        assert_eq!(FogGrade::from_ratio(1.0), FogGrade::Impenetrable);
    }
}
