// End-to-end tests of x402_settle through solana-program-test: lanes B2 and
// C, escrow exit timelock, two-phase batches, pre-funded PDAs, Token and
// Token-2022 custody. Native by default; set SBF_OUT_DIR to run the SBF build.
#![cfg(not(target_os = "windows"))]

mod common;

use common::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use x402_settle::{error::XsError, instruction as ix, state::*, token};

// ---------------------------------------------------------------------------
// Lane B2
// ---------------------------------------------------------------------------

#[tokio::test]
async fn b2_settle_sol_happy_path() {
    let payers: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    let payee = Keypair::new();
    let mut all: Vec<&Keypair> = payers.iter().collect();
    all.push(&payee);
    let mut t = T::new(&all).await;
    let l = init_sol(&mut t).await;
    let book = book_with(&mut t, &l, 0, &[&payee]).await;
    for p in &payers {
        open_and_fund(&mut t, &l, p, 4, 10 * SOL, None).await;
    }
    let exp = t.slot + 100;
    let mut vs = vec![];
    let mut accts = vec![];
    for (i, p) in payers.iter().enumerate() {
        let scope = escrow_of(&mut t, &l, &p.pubkey()).await.scope;
        let cum = (i as u64 + 1) * 1_000;
        let q = quote(i as u64);
        accts.push(l.escrow(&p.pubkey()));
        vs.push(wv((1 + i) as u8, 0, 4, 0, cum, exp, q, l.sign(p, &payee.pubkey(), scope, cum, exp, &q)));
    }
    accts.push(book);
    t.send(vec![ix::settle(&l.pid, &l.ledger, &accts, &vs)], &[]).await.unwrap();
    assert_eq!(slot_balance(&mut t, &book, 0).await, 6_000);
    let e0 = escrow_of(&mut t, &l, &payers[0].pubkey()).await;
    assert_eq!(e0.balance, 10 * SOL - 1_000);
    assert_eq!(e0.pairs[0].0, payee.pubkey().to_bytes());
    assert_eq!(e0.pairs[0].1, 1_000);

    // Same pair again: cumulative 1_000 -> 2_500 credits 1_500.
    let scope = e0.scope;
    let q = quote(9);
    let v = wv(1, 0, 2, 0, 2_500, exp, q, l.sign(&payers[0], &payee.pubkey(), scope, 2_500, exp, &q));
    t.send(vec![ix::settle(&l.pid, &l.ledger, &[accts[0], book], &[v])], &[]).await.unwrap();
    assert_eq!(slot_balance(&mut t, &book, 0).await, 7_500);

    // Payee withdraws to its wallet.
    let before = t.lamports(&payee.pubkey()).await;
    t.send(vec![ix::withdraw_payee(&l.pid, &l.ledger, &book, &payee.pubkey(), 0, 7_000, &payee.pubkey(), None)], &[&payee])
        .await
        .unwrap();
    assert_eq!(t.lamports(&payee.pubkey()).await, before + 7_000);
    let err = t
        .send(vec![ix::withdraw_payee(&l.pid, &l.ledger, &book, &payee.pubkey(), 0, 501, &payee.pubkey(), None)], &[&payee])
        .await
        .unwrap_err();
    assert_eq!(err, ce(XsError::InsufficientFunds));
    let mut tracked: Vec<Pubkey> = payers.iter().map(|p| l.escrow(&p.pubkey())).collect();
    tracked.push(book);
    assert_solvent(&mut t, &l, &tracked).await;
}

#[tokio::test]
async fn b2_settle_spl_token_and_exit() {
    let payer = Keypair::new();
    let payee = Keypair::new();
    let mint_auth = Keypair::new();
    let mut t = T::new(&[&payer, &payee, &mint_auth]).await;
    let mint = Keypair::new();
    create_mint(&mut t, &token::TOKEN_ID, &mint, &mint_auth.pubkey(), &[], token::MINT_BASE_LEN).await;
    let src = create_token_account(&mut t, &token::TOKEN_ID, &mint.pubkey(), &payer.pubkey()).await;
    mint_to(&mut t, &token::TOKEN_ID, &mint.pubkey(), &src, &mint_auth, 1_000_000).await;
    let l = init_spl(&mut t, &mint.pubkey(), &token::TOKEN_ID).await.unwrap();
    let book = book_with(&mut t, &l, 7, &[&payee]).await;
    open_and_fund(&mut t, &l, &payer, 2, 600_000, Some(src)).await;
    let vault = l.spl.unwrap().vault;
    assert_eq!(token_amount(&t.data(&vault).await), 600_000);

    let exp = t.slot + 10;
    let scope = escrow_of(&mut t, &l, &payer.pubkey()).await.scope;
    let q = quote(1);
    let v = wv(1, 0, 2, 0, 250_000, exp, q, l.sign(&payer, &payee.pubkey(), scope, 250_000, exp, &q));
    let escrow = l.escrow(&payer.pubkey());
    t.send(vec![ix::settle(&l.pid, &l.ledger, &[escrow, book], &[v])], &[]).await.unwrap();

    let dst = create_token_account(&mut t, &token::TOKEN_ID, &mint.pubkey(), &payee.pubkey()).await;
    t.send(vec![ix::withdraw_payee(&l.pid, &l.ledger, &book, &payee.pubkey(), 0, 250_000, &dst, l.spl)], &[&payee])
        .await
        .unwrap();
    assert_eq!(token_amount(&t.data(&dst).await), 250_000);

    // Payer exits the rest through the timelock.
    t.send(vec![ix::request_exit(&l.pid, &l.ledger, &payer.pubkey(), u64::MAX)], &[&payer]).await.unwrap();
    let back = create_token_account(&mut t, &token::TOKEN_ID, &mint.pubkey(), &payer.pubkey()).await;
    let early = t.send(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &payer.pubkey(), &back, l.spl)], &[&payer]).await;
    assert_eq!(early.unwrap_err(), ce(XsError::ExitNotReady));
    let s = t.slot + EXIT_DELAY_SLOTS;
    t.warp(s).await;
    t.send(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &payer.pubkey(), &back, l.spl)], &[&payer]).await.unwrap();
    assert_eq!(token_amount(&t.data(&back).await), 350_000);
    assert_eq!(token_amount(&t.data(&vault).await), 0);
    assert_solvent(&mut t, &l, &[escrow, book]).await;
    t.send(vec![ix::close_escrow(&l.pid, &l.ledger, &payer.pubkey())], &[&payer]).await.unwrap();
    assert!(t.account(&escrow).await.is_none());
}

#[tokio::test]
async fn token_2022_extension_allowlist() {
    let payer = Keypair::new();
    let payee = Keypair::new();
    let auth = Keypair::new();
    let mut t = T::new(&[&payer, &payee, &auth]).await;
    let t22 = token::TOKEN_2022_ID;

    // MetadataPointer (18): allowed.
    let ok_mint = Keypair::new();
    let mut d = vec![39u8, 0];
    d.extend_from_slice(&[0u8; 32]);
    d.extend_from_slice(ok_mint.pubkey().as_ref());
    let ext = Instruction { program_id: t22, accounts: vec![AccountMeta::new(ok_mint.pubkey(), false)], data: d };
    create_mint(&mut t, &t22, &ok_mint, &auth.pubkey(), &[ext], 234).await;
    let l = init_spl(&mut t, &ok_mint.pubkey(), &t22).await.unwrap();
    let src = create_token_account(&mut t, &t22, &ok_mint.pubkey(), &payer.pubkey()).await;
    mint_to(&mut t, &t22, &ok_mint.pubkey(), &src, &auth, 5_000).await;
    let book = book_with(&mut t, &l, 0, &[&payee]).await;
    open_and_fund(&mut t, &l, &payer, 1, 5_000, Some(src)).await;
    let exp = t.slot + 5;
    let scope = escrow_of(&mut t, &l, &payer.pubkey()).await.scope;
    let q = quote(3);
    let v = wv(1, 0, 2, 0, 4_000, exp, q, l.sign(&payer, &payee.pubkey(), scope, 4_000, exp, &q));
    let escrow = l.escrow(&payer.pubkey());
    t.send(vec![ix::settle(&l.pid, &l.ledger, &[escrow, book], &[v])], &[]).await.unwrap();
    let dst = create_token_account(&mut t, &t22, &ok_mint.pubkey(), &payee.pubkey()).await;
    t.send(vec![ix::withdraw_payee(&l.pid, &l.ledger, &book, &payee.pubkey(), 0, 4_000, &dst, l.spl)], &[&payee])
        .await
        .unwrap();
    assert_eq!(token_amount(&t.data(&dst).await), 4_000);
    assert_solvent(&mut t, &l, &[escrow, book]).await;

    // PermanentDelegate (12): refused, it could move vault tokens.
    let bad_mint = Keypair::new();
    let mut d = vec![35u8];
    d.extend_from_slice(auth.pubkey().as_ref());
    let ext = Instruction { program_id: t22, accounts: vec![AccountMeta::new(bad_mint.pubkey(), false)], data: d };
    create_mint(&mut t, &t22, &bad_mint, &auth.pubkey(), &[ext], 202).await;
    assert_eq!(init_spl(&mut t, &bad_mint.pubkey(), &t22).await.err().unwrap(), ce(XsError::MintNotAllowed));

    // A classic mint passed with the Token-2022 kind is refused.
    let classic = Keypair::new();
    create_mint(&mut t, &token::TOKEN_ID, &classic, &auth.pubkey(), &[], token::MINT_BASE_LEN).await;
    let p = t.payer();
    let err = t
        .send(vec![ix::init_ledger_spl(&t.pid, &p.pubkey(), &classic.pubkey(), &token::TOKEN_ID, KIND_TOKEN_2022)], &[])
        .await
        .unwrap_err();
    assert_eq!(err, ce(XsError::MintNotAllowed));
}

#[tokio::test]
async fn b2_voucher_rejections() {
    let payer = Keypair::new();
    let payee = Keypair::new();
    let other = Keypair::new();
    let mut t = T::new(&[&payer, &payee, &other]).await;
    let l = init_sol(&mut t).await;
    let book = book_with(&mut t, &l, 0, &[&payee, &other]).await;
    open_and_fund(&mut t, &l, &payer, 2, SOL, None).await;
    let escrow = l.escrow(&payer.pubkey());
    let scope = escrow_of(&mut t, &l, &payer.pubkey()).await.scope;
    let exp = t.slot + 50;
    let q = quote(1);
    let pk = payee.pubkey();
    let good = l.sign(&payer, &pk, scope, 1_000, exp, &q);
    let accts = [escrow, book];
    let send1 = |v| ix::settle(&l.pid, &l.ledger, &accts, &[v]);

    // Tampered amount.
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_001, exp, q, good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Tampered quote hash.
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, quote(2), good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Tampered expiry.
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp + 1, q, good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Voucher for `payee` credited to another payee's slot.
    let e = t.send(vec![send1(wv(1, 0, 2, 1, 1_000, exp, q, good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Wrong program id in the signed message.
    let mut msg = l.msg(&payer.pubkey(), &pk, scope, 1_000, exp, &q);
    msg[8..40].copy_from_slice(Pubkey::new_unique().as_ref());
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, sig64(&payer, &msg)))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Wrong mint.
    let mut msg = l.msg(&payer.pubkey(), &pk, scope, 1_000, exp, &q);
    msg[40..72].copy_from_slice(Pubkey::new_unique().as_ref());
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, sig64(&payer, &msg)))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Wrong cluster salt.
    let mut msg = l.msg(&payer.pubkey(), &pk, scope, 1_000, exp, &q);
    msg[72] ^= 1;
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, sig64(&payer, &msg)))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Another scope (a channel voucher of the same payer and payee).
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, l.sign(&payer, &pk, scope + 1, 1_000, exp, &q)))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Signed by someone else.
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, l.sign(&other, &pk, scope, 1_000, exp, &q)))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Non-canonical s (s + L).
    let mut mal = good;
    let lb: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0x10,
    ];
    let mut carry = 0u16;
    for i in 0..32 {
        let s = mal[32 + i] as u16 + lb[i] as u16 + carry;
        mal[32 + i] = s as u8;
        carry = s >> 8;
    }
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, mal))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // Pair index beyond the next free entry.
    let e = t.send(vec![send1(wv(1, 1, 2, 0, 1_000, exp, q, good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::InvalidInstruction));
    // Ledger account used as an escrow.
    let e = t.send(vec![send1(wv(0, 0, 2, 0, 1_000, exp, q, good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::InvalidInstruction));
    // Above the escrow balance.
    let big = l.sign(&payer, &pk, scope, 2 * SOL, exp, &q);
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 2 * SOL, exp, q, big))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::InsufficientFunds));

    // The good voucher settles once; the replay is refused.
    t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, good))], &[]).await.unwrap();
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 1_000, exp, q, good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::StaleVoucher));
    // A second pair entry for the same payee would restart its counter.
    let e = t.send(vec![send1(wv(1, 1, 2, 0, 1_000, exp, q, good))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::DuplicatePair));
    // An older (lower) cumulative voucher is refused too.
    let old = l.sign(&payer, &pk, scope, 500, exp, &q);
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 500, exp, q, old))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::StaleVoucher));
    // Pair entry 0 belongs to `payee`: a voucher for `other` must not use it.
    let ov = l.sign(&payer, &other.pubkey(), scope, 10, exp, &q);
    let e = t.send(vec![send1(wv(1, 0, 2, 1, 10, exp, q, ov))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::PairMismatch));
    // Expired voucher.
    let s = exp + 1;
    t.warp(s).await;
    let late = l.sign(&payer, &pk, scope, 2_000, exp, &q);
    let e = t.send(vec![send1(wv(1, 0, 2, 0, 2_000, exp, q, late))], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::VoucherExpired));
    // One bad voucher fails the whole transaction.
    let exp2 = s + 10;
    let ok = l.sign(&payer, &pk, scope, 3_000, exp2, &q);
    let bad = l.sign(&payer, &other.pubkey(), scope, 10, exp2, &q);
    let both = ix::settle(&l.pid, &l.ledger, &accts, &[wv(1, 0, 2, 0, 3_000, exp2, q, ok), wv(1, 1, 2, 1, 10, exp2, quote(5), bad)]);
    assert_eq!(t.send(vec![both], &[]).await.unwrap_err(), ce(XsError::BadSignature));
    assert_eq!(slot_balance(&mut t, &book, 0).await, 1_000);
    assert_solvent(&mut t, &l, &[escrow, book]).await;
}

#[tokio::test]
async fn escrow_exit_timelock_and_pair_table() {
    let payer = Keypair::new();
    let payees: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    let mut f: Vec<&Keypair> = payees.iter().collect();
    f.push(&payer);
    let mut t = T::new(&f).await;
    let l = init_sol(&mut t).await;
    let pr: Vec<&Keypair> = payees.iter().collect();
    let book = book_with(&mut t, &l, 0, &pr).await;
    open_and_fund(&mut t, &l, &payer, 2, 10_000, None).await;
    let escrow = l.escrow(&payer.pubkey());
    let scope = escrow_of(&mut t, &l, &payer.pubkey()).await.scope;

    // Exit request: vouchers handed out before keep settling during the delay.
    t.send(vec![ix::request_exit(&l.pid, &l.ledger, &payer.pubkey(), 10_000)], &[&payer]).await.unwrap();
    let ev = escrow_of(&mut t, &l, &payer.pubkey()).await;
    assert_eq!(ev.exit_ready, t.slot + EXIT_DELAY_SLOTS);
    let exp = t.slot + EXIT_DELAY_SLOTS * 2;
    let q = quote(1);
    let v0 = wv(1, 0, 2, 0, 3_000, exp, q, l.sign(&payer, &payees[0].pubkey(), scope, 3_000, exp, &q));
    let s = t.slot + EXIT_DELAY_SLOTS - 1;
    t.warp(s).await;
    let dest = Keypair::new().pubkey();
    t.fund(&dest, SOL).await;
    let e = t.send(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &payer.pubkey(), &dest, None)], &[&payer]).await.unwrap_err();
    assert_eq!(e, ce(XsError::ExitNotReady));
    t.send(vec![ix::settle(&l.pid, &l.ledger, &[escrow, book], &[v0])], &[]).await.unwrap();

    // Pair table: capacity 2. A third payee needs a bigger table.
    let v1 = wv(1, 1, 2, 1, 1_000, exp, q, l.sign(&payer, &payees[1].pubkey(), scope, 1_000, exp, &q));
    t.send(vec![ix::settle(&l.pid, &l.ledger, &[escrow, book], &[v1])], &[]).await.unwrap();
    let v2 = wv(1, 2, 2, 2, 500, exp, q, l.sign(&payer, &payees[2].pubkey(), scope, 500, exp, &q));
    let e = t.send(vec![ix::settle(&l.pid, &l.ledger, &[escrow, book], &[v2])], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::PairTableFull));
    t.send(vec![ix::grow_escrow(&l.pid, &l.ledger, &payer.pubkey(), 3)], &[&payer]).await.unwrap();
    t.send(vec![ix::settle(&l.pid, &l.ledger, &[escrow, book], &[v2])], &[]).await.unwrap();
    assert_eq!(escrow_of(&mut t, &l, &payer.pubkey()).await.pair_count, 3);

    // After the delay the exit pays what is left (10_000 - 4_500).
    let s = t.slot + 1;
    t.warp(s).await;
    let e = t.send(vec![ix::close_escrow(&l.pid, &l.ledger, &payer.pubkey())], &[&payer]).await.unwrap_err();
    assert_eq!(e, ce(XsError::EscrowBusy));
    t.send(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &payer.pubkey(), &dest, None)], &[&payer]).await.unwrap();
    assert_eq!(t.lamports(&dest).await, SOL + 5_500);
    assert_eq!(escrow_of(&mut t, &l, &payer.pubkey()).await.balance, 0);
    // A second withdraw needs a new request.
    let e = t.send(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &payer.pubkey(), &dest, None)], &[&payer]).await.unwrap_err();
    assert_eq!(e, ce(XsError::ExitNotReady));
    // Only the payer can request an exit.
    let attacker = payees[0].insecure_clone();
    let mut forged = ix::request_exit(&l.pid, &l.ledger, &payer.pubkey(), 1);
    forged.accounts[0] = AccountMeta::new_readonly(attacker.pubkey(), true);
    let e = t.send(vec![forged], &[&attacker]).await.unwrap_err();
    assert_eq!(e, ce(XsError::Unauthorized));
    assert_solvent(&mut t, &l, &[escrow, book]).await;

    // Close, reopen: the new escrow has a new scope, so old vouchers fail.
    t.send(vec![ix::close_escrow(&l.pid, &l.ledger, &payer.pubkey())], &[&payer]).await.unwrap();
    open_and_fund(&mut t, &l, &payer, 1, 10_000, None).await;
    let ev = escrow_of(&mut t, &l, &payer.pubkey()).await;
    assert_ne!(ev.scope, scope);
    let e = t.send(vec![ix::settle(&l.pid, &l.ledger, &[escrow, book], &[v0])], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
}

// ---------------------------------------------------------------------------
// Lane C
// ---------------------------------------------------------------------------

async fn channel_fixture(n: usize) -> (T, L, Vec<Keypair>, Keypair, Pubkey) {
    let payers: Vec<Keypair> = (0..n).map(|_| Keypair::new()).collect();
    let payee = Keypair::new();
    let mut f: Vec<&Keypair> = payers.iter().collect();
    f.push(&payee);
    let mut t = T::new(&f).await;
    let l = init_sol(&mut t).await;
    let book = book_with(&mut t, &l, 0, &[&payee]).await;
    for p in &payers {
        open_and_fund(&mut t, &l, p, 1, 5 * SOL, None).await;
    }
    (t, l, payers, payee, book)
}

async fn open_ch(t: &mut T, l: &L, payer: &Keypair, payee: &Pubkey, id: u64, deposit: u64, expiry: u64) -> (Pubkey, u64) {
    t.send(vec![ix::open_channel(&l.pid, &l.ledger, &payer.pubkey(), payee, id, deposit, expiry)], &[payer]).await.unwrap();
    let ch = l.channel(&payer.pubkey(), payee, id);
    let c = Channel::unpack(&t.data(&ch).await);
    (ch, c.scope)
}

#[tokio::test]
async fn channel_payee_close_and_reclaim() {
    let (mut t, l, payers, payee, book) = channel_fixture(1).await;
    let p = &payers[0];
    let exp = t.slot + 10_000;
    let (ch, scope) = open_ch(&mut t, &l, p, &payee.pubkey(), 1, SOL, exp).await;
    let e = escrow_of(&mut t, &l, &p.pubkey()).await;
    assert_eq!((e.balance, e.open_channels), (4 * SOL, 1));
    // 1,000 off-chain payments of 100_000 lamports; only the last voucher
    // goes on chain.
    let q = quote(1000);
    let cum = 1_000 * 100_000;
    let sig = l.sign(p, &payee.pubkey(), scope, cum, exp, &q);
    t.send_with_payer(
        vec![ix::close_channels(&l.pid, &l.ledger, &[ch, book], &[payee.pubkey()], &[wc(1, 2, 0, cum, exp, q, sig)])],
        &[],
        Some(&payee),
    )
    .await
    .unwrap();
    let c = Channel::unpack(&t.data(&ch).await);
    assert_eq!((c.status, c.best_cum, c.balance), (CH_CLOSED, cum, SOL - cum));
    assert_eq!(slot_balance(&mut t, &book, 0).await, cum);
    assert_solvent(&mut t, &l, &[l.escrow(&p.pubkey()), book, ch]).await;
    let rent_before = t.lamports(&p.pubkey()).await;
    let ch_rent = t.lamports(&ch).await;
    t.send(vec![ix::reclaim_channel(&l.pid, &l.ledger, &ch, &p.pubkey())], &[]).await.unwrap();
    assert!(t.account(&ch).await.is_none());
    assert_eq!(t.lamports(&p.pubkey()).await, rent_before + ch_rent);
    let e = escrow_of(&mut t, &l, &p.pubkey()).await;
    assert_eq!((e.balance, e.open_channels), (5 * SOL - cum, 0));
    assert_solvent(&mut t, &l, &[l.escrow(&p.pubkey()), book]).await;
}

#[tokio::test]
async fn channel_dispute_and_supersede() {
    let (mut t, l, payers, payee, book) = channel_fixture(1).await;
    let p = &payers[0];
    let exp = t.slot + 10_000;
    let (ch, scope) = open_ch(&mut t, &l, p, &payee.pubkey(), 7, 1_000_000, exp).await;
    let pk = payee.pubkey();
    let sig = |cum: u64, q: u64| l.sign(p, &pk, scope, cum, exp, &quote(q));
    // A facilitator (not the payee) submits a stale voucher: dispute window.
    t.send(vec![ix::close_channels(&l.pid, &l.ledger, &[ch], &[], &[wc(1, ix::NO_BOOK, 0, 100, exp, quote(1), sig(100, 1))])], &[])
        .await
        .unwrap();
    let c = Channel::unpack(&t.data(&ch).await);
    assert_eq!((c.status, c.best_cum, c.dispute_end_slot), (CH_CLOSING, 100, t.slot + DISPUTE_SLOTS));
    let e = t.send(vec![ix::finalize_channel(&l.pid, &ch, Some((&book, 0)), None)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::DisputeOpen));
    // A newer voucher supersedes; an older one is refused.
    t.send(vec![ix::close_channels(&l.pid, &l.ledger, &[ch], &[], &[wc(1, ix::NO_BOOK, 0, 300, exp, quote(3), sig(300, 3))])], &[])
        .await
        .unwrap();
    let e = t
        .send(vec![ix::close_channels(&l.pid, &l.ledger, &[ch], &[], &[wc(1, ix::NO_BOOK, 0, 200, exp, quote(2), sig(200, 2))])], &[])
        .await
        .unwrap_err();
    assert_eq!(e, ce(XsError::StaleVoucher));
    // Over the deposit is refused.
    let e = t
        .send(vec![ix::close_channels(&l.pid, &l.ledger, &[ch], &[], &[wc(1, ix::NO_BOOK, 0, 2_000_000, exp, quote(4), sig(2_000_000, 4))])], &[])
        .await
        .unwrap_err();
    assert_eq!(e, ce(XsError::OverDeposit));
    // A B2 voucher of the same payer (escrow scope) does not verify here.
    let escrow_scope = escrow_of(&mut t, &l, &p.pubkey()).await.scope;
    let b2 = l.sign(p, &pk, escrow_scope, 400, exp, &quote(5));
    let e = t
        .send(vec![ix::close_channels(&l.pid, &l.ledger, &[ch], &[], &[wc(1, ix::NO_BOOK, 0, 400, exp, quote(5), b2)])], &[])
        .await
        .unwrap_err();
    assert_eq!(e, ce(XsError::BadSignature));
    // After the window no voucher is accepted; finalize pays the best one.
    let s = t.slot + DISPUTE_SLOTS + 1;
    t.warp(s).await;
    let e = t
        .send(vec![ix::close_channels(&l.pid, &l.ledger, &[ch], &[], &[wc(1, ix::NO_BOOK, 0, 500, exp, quote(6), sig(500, 6))])], &[])
        .await
        .unwrap_err();
    assert_eq!(e, ce(XsError::ChannelState));
    t.send(vec![ix::finalize_channel(&l.pid, &ch, Some((&book, 0)), None)], &[]).await.unwrap();
    assert_eq!(slot_balance(&mut t, &book, 0).await, 300);
    t.send(vec![ix::reclaim_channel(&l.pid, &l.ledger, &ch, &p.pubkey())], &[]).await.unwrap();
    assert_eq!(escrow_of(&mut t, &l, &p.pubkey()).await.balance, 5 * SOL - 300);
    assert_solvent(&mut t, &l, &[l.escrow(&p.pubkey()), book]).await;
}

#[tokio::test]
async fn channel_payer_close_request_and_expiry_refund() {
    let (mut t, l, payers, payee, book) = channel_fixture(2).await;
    let pk = payee.pubkey();
    let exp = t.slot + 3_000;
    // Payer asks to close; the payee answers inside the window with its
    // latest voucher and finalizes at once by signing.
    let p = &payers[0];
    let (ch, scope) = open_ch(&mut t, &l, p, &pk, 1, 50_000, exp).await;
    let e = t.send(vec![ix::request_channel_close(&l.pid, &l.ledger, &payers[1].pubkey(), &ch)], &[&payers[1]]).await.unwrap_err();
    assert_eq!(e, ce(XsError::Unauthorized));
    t.send(vec![ix::request_channel_close(&l.pid, &l.ledger, &p.pubkey(), &ch)], &[p]).await.unwrap();
    let q = quote(1);
    let s = l.sign(p, &pk, scope, 20_000, exp, &q);
    t.send_with_payer(vec![ix::close_channels(&l.pid, &l.ledger, &[ch, book], &[pk], &[wc(1, 2, 0, 20_000, exp, q, s)])], &[], Some(&payee))
        .await
        .unwrap();
    assert_eq!(Channel::unpack(&t.data(&ch).await).status, CH_CLOSED);
    assert_eq!(slot_balance(&mut t, &book, 0).await, 20_000);

    // Second channel: nobody closes; after expiry the payer gets it all back.
    let p2 = &payers[1];
    let (ch2, scope2) = open_ch(&mut t, &l, p2, &pk, 9, 70_000, exp).await;
    let e = t.send(vec![ix::reclaim_channel(&l.pid, &l.ledger, &ch2, &p2.pubkey())], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::ChannelNotExpired));
    t.warp(exp).await;
    let late = l.sign(p2, &pk, scope2, 10_000, exp + 100, &q);
    let e = t
        .send_with_payer(vec![ix::close_channels(&l.pid, &l.ledger, &[ch2, book], &[pk], &[wc(1, 2, 0, 10_000, exp + 100, q, late)])], &[], Some(&payee))
        .await
        .unwrap_err();
    assert_eq!(e, ce(XsError::ChannelExpired));
    let e = t.send(vec![ix::request_channel_close(&l.pid, &l.ledger, &p2.pubkey(), &ch2)], &[p2]).await.unwrap_err();
    assert_eq!(e, ce(XsError::ChannelExpired));
    t.send(vec![ix::reclaim_channel(&l.pid, &l.ledger, &ch2, &p2.pubkey())], &[]).await.unwrap();
    assert_eq!(escrow_of(&mut t, &l, &p2.pubkey()).await.balance, 5 * SOL);
    t.send(vec![ix::reclaim_channel(&l.pid, &l.ledger, &ch, &p.pubkey())], &[]).await.unwrap();
    assert_eq!(escrow_of(&mut t, &l, &p.pubkey()).await.balance, 5 * SOL - 20_000);
    assert_solvent(&mut t, &l, &[l.escrow(&p.pubkey()), l.escrow(&p2.pubkey()), book]).await;

    // An open channel can be released by the payee without a voucher.
    let (ch3, _) = open_ch(&mut t, &l, p, &pk, 3, 1_000, exp + 1_000).await;
    let e = t.send(vec![ix::finalize_channel(&l.pid, &ch3, None, None)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::ChannelState));
    t.send(vec![ix::finalize_channel(&l.pid, &ch3, None, Some(&pk))], &[&payee]).await.unwrap();
    t.send(vec![ix::reclaim_channel(&l.pid, &l.ledger, &ch3, &p.pubkey())], &[]).await.unwrap();
    assert_eq!(escrow_of(&mut t, &l, &p.pubkey()).await.balance, 5 * SOL - 20_000);
}

#[tokio::test]
async fn channel_batch_close_many_in_one_tx() {
    let n = 12;
    let (mut t, l, payers, payee, book) = channel_fixture(n).await;
    let pk = payee.pubkey();
    let exp = t.slot + 5_000;
    let mut chans = vec![];
    let mut entries = vec![];
    for (i, p) in payers.iter().enumerate() {
        let (ch, scope) = open_ch(&mut t, &l, p, &pk, i as u64, 1_000_000, exp).await;
        chans.push(ch);
        let cum = 1_000 + i as u64;
        let q = quote(i as u64);
        entries.push(wc((1 + i) as u8, (1 + n) as u8, 0, cum, exp, q, l.sign(p, &pk, scope, cum, exp, &q)));
    }
    let mut w = chans.clone();
    w.push(book);
    t.send_with_payer(vec![ix::close_channels(&l.pid, &l.ledger, &w, &[pk], &entries)], &[], Some(&payee)).await.unwrap();
    let total: u64 = (0..n as u64).map(|i| 1_000 + i).sum();
    assert_eq!(slot_balance(&mut t, &book, 0).await, total);
    for ch in &chans {
        assert_eq!(Channel::unpack(&t.data(ch).await).status, CH_CLOSED);
    }
    let mut tracked = chans.clone();
    tracked.push(book);
    tracked.extend(payers.iter().map(|p| l.escrow(&p.pubkey())));
    assert_solvent(&mut t, &l, &tracked).await;
}

// ---------------------------------------------------------------------------
// Two-phase batches
// ---------------------------------------------------------------------------

struct BatchFx {
    t: T,
    l: L,
    payers: Vec<Keypair>,
    payees: Vec<Keypair>,
    book: Pubkey,
    scopes: Vec<u64>,
}

async fn batch_fixture(n_payers: usize, n_payees: usize, fund: u64) -> BatchFx {
    let payers: Vec<Keypair> = (0..n_payers).map(|_| Keypair::new()).collect();
    let payees: Vec<Keypair> = (0..n_payees).map(|_| Keypair::new()).collect();
    let mut f: Vec<&Keypair> = payers.iter().collect();
    f.extend(payees.iter());
    let mut t = T::new(&f).await;
    let l = init_sol(&mut t).await;
    let pr: Vec<&Keypair> = payees.iter().collect();
    let book = book_with(&mut t, &l, 0, &pr).await;
    let mut scopes = vec![];
    for p in &payers {
        open_and_fund(&mut t, &l, p, 4, fund, None).await;
        scopes.push(escrow_of(&mut t, &l, &p.pubkey()).await.scope);
    }
    BatchFx { t, l, payers, payees, book, scopes }
}

/// One voucher per payer, payee `i % payees`, cumulative `base + i`.
fn plan_all(fx: &BatchFx, base: u64, exp: u64, chunk_log: u8, chunk_size: u8) -> Plan {
    let items = fx
        .payers
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let s = i % fx.payees.len();
            planned(&fx.l, p, fx.scopes[i], 0, &fx.payees[s].pubkey(), s as u8, 0, base + i as u64, exp, i as u64)
        })
        .collect();
    Plan::new(&fx.l, items, chunk_log, chunk_size)
}

fn escrow_list(fx: &BatchFx) -> Vec<Pubkey> {
    fx.payers.iter().map(|p| fx.l.escrow(&p.pubkey())).collect()
}

async fn resolve_all(fx: &mut BatchFx, batch: &Pubkey) {
    let es = escrow_list(fx);
    for chunk in es.chunks(20) {
        let entries: Vec<(u8, u8)> = (0..chunk.len()).map(|i| ((1 + i) as u8, 0u8)).collect();
        fx.t.send(vec![ix::resolve_staged(&fx.l.pid, batch, chunk, &entries)], &[]).await.unwrap();
    }
}

fn tracked(fx: &BatchFx, extra: &[Pubkey]) -> Vec<Pubkey> {
    let mut v = escrow_list(fx);
    v.push(fx.book);
    v.extend_from_slice(extra);
    v
}

#[tokio::test]
async fn two_phase_all_chunks_then_commit() {
    let mut fx = batch_fixture(40, 3, SOL).await;
    let exp = fx.t.slot + 1_000;
    let plan = plan_all(&fx, 10_000, exp, 4, 16);
    assert_eq!(plan.num_chunks(), 3);
    let (l, book) = (fx.l, fx.book);
    let me = fx.t.payer();
    let batch = l.batch(77);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 77, &plan.root, 40, plan.total(), 4, 16)], &[]).await.unwrap();
    for c in 0..plan.num_chunks() {
        fx.t.send(vec![plan.stage_ix(&l, &batch, c, &book)], &[]).await.unwrap();
        let tr = tracked(&fx, &[batch]);
        assert_solvent(&mut fx.t, &l, &tr).await;
    }
    // Nothing credited before commit; escrows already reserved.
    assert_eq!(slot_balance(&mut fx.t, &book, 0).await, 0);
    let e0 = escrow_of(&mut fx.t, &l, &fx.payers[0].pubkey()).await;
    assert_eq!((e0.balance, e0.pending_count, e0.pairs[0].2), (SOL - 10_000, 1, 10_000));
    let b = BatchHdr::unpack(&fx.t.data(&batch).await);
    assert_eq!((b.staged_count, b.held, b.outstanding), (40, plan.total(), 40));

    fx.t.send(vec![ix::commit_batch(&l.pid, &batch, &[book])], &[]).await.unwrap();
    let mut want = [0u64; 3];
    for (i, p) in plan.items.iter().enumerate() {
        want[i % 3] += p.delta;
    }
    for s in 0..3 {
        assert_eq!(slot_balance(&mut fx.t, &book, s).await, want[s]);
    }
    let tr = tracked(&fx, &[batch]);
    assert_solvent(&mut fx.t, &l, &tr).await;
    // A second commit or an abort is refused.
    assert_eq!(fx.t.send(vec![ix::commit_batch(&l.pid, &batch, &[book])], &[]).await.unwrap_err(), ce(XsError::BatchState));
    assert_eq!(fx.t.send(vec![ix::abort_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap_err(), ce(XsError::BatchState));
    let e = fx.t.send(vec![ix::close_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BatchOutstanding));
    resolve_all(&mut fx, &batch).await;
    let e0 = escrow_of(&mut fx.t, &l, &fx.payers[0].pubkey()).await;
    assert_eq!((e0.balance, e0.pending_count, e0.pairs[0].1, e0.pairs[0].3), (SOL - 10_000, 0, 10_000, 0));
    // The settled pair now refuses the same voucher on the direct lane.
    let p0 = &plan.items[0];
    let v = wv(1, 0, 2, p0.slot, p0.cum, p0.expiry, p0.quote, p0.sig);
    let e = fx.t.send(vec![ix::settle(&l.pid, &l.ledger, &[l.escrow(&p0.payer), book], &[v])], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::StaleVoucher));
    fx.t.send(vec![ix::close_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap();
    assert!(fx.t.account(&batch).await.is_none());
    let tr = tracked(&fx, &[]);
    assert_solvent(&mut fx.t, &l, &tr).await;
}

#[tokio::test]
async fn two_phase_missing_chunk_then_abort_releases_all() {
    let mut fx = batch_fixture(20, 2, SOL).await;
    let exp = fx.t.slot + 1_000;
    let plan = plan_all(&fx, 5_000, exp, 3, 8);
    assert_eq!(plan.num_chunks(), 3);
    let (l, book) = (fx.l, fx.book);
    let me = fx.t.payer();
    let batch = l.batch(5);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 5, &plan.root, 20, plan.total(), 3, 8)], &[]).await.unwrap();
    fx.t.send(vec![plan.stage_ix(&l, &batch, 0, &book)], &[]).await.unwrap();
    fx.t.send(vec![plan.stage_ix(&l, &batch, 2, &book)], &[]).await.unwrap();
    let e = fx.t.send(vec![ix::commit_batch(&l.pid, &batch, &[book])], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BatchIncomplete));
    // The submitter aborts; resolving returns every reservation.
    fx.t.send(vec![ix::abort_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap();
    let e = fx.t.send(vec![plan.stage_ix(&l, &batch, 1, &book)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BatchState));
    let staged: Vec<usize> = (0..8).chain(16..20).collect();
    let es: Vec<Pubkey> = staged.iter().map(|&i| l.escrow(&fx.payers[i].pubkey())).collect();
    let entries: Vec<(u8, u8)> = (0..es.len()).map(|i| ((1 + i) as u8, 0)).collect();
    fx.t.send(vec![ix::resolve_staged(&l.pid, &batch, &es, &entries)], &[]).await.unwrap();
    // Resolving a pair that was never staged in this batch is refused.
    let e = fx
        .t
        .send(vec![ix::resolve_staged(&l.pid, &batch, &[l.escrow(&fx.payers[9].pubkey())], &[(1, 0)])], &[])
        .await
        .unwrap_err();
    assert!(e == ce(XsError::InvalidInstruction) || e == ce(XsError::WrongPendingBatch));
    for p in &fx.payers {
        let e = escrow_of(&mut fx.t, &l, &p.pubkey()).await;
        assert_eq!((e.balance, e.pending_count), (SOL, 0));
    }
    for s in 0..2 {
        assert_eq!(slot_balance(&mut fx.t, &book, s).await, 0);
    }
    fx.t.send(vec![ix::close_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap();
    let tr = tracked(&fx, &[]);
    assert_solvent(&mut fx.t, &l, &tr).await;
    // The released vouchers settle normally afterwards.
    let p0 = &plan.items[0];
    let v = wv(1, 0, 2, p0.slot, p0.cum, p0.expiry, p0.quote, p0.sig);
    fx.t.send(vec![ix::settle(&l.pid, &l.ledger, &[l.escrow(&p0.payer), book], &[v])], &[]).await.unwrap();
}

#[tokio::test]
async fn two_phase_double_staging_and_bad_proof() {
    let mut fx = batch_fixture(6, 2, SOL).await;
    let exp = fx.t.slot + 1_000;
    let (l, book) = (fx.l, fx.book);
    let me = fx.t.payer();
    // The same voucher twice in one batch (chunks 0 and 1 hold item 0).
    let base = plan_all(&fx, 1_000, exp, 2, 4);
    let mut items = base.items.clone();
    items.insert(4, base.items[0].clone());
    let plan = Plan::new(&l, items, 2, 4);
    let batch = l.batch(9);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 9, &plan.root, 7, plan.total(), 2, 4)], &[]).await.unwrap();
    fx.t.send(vec![plan.stage_ix(&l, &batch, 0, &book)], &[]).await.unwrap();
    let e = fx.t.send(vec![plan.stage_ix(&l, &batch, 0, &book)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::ChunkAlreadyStaged));
    let e = fx.t.send(vec![plan.stage_ix(&l, &batch, 1, &book)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::PairPending));
    // The batch can never complete; abort and release.
    fx.t.send(vec![ix::abort_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap();
    let es: Vec<Pubkey> = (0..4).map(|i| l.escrow(&fx.payers[i].pubkey())).collect();
    fx.t.send(vec![ix::resolve_staged(&l.pid, &batch, &es, &[(1, 0), (2, 0), (3, 0), (4, 0)])], &[]).await.unwrap();
    fx.t.send(vec![ix::close_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap();

    // A chunk that does not hash to the root (wrong amount in one voucher).
    let plan = plan_all(&fx, 1_000, exp, 2, 4);
    let batch = l.batch(10);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 10, &plan.root, 6, plan.total(), 2, 4)], &[]).await.unwrap();
    let mut forged = plan.items.clone();
    let p = &fx.payers[5];
    forged[5] = planned(&l, p, fx.scopes[5], 0, &fx.payees[1].pubkey(), 1, 0, 999_999, exp, 77);
    let fplan = Plan { items: forged, chunk_log: 2, chunk_size: 4, root: plan.root, chunk_roots: plan.chunk_roots.clone() };
    let e = fx.t.send(vec![fplan.stage_ix(&l, &batch, 1, &book)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BadMerkleProof));
    // Wrong voucher count for the chunk.
    let mut short = plan.stage_ix(&l, &batch, 1, &book);
    short.data[3] = 1; // n
    assert!(fx.t.send(vec![short], &[]).await.is_err());
    // Total mismatch: a batch declared with a larger total cannot commit.
    let batch2 = l.batch(11);
    fx.t.send(vec![ix::abort_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap();
    let plan2 = plan_all(&fx, 1_000, exp, 2, 4);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 11, &plan2.root, 6, plan2.total() + 1, 2, 4)], &[]).await.unwrap();
    for c in 0..2 {
        fx.t.send(vec![plan2.stage_ix(&l, &batch2, c, &book)], &[]).await.unwrap();
    }
    let e = fx.t.send(vec![ix::commit_batch(&l.pid, &batch2, &[book])], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BatchTotalMismatch));
    let tr = tracked(&fx, &[batch, batch2]);
    assert_solvent(&mut fx.t, &l, &tr).await;
}

#[tokio::test]
async fn two_phase_timeout_abort() {
    let mut fx = batch_fixture(4, 1, SOL).await;
    let exp = fx.t.slot + 10_000;
    let (l, book) = (fx.l, fx.book);
    let me = fx.t.payer();
    let stranger = Keypair::new();
    fx.t.fund(&stranger.pubkey(), SOL).await;
    let plan = plan_all(&fx, 2_000, exp, 1, 2);
    let batch = l.batch(3);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 3, &plan.root, 4, plan.total(), 1, 2)], &[]).await.unwrap();
    fx.t.send(vec![plan.stage_ix(&l, &batch, 0, &book)], &[]).await.unwrap();
    let e = fx.t.send(vec![ix::abort_batch(&l.pid, &batch, &stranger.pubkey())], &[&stranger]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BatchNotTimedOut));
    let s = fx.t.slot + BATCH_TIMEOUT_SLOTS + 1;
    fx.t.warp(s).await;
    let e = fx.t.send(vec![plan.stage_ix(&l, &batch, 1, &book)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BatchDeadline));
    let e = fx.t.send(vec![ix::commit_batch(&l.pid, &batch, &[book])], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::BatchDeadline));
    fx.t.send(vec![ix::abort_batch(&l.pid, &batch, &stranger.pubkey())], &[&stranger]).await.unwrap();
    let es: Vec<Pubkey> = (0..2).map(|i| l.escrow(&fx.payers[i].pubkey())).collect();
    fx.t.send(vec![ix::resolve_staged(&l.pid, &batch, &es, &[(1, 0), (2, 0)])], &[]).await.unwrap();
    for p in &fx.payers {
        assert_eq!(escrow_of(&mut fx.t, &l, &p.pubkey()).await.balance, SOL);
    }
    // Anyone may crank the close; rent goes to the submitter only.
    let e = fx.t.send(vec![ix::close_batch(&l.pid, &batch, &stranger.pubkey())], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::InvalidAccount));
    fx.t.send(vec![ix::close_batch(&l.pid, &batch, &me.pubkey())], &[]).await.unwrap();
    let tr = tracked(&fx, &[]);
    assert_solvent(&mut fx.t, &l, &tr).await;
}

#[tokio::test]
async fn two_phase_reservation_blocks_withdraw_and_second_batch() {
    let mut fx = batch_fixture(1, 2, 100_000).await;
    let exp = fx.t.slot + 100_000;
    let (l, book) = (fx.l, fx.book);
    let me = fx.t.payer();
    let payer = fx.payers[0].insecure_clone();
    let scope = fx.scopes[0];
    // Batch 1 reserves 80_000 of the 100_000 escrow.
    let it = planned(&l, &payer, scope, 0, &fx.payees[0].pubkey(), 0, 0, 80_000, exp, 1);
    let plan = Plan::new(&l, vec![it.clone()], 0, 1);
    let b1 = l.batch(1);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 1, &plan.root, 1, plan.total(), 0, 1)], &[]).await.unwrap();
    fx.t.send(vec![plan.stage_ix(&l, &b1, 0, &book)], &[]).await.unwrap();

    // The payer exits everything: only the unreserved 20_000 can leave.
    fx.t.send(vec![ix::request_exit(&l.pid, &l.ledger, &payer.pubkey(), 100_000)], &[&payer]).await.unwrap();
    let s = fx.t.slot + EXIT_DELAY_SLOTS;
    fx.t.warp(s).await;
    let dest = Keypair::new().pubkey();
    fx.t.fund(&dest, SOL).await;
    fx.t.send(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &payer.pubkey(), &dest, None)], &[&payer]).await.unwrap();
    assert_eq!(fx.t.lamports(&dest).await, SOL + 20_000);

    // A second batch cannot spend the reservation: another payee needs
    // 50_000 of an escrow that now holds 0 free...
    let it2 = planned(&l, &payer, scope, 1, &fx.payees[1].pubkey(), 1, 0, 50_000, exp, 2);
    let plan2 = Plan::new(&l, vec![it2], 0, 1);
    let b2 = l.batch(2);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 2, &plan2.root, 1, plan2.total(), 0, 1)], &[]).await.unwrap();
    let e = fx.t.send(vec![plan2.stage_ix(&l, &b2, 0, &book)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::InsufficientFunds));
    // ...and the reserved pair cannot be staged again or settled directly.
    let it3 = planned(&l, &payer, scope, 0, &fx.payees[0].pubkey(), 0, 0, 90_000, exp, 3);
    let plan3 = Plan::new(&l, vec![it3.clone()], 0, 1);
    let b3 = l.batch(3);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 3, &plan3.root, 1, plan3.total(), 0, 1)], &[]).await.unwrap();
    let e = fx.t.send(vec![plan3.stage_ix(&l, &b3, 0, &book)], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::PairPending));
    let v = wv(1, 0, 2, 0, it3.cum, it3.expiry, it3.quote, it3.sig);
    let e = fx.t.send(vec![ix::settle(&l.pid, &l.ledger, &[l.escrow(&payer.pubkey()), book], &[v])], &[]).await.unwrap_err();
    assert_eq!(e, ce(XsError::PairPending));
    // Closing the escrow is refused while the pair is pending.
    let e = fx.t.send(vec![ix::close_escrow(&l.pid, &l.ledger, &payer.pubkey())], &[&payer]).await.unwrap_err();
    assert_eq!(e, ce(XsError::EscrowBusy));

    // Batch 1 still commits in full (its deadline moved with the warp, so
    // begin a fresh one with the same voucher).
    fx.t.send(vec![ix::abort_batch(&l.pid, &b1, &me.pubkey())], &[]).await.unwrap();
    fx.t.send(vec![ix::resolve_staged(&l.pid, &b1, &[l.escrow(&payer.pubkey())], &[(1, 0)])], &[]).await.unwrap();
    let b4 = l.batch(4);
    fx.t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 4, &plan.root, 1, plan.total(), 0, 1)], &[]).await.unwrap();
    fx.t.send(vec![plan.stage_ix(&l, &b4, 0, &book)], &[]).await.unwrap();
    // Withdraw attempt while reserved: the exit request was consumed, a new
    // one pays at most the free balance (0 here).
    fx.t.send(vec![ix::request_exit(&l.pid, &l.ledger, &payer.pubkey(), 100_000)], &[&payer]).await.unwrap();
    let s = fx.t.slot + 10;
    fx.t.warp(s).await;
    fx.t.send(vec![ix::commit_batch(&l.pid, &b4, &[book])], &[]).await.unwrap();
    assert_eq!(slot_balance(&mut fx.t, &book, 0).await, 80_000);
    fx.t.send(vec![ix::resolve_staged(&l.pid, &b4, &[l.escrow(&payer.pubkey())], &[(1, 0)])], &[]).await.unwrap();
    let tr = tracked(&fx, &[b1, b2, b3, b4]);
    assert_solvent(&mut fx.t, &l, &tr).await;
}

// ---------------------------------------------------------------------------
// Pre-funded PDAs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn prefunded_pdas_are_taken_over() {
    let payer = Keypair::new();
    let payee = Keypair::new();
    let mut t = T::new(&[&payer, &payee]).await;
    let pid = t.pid;
    let ledger = ix::ledger_pda(&pid, &ix::SOL_MINT).0;
    // Someone sends lamports to the future addresses before creation.
    t.fund(&ledger, 5 * SOL).await;
    let escrow = ix::escrow_pda(&pid, &ledger, &payer.pubkey()).0;
    let book = ix::book_pda(&pid, &ledger, 0).0;
    let channel = ix::channel_pda(&pid, &ledger, &payer.pubkey(), &payee.pubkey(), 1).0;
    let batch = ix::batch_pda(&pid, &ledger, 1).0;
    for k in [escrow, book, channel, batch] {
        t.fund(&k, 10_000_000_000).await;
    }
    let l = init_sol(&mut t).await;
    // The donation to the ledger address is surplus, not a liability.
    let book2 = book_with(&mut t, &l, 0, &[&payee]).await;
    assert_eq!(book2, book);
    open_and_fund(&mut t, &l, &payer, 1, 1_000_000, None).await;
    let ch_exp = t.slot + 100;
    let (ch, _) = open_ch(&mut t, &l, &payer, &payee.pubkey(), 1, 1_000, ch_exp).await;
    assert_eq!(ch, channel);
    let me = t.payer();
    t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 1, &[1u8; 32], 1, 1, 0, 1)], &[]).await.unwrap();
    for k in [escrow, book, channel, batch] {
        assert_eq!(t.account(&k).await.unwrap().owner, l.pid);
    }
    let lg = ledger_of(&mut t, &l).await;
    let holdings = t.lamports(&l.ledger).await - t.rent.minimum_balance(LEDGER_LEN);
    assert_eq!(holdings, lg.liabilities + 5 * SOL - t.rent.minimum_balance(LEDGER_LEN));
}

// ---------------------------------------------------------------------------
// Solvency fuzz
// ---------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[tokio::test]
async fn solvency_fuzz_random_sequences() {
    let steps: usize = std::env::var("X402_SETTLE_FUZZ_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(if sbf() { 160 } else { 260 });
    let payers: Vec<Keypair> = (0..4).map(|_| Keypair::new()).collect();
    let payees: Vec<Keypair> = (0..2).map(|_| Keypair::new()).collect();
    let mut f: Vec<&Keypair> = payers.iter().collect();
    f.extend(payees.iter());
    let mut t = T::new(&f).await;
    let l = init_sol(&mut t).await;
    let pr: Vec<&Keypair> = payees.iter().collect();
    let book = book_with(&mut t, &l, 0, &pr).await;
    let mut tracked = vec![book];
    let mut scopes = vec![];
    for p in &payers {
        open_and_fund(&mut t, &l, p, 4, 0, None).await;
        tracked.push(l.escrow(&p.pubkey()));
        scopes.push(escrow_of(&mut t, &l, &p.pubkey()).await.scope);
    }
    // Off-chain view of each pair's latest signed cumulative.
    let mut cum = [[0u64; 2]; 4];
    let mut channels: Vec<(usize, usize, u64, Pubkey, u64, u64)> = vec![]; // payer, payee, id, key, scope, signed
    let mut batches: Vec<(u64, Pubkey, Vec<(usize, u8)>)> = vec![];
    let mut next_id = 1u64;
    let mut rng = Rng(0x9e3779b97f4a7c15);
    let (mut ok, mut failed) = (0usize, 0usize);
    let me = t.payer();
    for step in 0..steps {
        if step % 100 == 99 {
            t.new_block().await;
        }
        let pi = rng.below(4) as usize;
        let si = rng.below(2) as usize;
        let p = payers[pi].insecure_clone();
        let payee = payees[si].insecure_clone();
        let ev = escrow_of(&mut t, &l, &p.pubkey()).await;
        let pair_ix = ev.pairs.iter().position(|x| x.0 == payee.pubkey().to_bytes()).unwrap_or(ev.pair_count) as u8;
        let exp = t.slot + 2_000;
        let r = match rng.below(12) {
            0 | 1 => {
                let amt = 1 + rng.below(50_000);
                t.send(vec![ix::deposit(&l.pid, &l.ledger, &p.pubkey(), &p.pubkey(), amt, None)], &[&p]).await
            }
            2 | 3 | 4 => {
                // Direct settle; sometimes over the balance or a replay.
                let add = 1 + rng.below(30_000);
                let c = if rng.below(5) == 0 { cum[pi][si] } else { cum[pi][si] + add };
                let q = quote(step as u64);
                let v = wv(1, pair_ix, 2, si as u8, c, exp, q, l.sign(&p, &payee.pubkey(), scopes[pi], c, exp, &q));
                let r = t.send(vec![ix::settle(&l.pid, &l.ledger, &[l.escrow(&p.pubkey()), book], &[v])], &[]).await;
                if r.is_ok() {
                    cum[pi][si] = c;
                }
                r
            }
            5 => {
                let amt = rng.below(60_000);
                t.send(vec![ix::request_exit(&l.pid, &l.ledger, &p.pubkey(), amt)], &[&p]).await
            }
            6 => {
                let s = t.slot + rng.below(EXIT_DELAY_SLOTS + 500);
                t.warp(s).await;
                t.send(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &p.pubkey(), &p.pubkey(), None)], &[&p]).await
            }
            7 => {
                let bal = slot_balance(&mut t, &book, si).await;
                let amt = 1 + rng.below(bal + 10);
                t.send(vec![ix::withdraw_payee(&l.pid, &l.ledger, &book, &payee.pubkey(), si as u8, amt, &payee.pubkey(), None)], &[&payee])
                    .await
            }
            8 => {
                // Channel open or close or reclaim.
                if let Some(pos) = (!channels.is_empty() && rng.below(2) == 0).then(|| rng.below(channels.len() as u64) as usize) {
                    let (cpi, csi, _id, key, scope, signed) = channels[pos];
                    let cp = payers[cpi].insecure_clone();
                    let cpayee = payees[csi].insecure_clone();
                    match t.account(&key).await {
                        None => Ok(()),
                        Some(a) => {
                            let c = Channel::unpack(&a.data);
                            if c.status == CH_CLOSED || (c.status == CH_OPEN && t.slot >= c.expiry_slot) {
                                t.send(vec![ix::reclaim_channel(&l.pid, &l.ledger, &key, &cp.pubkey())], &[]).await
                            } else if c.status == CH_CLOSING && t.slot > c.dispute_end_slot {
                                t.send(vec![ix::finalize_channel(&l.pid, &key, Some((&book, csi as u8)), None)], &[]).await
                            } else {
                                let newc = (signed + 1 + rng.below(5_000)).min(c.balance);
                                channels[pos].5 = newc;
                                let ex = c.expiry_slot.max(t.slot);
                                let q = quote(step as u64);
                                let s = l.sign(&cp, &cpayee.pubkey(), scope, newc, ex, &q);
                                let by_payee = rng.below(2) == 0;
                                let signers: Vec<Pubkey> = if by_payee { vec![cpayee.pubkey()] } else { vec![] };
                                let i = ix::close_channels(&l.pid, &l.ledger, &[key, book], &signers, &[wc(1, 2, csi as u8, newc, ex, q, s)]);
                                if by_payee {
                                    t.send(vec![i], &[&cpayee]).await
                                } else {
                                    t.send(vec![i], &[]).await
                                }
                            }
                        }
                    }
                } else {
                    let id = next_id;
                    next_id += 1;
                    let dep = 1 + rng.below(40_000);
                    let ex = t.slot + 1 + rng.below(4_000);
                    let r = t.send(vec![ix::open_channel(&l.pid, &l.ledger, &p.pubkey(), &payee.pubkey(), id, dep, ex)], &[&p]).await;
                    if r.is_ok() {
                        let key = l.channel(&p.pubkey(), &payee.pubkey(), id);
                        let scope = Channel::unpack(&t.data(&key).await).scope;
                        channels.push((pi, si, id, key, scope, 0));
                        tracked.push(key);
                    }
                    r
                }
            }
            9 => {
                // Begin + stage a one-voucher batch for this pair.
                let add = 1 + rng.below(20_000);
                let c = cum[pi][si] + add;
                let it = planned(&l, &p, scopes[pi], pair_ix, &payee.pubkey(), si as u8, ev.pairs.get(pair_ix as usize).map(|x| x.1).unwrap_or(0), c, exp, step as u64);
                let plan = Plan::new(&l, vec![it], 0, 1);
                let id = next_id;
                next_id += 1;
                let bk = l.batch(id);
                let r = t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), id, &plan.root, 1, plan.total(), 0, 1)], &[]).await;
                tracked.push(bk);
                if r.is_ok() {
                    let r2 = t.send(vec![plan.stage_ix(&l, &bk, 0, &book)], &[]).await;
                    let staged = if r2.is_ok() { vec![(pi, pair_ix)] } else { vec![] };
                    if r2.is_ok() {
                        cum[pi][si] = c;
                    }
                    batches.push((id, bk, staged));
                    r2
                } else {
                    r
                }
            }
            10 => {
                // Commit or abort a batch, then resolve it.
                if batches.is_empty() {
                    Ok(())
                } else {
                    let pos = rng.below(batches.len() as u64) as usize;
                    let (_id, bk, staged) = batches.remove(pos);
                    let commit = rng.below(2) == 0;
                    let r = if commit {
                        t.send(vec![ix::commit_batch(&l.pid, &bk, &[book])], &[]).await
                    } else {
                        t.send(vec![ix::abort_batch(&l.pid, &bk, &me.pubkey())], &[]).await
                    };
                    if r.is_err() {
                        t.send(vec![ix::abort_batch(&l.pid, &bk, &me.pubkey())], &[]).await.unwrap();
                    }
                    let aborted = r.is_err() || !commit;
                    for (bpi, bpair) in &staged {
                        t.send(vec![ix::resolve_staged(&l.pid, &bk, &[l.escrow(&payers[*bpi].pubkey())], &[(1, *bpair)])], &[]).await.unwrap();
                        if aborted {
                            // Released: the off-chain cumulative rolls back to the settled one.
                            let evb = escrow_of(&mut t, &l, &payers[*bpi].pubkey()).await;
                            let sidx = payees.iter().position(|k| k.pubkey().to_bytes() == evb.pairs[*bpair as usize].0).unwrap();
                            cum[*bpi][sidx] = evb.pairs[*bpair as usize].1;
                        }
                    }
                    t.send(vec![ix::close_batch(&l.pid, &bk, &me.pubkey())], &[]).await.unwrap();
                    r
                }
            }
            _ => {
                let s = t.slot + rng.below(300);
                t.warp(s).await;
                Ok(())
            }
        };
        if r.is_ok() {
            ok += 1;
        } else {
            failed += 1;
        }
        assert_solvent(&mut t, &l, &tracked).await;
    }
    println!("solvency fuzz: {steps} steps, {ok} applied, {failed} rejected, invariant held after each");
    assert!(ok > steps / 3);
}
