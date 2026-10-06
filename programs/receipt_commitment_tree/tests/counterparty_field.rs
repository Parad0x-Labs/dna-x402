//! settle_and_record with recipient pubkeys at or above the BN254 scalar modulus r.
//! Before the fix the raw key bytes went into sol_poseidon, which rejects inputs >= r
//! (Custom(20)) for ~81% of keys. The leaf now uses counterparty = Poseidon2(hi128, lo128).
//! Each test recomputes the leaf + root off-chain and compares it to the on-chain root.
use receipt_commitment_tree::{counterparty_field, process_instruction};
use solana_program::poseidon::{hashv, Endianness, Parameters};
use solana_program_test::{processor, BanksClient, ProgramTest};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};

const TREE_SEED: &[u8] = b"receipt_tree";
const DEPTH: usize = 10;
const O_ROOTS: usize = 42 + 2 * DEPTH * 32;

/// BN254 scalar field modulus r, big-endian.
const R_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn p(inputs: &[&[u8; 32]]) -> [u8; 32] {
    let v: Vec<&[u8]> = inputs.iter().map(|x| x.as_slice()).collect();
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &v).unwrap().to_bytes()
}

fn be32(x: u64) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[24..].copy_from_slice(&x.to_be_bytes());
    o
}

fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if d < 0 { d += 256; 1 } else { 0 };
        out[i] = d as u8;
    }
    assert_eq!(borrow, 0);
    out
}

fn ge_r(k: &[u8; 32]) -> bool {
    k.as_slice() >= R_BE.as_slice()
}

/// Root after inserting `leaf` at index 0 of an empty depth-10 tree.
fn root_with_first_leaf(leaf: [u8; 32]) -> [u8; 32] {
    let mut zero = [0u8; 32];
    let mut cur = leaf;
    for _ in 0..DEPTH {
        cur = p(&[&cur, &zero]);
        zero = p(&[&zero, &zero]);
    }
    cur
}

async fn setup(tree_id: [u8; 8]) -> (BanksClient, Keypair, Pubkey, Pubkey) {
    let program_id = Pubkey::new_unique();
    let pt = ProgramTest::new("receipt_commitment_tree", program_id, processor!(process_instruction));
    let (mut banks, payer, recent) = pt.start().await;
    let (tree, _) = Pubkey::find_program_address(&[TREE_SEED, &tree_id], &program_id);
    let mut d = vec![0x00u8];
    d.extend_from_slice(&tree_id);
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(tree, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: d,
    };
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], recent);
    banks.process_transaction(tx).await.expect("init");
    (banks, payer, program_id, tree)
}

async fn settle_and_check(recipient: Pubkey) {
    let tree_id = [4u8; 8];
    let (mut banks, payer, program_id, tree) = setup(tree_id).await;
    let agent = [9u8; 32];
    let nonce = [3u8; 32];
    let amount = 1_000_000u64;
    let mut d = vec![0x02u8];
    d.extend_from_slice(&tree_id);
    d.extend_from_slice(&agent);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&[0xEEu8; 32]); // ignored by the program
    d.extend_from_slice(&nonce);
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(recipient, false),
            AccountMeta::new(tree, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: d,
    };
    let bh = banks.get_latest_blockhash().await.unwrap();
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], bh);
    let res = banks.process_transaction_with_metadata(tx).await.unwrap();
    res.result.clone().expect("settle_and_record must succeed for any recipient key");
    let logs = res.metadata.expect("metadata").log_messages;
    let ts: u64 = logs
        .iter()
        .find_map(|l| l.split("ts=").nth(1).map(|t| t.trim().parse().unwrap()))
        .expect("ts logged");

    // Off-chain recomputation with the documented encoding.
    let b = recipient.to_bytes();
    let mut hi = [0u8; 32];
    hi[16..].copy_from_slice(&b[..16]);
    let mut lo = [0u8; 32];
    lo[16..].copy_from_slice(&b[16..]);
    let cp = p(&[&hi, &lo]);
    assert_eq!(cp, counterparty_field(&recipient).unwrap());
    let leaf = p(&[&agent, &be32(amount), &be32(ts), &cp, &nonce]);
    let expected = root_with_first_leaf(leaf);

    let acc = banks.get_account(tree).await.unwrap().unwrap();
    let ridx = acc.data[40] as usize;
    assert_eq!(ridx, 1);
    assert_eq!(&acc.data[O_ROOTS + 32..O_ROOTS + 64], &expected, "on-chain root == off-chain root");
    assert_eq!(banks.get_balance(recipient).await.unwrap(), amount);
}

#[tokio::test]
async fn recipient_key_all_ff_above_modulus() {
    let k = Pubkey::new_from_array([0xFFu8; 32]);
    assert!(ge_r(&k.to_bytes()));
    settle_and_check(k).await;
}

#[tokio::test]
async fn recipient_key_just_above_modulus() {
    // r + 5
    let mut k = R_BE;
    k[31] += 5;
    assert!(ge_r(&k));
    settle_and_check(Pubkey::new_from_array(k)).await;
}

#[tokio::test]
async fn recipient_key_below_modulus() {
    let mut k = [0x11u8; 32];
    k[0] = 0x01;
    assert!(!ge_r(&k));
    settle_and_check(Pubkey::new_from_array(k)).await;
}

#[test]
fn encoding_is_not_reduction_mod_r() {
    // k and k - r would collide under reduction mod r; the hash keeps them apart.
    let k = [0xFFu8; 32];
    let k_minus_r = sub_be(&k, &R_BE);
    let a = counterparty_field(&Pubkey::new_from_array(k)).unwrap();
    let b = counterparty_field(&Pubkey::new_from_array(k_minus_r)).unwrap();
    assert_ne!(a, b);
}

#[test]
fn raw_key_above_modulus_is_rejected_by_poseidon() {
    // Documents the original failure mode: the raw key is not a valid field element.
    let k = [0xFFu8; 32];
    assert!(hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&k[..], &[0u8; 32][..]]).is_err());
}
