// CPI example: a calling program runs a giveaway through null_fair_draw.
//
// The caller's PDA ["giveaway"] is the organizer and the funder: one caller
// instruction creates the draw, escrows the prizes and commits the entry list
// with `invoke_signed`. Draw, Resolve and Claim are permissionless and run
// directly. The same code is the README's CPI example.
#![cfg(not(target_os = "windows"))]

use null_fair_draw::{
    instruction::{self as fd, CreateParams, LeafProof},
    state::{Draw, Tier, MODE_LIST, SLOT_CLAIMED, STATUS_COMPLETE},
    sumtree,
};
use null_draw_common::slot_hashes::DRAW_DELAY_SLOTS;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke_signed,
    pubkey::Pubkey,
};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    clock::Clock,
    hash::{hashv, Hash},
    instruction::{AccountMeta, Instruction},
    signature::{Keypair, Signer},
    slot_hashes::SlotHashes,
    system_program,
    transaction::Transaction,
};

// ── the calling program ─────────────────────────────────────────────────────

mod giveaway {
    use super::*;

    pub fn id() -> Pubkey {
        Pubkey::new_from_array([7u8; 32])
    }

    /// data: draw_id u64, list root [32], total weight u64, leaf count u64, depth u8.
    /// accounts: giveaway PDA (w), draw (w), system program, null_fair_draw program.
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        let it = &mut accounts.iter();
        let pda = next_account_info(it)?;
        let draw = next_account_info(it)?;
        let system = next_account_info(it)?;
        let fair_draw = next_account_info(it)?;
        let (expected, bump) = Pubkey::find_program_address(&[b"giveaway"], program_id);
        assert_eq!(expected, *pda.key);
        let seeds: &[&[u8]] = &[b"giveaway", &[bump]];
        let draw_id = u64::from_le_bytes(data[0..8].try_into().unwrap());
        let root: [u8; 32] = data[8..40].try_into().unwrap();
        let total = u64::from_le_bytes(data[40..48].try_into().unwrap());
        let count = u64::from_le_bytes(data[48..56].try_into().unwrap());
        let depth = data[56];
        let params = CreateParams {
            mode: MODE_LIST,
            weighted: false,
            redraw_rounds: 2,
            tiers: vec![Tier { count: 1, amount: 100_000_000 }, Tier { count: 2, amount: 10_000_000 }],
            entry_price: 0,
            wallet_cap: 0,
            close_slot: 0,
            claim_window_slots: 216_000,
            prize_mint: [0; 32],
            entry_mint: [0; 32],
            fee_dest: [0; 32],
        };
        let infos = [pda.clone(), draw.clone(), system.clone(), fair_draw.clone()];
        for ix in fd::create_draw_with_extends(fair_draw.key, pda.key, draw_id, params) {
            invoke_signed(&ix, &infos, &[seeds])?;
        }
        invoke_signed(&fd::fund_prizes(fair_draw.key, pda.key, draw.key, None), &infos, &[seeds])?;
        invoke_signed(&fd::commit_list(fair_draw.key, pda.key, draw.key, root, total, count, depth), &infos, &[seeds])?;
        Ok(())
    }
}

#[tokio::test]
async fn calling_program_runs_a_draw() {
    let fid = null_fair_draw::id();
    let gid = giveaway::id();
    // The caller is a native builtin; null_fair_draw runs from the SBF build
    // when SBF_OUT_DIR is set.
    let mut pt = ProgramTest::default();
    pt.prefer_bpf(false);
    pt.add_program("giveaway", gid, processor!(giveaway::process));
    match std::env::var("SBF_OUT_DIR") {
        Ok(dir) => {
            let elf = std::fs::read(format!("{dir}/null_fair_draw.so")).expect("null_fair_draw.so");
            let rent = solana_sdk::rent::Rent::default().minimum_balance(elf.len());
            pt.add_account(fid, Account { lamports: rent, data: elf, owner: solana_sdk::bpf_loader::id(), executable: true, rent_epoch: 0 });
        }
        Err(_) => pt.add_program("null_fair_draw", fid, processor!(null_fair_draw::process_instruction)),
    }
    let (pda, _) = Pubkey::find_program_address(&[b"giveaway"], &gid);
    pt.add_account(pda, Account::new(1_000_000_000, 0, &system_program::id()));
    let users: Vec<Keypair> = (0..5).map(|_| Keypair::new()).collect();
    for u in &users {
        pt.add_account(u.pubkey(), Account::new(1_000_000_000, 0, &system_program::id()));
    }
    let mut ctx = pt.start_with_context().await;
    let mut clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.slot = 1_000;
    ctx.set_sysvar(&clock);

    let draw = fd::draw_address(&fid, &pda, 1).0;
    let pairs: Vec<sumtree::Pair> = users.iter().map(|u| (sumtree::leaf(&draw.to_bytes(), &u.pubkey().to_bytes(), 1), 1)).collect();
    let (root, total) = sumtree::root_of(&pairs, 3);
    let mut data = 1u64.to_le_bytes().to_vec();
    data.extend_from_slice(&root);
    data.extend_from_slice(&total.to_le_bytes());
    data.extend_from_slice(&5u64.to_le_bytes());
    data.push(3);
    let run = Instruction {
        program_id: gid,
        accounts: vec![
            AccountMeta::new(pda, false),
            AccountMeta::new(draw, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(fid, false),
        ],
        data,
    };
    let payer = ctx.payer.insecure_clone();
    let tx = Transaction::new_signed_with_payer(&[run], Some(&payer.pubkey()), &[&payer], ctx.last_blockhash);
    ctx.banks_client.process_transaction(tx).await.unwrap();
    let a = ctx.banks_client.get_account(draw).await.unwrap().unwrap();
    let d = Draw::unpack(&a.data).unwrap();
    assert_eq!((d.organizer, d.funded, d.leaf_count), (pda.to_bytes(), 120_000_000, 5));

    // Anyone cranks the draw once the target slot has a hash.
    let t0 = d.rounds[0].first_target;
    assert_eq!(t0, 1_000 + DRAW_DELAY_SLOTS);
    let hashes: Vec<(u64, Hash)> = (t0 - 5..=t0 + 2).map(|s| (s, Hash::new_from_array(hashv(&[&s.to_le_bytes()]).to_bytes()))).collect();
    ctx.set_sysvar(&SlotHashes::new(&hashes));
    clock.slot = t0 + 2;
    ctx.set_sysvar(&clock);
    let tx = Transaction::new_signed_with_payer(
        &[fd::draw(&fid, &draw), fd::resolve(&fid, &draw, 0, vec![])],
        Some(&payer.pubkey()),
        &[&payer],
        ctx.last_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();
    let a = ctx.banks_client.get_account(draw).await.unwrap().unwrap();
    let d = Draw::unpack(&a.data).unwrap();
    // The top prize winner claims with the published list.
    let s0 = d.read_slot(&a.data, 0);
    let w = &users[s0.leaf_index as usize];
    let proof = LeafProof {
        leaf_index: s0.leaf_index,
        wallet: w.pubkey().to_bytes(),
        weight: 1,
        path: sumtree::proof_of(&pairs, 3, s0.leaf_index as usize),
    };
    let before = ctx.banks_client.get_balance(w.pubkey()).await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[fd::claim(&fid, &w.pubkey(), &draw, 0, Some(proof), None)],
        Some(&payer.pubkey()),
        &[&payer, w],
        ctx.last_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();
    assert_eq!(ctx.banks_client.get_balance(w.pubkey()).await.unwrap(), before + 100_000_000);
    let a = ctx.banks_client.get_account(draw).await.unwrap().unwrap();
    let d = Draw::unpack(&a.data).unwrap();
    assert_eq!(d.read_slot(&a.data, 0).status, SLOT_CLAIMED);
    assert_ne!(d.status, STATUS_COMPLETE);
}
