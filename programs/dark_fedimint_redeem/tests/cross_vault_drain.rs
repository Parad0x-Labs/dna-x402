//! Regression test for the CROSS-VAULT DRAIN vulnerability (DEVNET-confirmed).
//!
//! Before the fix, `process_redeem` debited whatever `reserve_vault` account was
//! passed without checking it is the PDA bound to the passed `mint_config`. An
//! attacker could stand up their OWN cheap federation (so the DLEQ verifies and
//! the nullifier PDA is namespaced to their config) yet point `reserve_vault` at
//! a DIFFERENT federation's reserve — every reserve vault is program-owned, so
//! the unchecked lamport debit drained the victim.
//!
//! The fix re-derives `PDA([RESERVE_VAULT_SEED, mint_config])` and rejects any
//! mismatch with `InvalidArgument` BEFORE touching lamports — the same guard
//! `process_fund` already enforces.
//!
//! Live proof of the same scenario runs on devnet via
//! `build/enull/mayhem-devnet.mjs` (ATTACK 15, `cross_vault_drain`).
//!
//! NOTE: programs using `solana-program-test` trigger the rbpf 0.8.x
//! pointer-overflow bug on Windows (STATUS_STACK_BUFFER_OVERRUN); these tests are
//! correct and run on Linux/macOS CI, and are gated off Windows to match the rest
//! of the workspace.
#![cfg(not(target_os = "windows"))]

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::scalar::Scalar;
use dark_fedimint_ecash::{bdhke::hash_to_curve, dleq::prove_dleq};
use dark_fedimint_redeem_program::{
    instruction::RedeemInstruction,
    processor::{
        self, MINT_CONFIG_SEED, NULLIFIER_SEED, RESERVE_VAULT_SEED,
    },
    state::{MintConfig, MINT_CONFIG_LEN, MINT_CONFIG_VERSION},
};
use rand::rngs::OsRng;
use rand::RngCore;
use solana_program::{hash::hashv, program_pack::Pack, pubkey::Pubkey};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    signature::Signer,
    transaction::Transaction,
};

const DENOM: u64 = 2_000_000; // lamports paid per redeemed token
const VAULT_FUNDING: u64 = 50_000_000; // comfortably > a few denominations + rent

fn rand_scalar() -> Scalar {
    let mut wide = [0u8; 64];
    OsRng.fill_bytes(&mut wide);
    Scalar::from_bytes_mod_order_wide(&wide)
}

/// Build a VALID `(y, c, dleq)` redeem artifact for mint secret `k` — exactly
/// what the host federation emits, so the on-chain DLEQ verifies.
fn issue_token(k: &Scalar, secret: &[u8]) -> ([u8; 32], [u8; 32], [u8; 64]) {
    let y_pt = hash_to_curve(secret);
    let c = (k * y_pt).compress().to_bytes();
    let y = y_pt.compress().to_bytes();
    let proof = prove_dleq(k, &y_pt, rand_scalar());
    (y, c, proof.to_bytes())
}

/// Mirror of `processor::nullifier_of`: SHA256("eNULL-NULLIFIER-v1" ‖ Y).
fn nullifier_of(y: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"eNULL-NULLIFIER-v1", y]).to_bytes()
}

/// A program-owned `MintConfig` account, pre-initialized with `group_pub = K`.
fn config_account(
    group_pub: [u8; 32],
    authority: Pubkey,
    config_bump: u8,
    vault_bump: u8,
    program_id: Pubkey,
) -> Account {
    let cfg = MintConfig {
        version: MINT_CONFIG_VERSION,
        bump: config_bump,
        is_initialized: true,
        authority: authority.to_bytes(),
        group_pub,
        denomination: DENOM,
        vault_bump,
        redeemed_count: 0,
    };
    let mut data = vec![0u8; MINT_CONFIG_LEN];
    MintConfig::pack(cfg, &mut data).expect("pack config");
    Account {
        lamports: 10_000_000, // rent-exempt for 85 bytes with margin
        data,
        owner: program_id,
        executable: false,
        rent_epoch: 0,
    }
}

/// A program-owned, funded reserve vault (0-byte data, like the real one).
fn vault_account(program_id: Pubkey) -> Account {
    Account {
        lamports: VAULT_FUNDING,
        data: vec![],
        owner: program_id,
        executable: false,
        rent_epoch: 0,
    }
}

#[allow(clippy::too_many_arguments)]
fn redeem_ix(
    program_id: Pubkey,
    config: Pubkey,
    reserve_vault: Pubkey,
    nullifier_pda: Pubkey,
    recipient: Pubkey,
    fee_payer: Pubkey,
    y: [u8; 32],
    c: [u8; 32],
    dleq: [u8; 64],
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(config, false),
            AccountMeta::new(reserve_vault, false),
            AccountMeta::new(nullifier_pda, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new(fee_payer, true),
            AccountMeta::new_readonly(solana_program::system_program::id(), false),
        ],
        data: RedeemInstruction::Redeem { y, c, dleq }.pack(),
    }
}

fn program_test(program_id: Pubkey) -> ProgramTest {
    ProgramTest::new(
        "dark_fedimint_redeem_program",
        program_id,
        processor!(processor::process_instruction),
    )
}

// ── THE EXPLOIT: a valid token for config A must NOT drain config B's vault ──────
#[tokio::test]
async fn cross_vault_drain_is_rejected() {
    let program_id = Pubkey::new_unique();
    let mut pt = program_test(program_id);

    // Attacker's OWN federation (config A) with a real group key K_A.
    let k_a = rand_scalar();
    let k_a_pub = (k_a * G).compress().to_bytes();
    let authority_a = Pubkey::new_unique();
    let (config_a, config_a_bump) =
        Pubkey::find_program_address(&[MINT_CONFIG_SEED, authority_a.as_ref()], &program_id);
    let (_vault_a, vault_a_bump) =
        Pubkey::find_program_address(&[RESERVE_VAULT_SEED, config_a.as_ref()], &program_id);
    pt.add_account(
        config_a,
        config_account(k_a_pub, authority_a, config_a_bump, vault_a_bump, program_id),
    );

    // Victim federation (config B) and its funded reserve vault — the drain target.
    let authority_b = Pubkey::new_unique();
    let (config_b, _) =
        Pubkey::find_program_address(&[MINT_CONFIG_SEED, authority_b.as_ref()], &program_id);
    let (victim_vault, _) =
        Pubkey::find_program_address(&[RESERVE_VAULT_SEED, config_b.as_ref()], &program_id);
    pt.add_account(victim_vault, vault_account(program_id));

    let (mut banks, payer, blockhash) = pt.start().await;

    // A genuinely valid token under K_A (DLEQ passes), nullifier PDA namespaced to
    // config A so we reach the vault-binding guard.
    let (y, c, dleq) = issue_token(&k_a, b"cross-vault-attacker-token");
    let null = nullifier_of(&y);
    let (null_pda, _) =
        Pubkey::find_program_address(&[NULLIFIER_SEED, config_a.as_ref(), &null], &program_id);
    let recipient = Pubkey::new_unique();

    let victim_before = banks
        .get_account(victim_vault)
        .await
        .unwrap()
        .unwrap()
        .lamports;

    // cfg = config A (DLEQ verifies), reserve_vault = config B's vault (mismatch).
    let ix = redeem_ix(
        program_id,
        config_a,
        victim_vault,
        null_pda,
        recipient,
        payer.pubkey(),
        y,
        c,
        dleq,
    );
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], blockhash);
    let result = banks.process_transaction(tx).await;

    assert!(
        result.is_err(),
        "cross-vault redeem MUST be rejected, got Ok (vault drained)"
    );
    let err_str = format!("{:?}", result);
    assert!(
        err_str.contains("InvalidArgument"),
        "expected InvalidArgument (vault-binding guard), got: {}",
        err_str
    );

    // The victim vault must be untouched — not a single lamport moved.
    let victim_after = banks
        .get_account(victim_vault)
        .await
        .unwrap()
        .unwrap()
        .lamports;
    assert_eq!(
        victim_after, victim_before,
        "victim vault balance changed — drain not fully prevented"
    );
    // And the nullifier must NOT have been burned (no record created).
    assert!(
        banks.get_account(null_pda).await.unwrap().is_none(),
        "nullifier PDA was created even though redeem was rejected"
    );
}

// ── Guard is not over-broad: the MATCHING vault still redeems successfully ───────
#[tokio::test]
async fn matching_reserve_vault_still_redeems() {
    let program_id = Pubkey::new_unique();
    let mut pt = program_test(program_id);

    let k = rand_scalar();
    let k_pub = (k * G).compress().to_bytes();
    let authority = Pubkey::new_unique();
    let (config, config_bump) =
        Pubkey::find_program_address(&[MINT_CONFIG_SEED, authority.as_ref()], &program_id);
    let (vault, vault_bump) =
        Pubkey::find_program_address(&[RESERVE_VAULT_SEED, config.as_ref()], &program_id);
    pt.add_account(
        config,
        config_account(k_pub, authority, config_bump, vault_bump, program_id),
    );
    pt.add_account(vault, vault_account(program_id)); // the CORRECT, bound vault

    let (mut banks, payer, blockhash) = pt.start().await;

    let (y, c, dleq) = issue_token(&k, b"happy-path-token");
    let null = nullifier_of(&y);
    let (null_pda, _) =
        Pubkey::find_program_address(&[NULLIFIER_SEED, config.as_ref(), &null], &program_id);
    let recipient = Pubkey::new_unique();

    let vault_before = banks.get_account(vault).await.unwrap().unwrap().lamports;

    let ix = redeem_ix(
        program_id,
        config,
        vault,
        null_pda,
        recipient,
        payer.pubkey(),
        y,
        c,
        dleq,
    );
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], blockhash);
    banks
        .process_transaction(tx)
        .await
        .expect("valid redeem against the bound vault must succeed");

    // Recipient funded exactly one denomination; vault debited exactly one.
    let recipient_bal = banks
        .get_account(recipient)
        .await
        .unwrap()
        .unwrap()
        .lamports;
    assert_eq!(recipient_bal, DENOM, "recipient must receive one denomination");
    let vault_after = banks.get_account(vault).await.unwrap().unwrap().lamports;
    assert_eq!(
        vault_before - vault_after,
        DENOM,
        "vault must be debited exactly one denomination"
    );
    // Nullifier is now burned.
    assert!(
        banks.get_account(null_pda).await.unwrap().is_some(),
        "nullifier PDA should exist after a successful redeem"
    );
}

// ── recipient == reserve_vault must be rejected (no token-burn for zero payout) ──
//
// A valid token against its OWN bound vault, but `recipient` is set to the reserve
// vault itself. The two lamport mutations would cancel (vault pays itself) while the
// nullifier is still created — burning a single-use token for a net-zero payout.
// The guard must reject with `RedeemError::RecipientIsReserveVault` (Custom 10)
// BEFORE the nullifier is minted, so the token survives.
#[tokio::test]
async fn recipient_equals_reserve_vault_is_rejected() {
    // RedeemError::RecipientIsReserveVault discriminant (see error.rs).
    const RECIPIENT_IS_RESERVE_VAULT: u32 = 10;

    let program_id = Pubkey::new_unique();
    let mut pt = program_test(program_id);

    let k = rand_scalar();
    let k_pub = (k * G).compress().to_bytes();
    let authority = Pubkey::new_unique();
    let (config, config_bump) =
        Pubkey::find_program_address(&[MINT_CONFIG_SEED, authority.as_ref()], &program_id);
    let (vault, vault_bump) =
        Pubkey::find_program_address(&[RESERVE_VAULT_SEED, config.as_ref()], &program_id);
    pt.add_account(
        config,
        config_account(k_pub, authority, config_bump, vault_bump, program_id),
    );
    pt.add_account(vault, vault_account(program_id)); // correct, bound vault

    let (mut banks, payer, blockhash) = pt.start().await;

    let (y, c, dleq) = issue_token(&k, b"self-pay-token");
    let null = nullifier_of(&y);
    let (null_pda, _) =
        Pubkey::find_program_address(&[NULLIFIER_SEED, config.as_ref(), &null], &program_id);

    let vault_before = banks.get_account(vault).await.unwrap().unwrap().lamports;

    // recipient == the reserve vault itself.
    let ix = redeem_ix(
        program_id, config, vault, null_pda, /* recipient = */ vault, payer.pubkey(), y, c, dleq,
    );
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], blockhash);
    let result = banks.process_transaction(tx).await;

    assert!(
        result.is_err(),
        "recipient==reserve_vault MUST be rejected, got Ok (token burned for zero payout)"
    );
    let err_str = format!("{:?}", result);
    assert!(
        err_str.contains(&format!("Custom({})", RECIPIENT_IS_RESERVE_VAULT)),
        "expected Custom({}) RecipientIsReserveVault, got: {}",
        RECIPIENT_IS_RESERVE_VAULT,
        err_str
    );

    // Vault untouched and — crucially — the nullifier was NOT burned.
    let vault_after = banks.get_account(vault).await.unwrap().unwrap().lamports;
    assert_eq!(
        vault_after, vault_before,
        "vault balance changed on a rejected self-pay"
    );
    assert!(
        banks.get_account(null_pda).await.unwrap().is_none(),
        "nullifier PDA was created even though the self-pay redeem was rejected — token burned"
    );
}
