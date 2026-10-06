// Compute units per instruction and the largest batch per V1 transaction
// (4,096 bytes, 64 addresses, 1.4M CU) for each lane. Each maximal
// transaction is executed. Meaningful CU numbers come from the SBF run:
// `SBF_OUT_DIR=<dir> cargo test --features cu-probe --test cu -- --nocapture`.

mod common;

use common::*;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use x402_settle::{instruction as ix, state::*};

struct Row {
    name: String,
    cu: u64,
    note: String,
}

fn print_table(rows: &[Row]) {
    println!("\n| Instruction | CU | Note |\n|---|---:|---|");
    for r in rows {
        println!("| {} | {} | {} |", r.name, r.cu, r.note);
    }
}

/// Largest k with `fits(k)`, searching upward from 1.
fn max_k(mut fits: impl FnMut(usize) -> bool, cap: usize) -> usize {
    let mut k = 0;
    while k < cap && fits(k + 1) {
        k += 1;
    }
    k
}

#[tokio::test]
async fn cu_table_and_capacity() {
    let n_payers = 30;
    let payers: Vec<Keypair> = (0..n_payers).map(|_| Keypair::new()).collect();
    let payee = Keypair::new();
    let payee2 = Keypair::new();
    let mut f: Vec<&Keypair> = payers.iter().collect();
    f.push(&payee);
    f.push(&payee2);
    let mut t = T::new(&f).await;
    let mut rows: Vec<Row> = vec![];
    let me = t.payer();
    let mode = if sbf() { "SBF" } else { "native (CU not meaningful)" };

    // -- setup instructions --------------------------------------------------
    let cu = t.cu(vec![ix::init_ledger_sol(&t.pid, &me.pubkey())], &[], None).await;
    rows.push(Row { name: "InitLedger (SOL)".into(), cu, note: "reads SlotHashes".into() });
    let l = init_sol(&mut t).await;
    let cu = t.cu(vec![ix::create_book(&l.pid, &l.ledger, &me.pubkey(), 0)], &[], None).await;
    rows.push(Row { name: "CreateBook".into(), cu, note: "64 payee slots".into() });
    let book = book_with(&mut t, &l, 0, &[&payee]).await;
    let p0 = &payers[0];
    let cu = t.cu(vec![ix::open_escrow(&l.pid, &l.ledger, &p0.pubkey(), 4)], &[p0], None).await;
    rows.push(Row { name: "OpenEscrow (4 pairs)".into(), cu, note: "".into() });
    for p in &payers {
        open_and_fund(&mut t, &l, p, 4, 10 * SOL, None).await;
    }
    let cu = t.cu(vec![ix::deposit(&l.pid, &l.ledger, &p0.pubkey(), &p0.pubkey(), 1_000, None)], &[p0], None).await;
    rows.push(Row { name: "Deposit (SOL)".into(), cu, note: "system transfer CPI".into() });
    let cu = t.cu(vec![ix::request_exit(&l.pid, &l.ledger, &p0.pubkey(), 1)], &[p0], None).await;
    rows.push(Row { name: "RequestExit".into(), cu, note: "".into() });
    let book2 = l.book(1);
    t.send(vec![ix::create_book(&l.pid, &l.ledger, &me.pubkey(), 1)], &[]).await.unwrap();
    let cu = t.cu(vec![ix::register_payee(&l.pid, &book2, &payee2.pubkey(), 0)], &[&payee2], None).await;
    rows.push(Row { name: "RegisterPayee".into(), cu, note: "".into() });
    t.send(vec![ix::register_payee(&l.pid, &book2, &payee2.pubkey(), 0)], &[&payee2]).await.unwrap();

    let scopes: Vec<u64> = {
        let mut v = vec![];
        for p in &payers {
            v.push(escrow_of(&mut t, &l, &p.pubkey()).await.scope);
        }
        v
    };
    let exp = t.slot + 100_000;
    let pk = payee.pubkey();

    // -- Lane B2: distinct payers -------------------------------------------
    let b2_ix = |k: usize, base: u64| -> Instruction {
        let mut accts: Vec<Pubkey> = payers[..k].iter().map(|p| l.escrow(&p.pubkey())).collect();
        accts.push(book);
        let vs: Vec<_> = (0..k)
            .map(|i| {
                let q = quote(i as u64);
                let c = base + i as u64;
                wv((1 + i) as u8, 0, (1 + k) as u8, 0, c, exp, q, l.sign(&payers[i], &pk, scopes[i], c, exp, &q))
            })
            .collect();
        ix::settle(&l.pid, &l.ledger, &accts, &vs)
    };
    let fits = |i: &Instruction| {
        let (b, a, _) = v1_size(std::slice::from_ref(i), &me.pubkey());
        b <= V1_MAX_BYTES && a <= V1_MAX_ACCOUNTS
    };
    let k_b2 = max_k(|k| fits(&b2_ix(k, 1_000)), n_payers);
    let cu1 = t.cu(vec![b2_ix(1, 1_000)], &[], None).await;
    let cu2 = t.cu(vec![b2_ix(2, 1_000)], &[], None).await;
    println!("settle k=1 {cu1} k=2 {cu2} (V1 bound k={k_b2})");
    // Largest batch the 1.4M CU limit allows in this build.
    let mut k_b2_run = k_b2;
    while t.try_cu(vec![b2_ix(k_b2_run, 1_000)], &[], None).await.is_err() {
        k_b2_run -= 1;
    }
    let cuk = t.cu(vec![b2_ix(k_b2_run, 1_000)], &[], None).await;
    let (bytes_b2, addrs_b2, _) = v1_size(&[b2_ix(k_b2, 1_000)], &me.pubkey());
    t.send(vec![b2_ix(k_b2_run, 1_000)], &[]).await.unwrap();
    rows.push(Row { name: "Settle, 1 voucher".into(), cu: cu1, note: "".into() });
    rows.push(Row { name: "Settle, slope per voucher (distinct payer)".into(), cu: cu2 - cu1, note: "incl. escrow PDA check".into() });
    rows.push(Row {
        name: format!("Settle, {k_b2_run} vouchers, distinct payers"),
        cu: cuk,
        note: format!("V1 bound {k_b2} ({bytes_b2} B, {addrs_b2} addresses)"),
    });

    // -- Lane B2: one payer, one pair, rising cumulative ---------------------
    let same_ix = |k: usize, base: u64| -> Instruction {
        let vs: Vec<_> = (0..k)
            .map(|i| {
                let q = quote(1_000 + i as u64);
                let c = base + i as u64 + 1;
                wv(1, 0, 2, 0, c, exp, q, l.sign(p0, &pk, scopes[0], c, exp, &q))
            })
            .collect();
        ix::settle(&l.pid, &l.ledger, &[l.escrow(&p0.pubkey()), book], &vs)
    };
    let k_same = max_k(|k| fits(&same_ix(k, 10_000)), 64);
    let mut k_same_run = k_same;
    while t.try_cu(vec![same_ix(k_same_run, 10_000)], &[], None).await.is_err() {
        k_same_run -= 1;
    }
    let cu_same = t.cu(vec![same_ix(k_same_run, 10_000)], &[], None).await;
    let (bytes_same, _, _) = v1_size(&[same_ix(k_same, 10_000)], &me.pubkey());
    t.send(vec![same_ix(k_same_run, 10_000)], &[]).await.unwrap();
    rows.push(Row {
        name: format!("Settle, {k_same_run} vouchers, one escrow"),
        cu: cu_same,
        note: format!("V1 bound {k_same} ({bytes_same} B)"),
    });

    // -- Lane C --------------------------------------------------------------
    let ch_exp = t.slot + 50_000;
    let cu = t.cu(vec![ix::open_channel(&l.pid, &l.ledger, &p0.pubkey(), &pk, 999, 1_000, ch_exp)], &[p0], None).await;
    rows.push(Row { name: "OpenChannel".into(), cu, note: "creates the channel PDA".into() });
    let mut chans = vec![];
    for (i, p) in payers.iter().enumerate() {
        t.send(vec![ix::open_channel(&l.pid, &l.ledger, &p.pubkey(), &pk, i as u64, SOL, ch_exp)], &[p]).await.unwrap();
        let k = l.channel(&p.pubkey(), &pk, i as u64);
        let sc = Channel::unpack(&t.data(&k).await).scope;
        chans.push((k, sc));
    }
    let close_ix = |k: usize| -> Instruction {
        let mut w: Vec<Pubkey> = chans[..k].iter().map(|c| c.0).collect();
        w.push(book);
        let es: Vec<_> = (0..k)
            .map(|i| {
                let q = quote(5_000 + i as u64);
                let c = 777 + i as u64;
                wc((1 + i) as u8, (1 + k) as u8, 0, c, ch_exp, q, l.sign(&payers[i], &pk, chans[i].1, c, ch_exp, &q))
            })
            .collect();
        ix::close_channels(&l.pid, &l.ledger, &w, &[pk], &es)
    };
    let fits_payee = |i: &Instruction| {
        let (b, a, _) = v1_size(std::slice::from_ref(i), &pk);
        b <= V1_MAX_BYTES && a <= V1_MAX_ACCOUNTS
    };
    let k_c = max_k(|k| fits_payee(&close_ix(k)), n_payers);
    let c1 = t.cu(vec![close_ix(1)], &[], Some(&payee)).await;
    let c2 = t.cu(vec![close_ix(2)], &[], Some(&payee)).await;
    let mut k_c_run = k_c;
    while t.try_cu(vec![close_ix(k_c_run)], &[], Some(&payee)).await.is_err() {
        k_c_run -= 1;
    }
    let ck = t.cu(vec![close_ix(k_c_run)], &[], Some(&payee)).await;
    let (bytes_c, addrs_c, _) = v1_size(&[close_ix(k_c)], &pk);
    t.send_with_payer(vec![close_ix(k_c_run)], &[], Some(&payee)).await.unwrap();
    rows.push(Row { name: "CloseChannels, 1 channel (payee signs)".into(), cu: c1, note: "".into() });
    rows.push(Row { name: "CloseChannels, slope per channel".into(), cu: c2 - c1, note: "".into() });
    rows.push(Row {
        name: format!("CloseChannels, {k_c_run} channels"),
        cu: ck,
        note: format!("V1 bound {k_c} ({bytes_c} B, {addrs_c} addresses)"),
    });
    let cu = t.cu(vec![ix::reclaim_channel(&l.pid, &l.ledger, &chans[0].0, &payers[0].pubkey())], &[], None).await;
    rows.push(Row { name: "ReclaimChannel".into(), cu, note: "closes the channel account".into() });
    let cu = t.cu(vec![ix::withdraw_payee(&l.pid, &l.ledger, &book, &pk, 0, 1, &pk, None)], &[&payee], None).await;
    rows.push(Row { name: "WithdrawPayee (SOL)".into(), cu, note: "".into() });

    // -- Two-phase: chunk capacity and costs ---------------------------------
    // Fresh pairs to payee2 (slot 0 of book 1): pair index 1 for payers that
    // already pay `payee` at index 0, index 0 for the others.
    let pk2 = payee2.pubkey();
    let stage_items = |k: usize| -> Vec<Planned> {
        (0..k)
            .map(|i| {
                let pair = if i < k_b2_run { 1 } else { 0 };
                planned(&l, &payers[i], scopes[i], pair, &pk2, 0, 0, 50 + i as u64, exp, 9_000 + i as u64)
            })
            .collect()
    };
    // Chunk size limit with an 8-level proof (256 chunks).
    let stage_fits = |k: usize, depth: usize| {
        let items = stage_items(k);
        let plan = Plan::new(&l, items, 5, k as u8);
        let mut i = plan.stage_ix(&l, &l.batch(1), 0, &book2);
        // pad the proof to `depth` levels for the size check only
        let extra = depth.saturating_sub(plan.proof(0).len()) * 32;
        i.data.extend(std::iter::repeat(0u8).take(extra));
        let (b, a, _) = v1_size(&[i], &me.pubkey());
        b <= V1_MAX_BYTES && a <= V1_MAX_ACCOUNTS
    };
    let k_stage8 = max_k(|k| stage_fits(k, 8), n_payers.min(32));
    let k_stage3 = max_k(|k| stage_fits(k, 3), n_payers.min(32));
    // In this build the CU limit may bind before bytes; stage what fits.
    let mut k_stage_run = k_stage3;
    loop {
        let plan = Plan::new(&l, stage_items(k_stage_run), 5, k_stage_run as u8);
        let probe_batch = l.batch(2);
        let begin = ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 2, &plan.root, k_stage_run as u32, plan.total(), 5, k_stage_run as u8);
        let st = plan.stage_ix(&l, &probe_batch, 0, &book2);
        if t.try_cu(vec![begin, st], &[], None).await.is_ok() {
            break;
        }
        k_stage_run -= 1;
    }
    let items = stage_items(k_stage_run);
    let plan = Plan::new(&l, items, 5, k_stage_run as u8);
    let batch = l.batch(1);
    let cu = t.cu(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 1, &plan.root, k_stage_run as u32, plan.total(), 5, k_stage_run as u8)], &[], None).await;
    rows.push(Row { name: "BeginBatch".into(), cu, note: "creates the batch PDA".into() });
    t.send(vec![ix::begin_batch(&l.pid, &l.ledger, &me.pubkey(), 1, &plan.root, k_stage_run as u32, plan.total(), 5, k_stage_run as u8)], &[])
        .await
        .unwrap();
    let st = plan.stage_ix(&l, &batch, 0, &book2);
    let (bytes_st, addrs_st, _) = v1_size(std::slice::from_ref(&st), &me.pubkey());
    let cu = t.cu(vec![st.clone()], &[], None).await;
    t.send(vec![st], &[]).await.unwrap();
    rows.push(Row {
        name: format!("StageChunk, {k_stage_run} vouchers (one chunk)"),
        cu,
        note: format!("{bytes_st} B, {addrs_st} addresses; max {k_stage3} at proof depth 3, {k_stage8} at depth 8"),
    });
    let cu = t.cu(vec![ix::commit_batch(&l.pid, &batch, &[book2])], &[], None).await;
    t.send(vec![ix::commit_batch(&l.pid, &batch, &[book2])], &[]).await.unwrap();
    rows.push(Row { name: "CommitBatch, 1 payee slot".into(), cu, note: "".into() });
    let es: Vec<Pubkey> = payers[..k_stage_run].iter().map(|p| l.escrow(&p.pubkey())).collect();
    let entries: Vec<(u8, u8)> = (0..k_stage_run).map(|i| ((1 + i) as u8, if i < k_b2_run { 1 } else { 0 })).collect();
    let cu = t.cu(vec![ix::resolve_staged(&l.pid, &batch, &es, &entries)], &[], None).await;
    t.send(vec![ix::resolve_staged(&l.pid, &batch, &es, &entries)], &[]).await.unwrap();
    rows.push(Row { name: format!("ResolveStaged, {k_stage_run} pairs"), cu, note: "".into() });
    let cu = t.cu(vec![ix::close_batch(&l.pid, &batch, &me.pubkey())], &[], None).await;
    rows.push(Row { name: "CloseBatch".into(), cu, note: "".into() });

    // -- Escrow exit ---------------------------------------------------------
    t.send(vec![ix::request_exit(&l.pid, &l.ledger, &p0.pubkey(), 5)], &[p0]).await.unwrap();
    let s = t.slot + EXIT_DELAY_SLOTS;
    t.warp(s).await;
    let cu = t.cu(vec![ix::withdraw_escrow(&l.pid, &l.ledger, &p0.pubkey(), &p0.pubkey(), None)], &[p0], None).await;
    rows.push(Row { name: "WithdrawEscrow (SOL)".into(), cu, note: "".into() });

    // -- Fan-out (client-built V1 multi-transfer, no program instruction) -----
    // payer + token program + mint + source + k destinations <= 64 addresses.
    let k_fan = max_k(
        |k| {
            let a = 4 + k;
            let bytes = 1 + 3 + 4 + 32 + 2 + 32 * a + 8 + 64 + k * (4 + 4 + 10);
            a <= V1_MAX_ACCOUNTS && bytes <= V1_MAX_BYTES
        },
        128,
    );

    // -- In-program SHA-512 cost (test build) ---------------------------------
    let mut sha_note = String::from("probe not built");
    if cfg!(feature = "cu-probe") {
        let probe = |m: u8| Instruction { program_id: l.pid, accounts: vec![], data: vec![0xF0, m] };
        let base = t.cu(vec![probe(0)], &[], None).await;
        let with = t.cu(vec![probe(1)], &[], None).await;
        sha_note = format!("{} CU for SHA-512 of a 288-byte voucher input (3 blocks)", with - base);
        rows.push(Row { name: "in-program SHA-512, per voucher".into(), cu: with - base, note: "replaced by sol_sha512 in the cluster build".into() });
    }

    println!("\nx402_settle compute units ({mode})");
    print_table(&rows);
    println!("\nMax per V1 transaction: B2 distinct payers {k_b2}, B2 one escrow {k_same}, C closes {k_c}, StageChunk {k_stage3} (depth 3) / {k_stage8} (depth 8), fan-out TransferChecked {k_fan}");
    println!("{sha_note}");
    assert!(k_b2 >= 20 && k_c >= 20 && k_stage8 >= 16);
}
