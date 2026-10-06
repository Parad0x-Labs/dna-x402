// Cross-language vectors: voucher message, signature and wire bytes, cluster
// salt, batch leaves and Merkle proofs, PDAs, instruction data, account
// layouts and a full V1 transaction. The TypeScript client in
// packages/x402-settle recomputes the same file.
//
// Regenerate with `X402_SETTLE_WRITE_VECTORS=1 cargo test --test vectors`.

mod common;

use common::{sig64, v1_size};
use serde_json::{json, Value};
use solana_program::hash::hashv;
use solana_sdk::{
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    signer::keypair::keypair_from_seed,
};
use x402_settle::{
    crypto,
    instruction::{self as ix, WireClose, WireVoucher},
    state::*,
};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/x402_settle_v1.json");

fn hx(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn h32(tag: &str, i: u64) -> [u8; 32] {
    hashv(&[tag.as_bytes(), &i.to_le_bytes()]).to_bytes()
}

fn kp(i: u64) -> (Keypair, [u8; 32]) {
    let seed = h32("seed", i);
    (keypair_from_seed(&seed).unwrap(), seed)
}

/// V1 transaction bytes: header, config mask (compute limit and loaded-data
/// size), blockhash, counts, addresses, config values, instruction headers
/// and bodies, then the signatures over everything before them.
pub fn v1_serialize(msg: &Message, cu_limit: u32, loaded: u32, signers: &[&Keypair]) -> Vec<u8> {
    let mut m = vec![
        129u8,
        msg.header.num_required_signatures,
        msg.header.num_readonly_signed_accounts,
        msg.header.num_readonly_unsigned_accounts,
    ];
    m.extend_from_slice(&((1u32 << 2) | (1u32 << 3)).to_le_bytes());
    m.extend_from_slice(msg.recent_blockhash.as_ref());
    m.push(msg.instructions.len() as u8);
    m.push(msg.account_keys.len() as u8);
    for k in &msg.account_keys {
        m.extend_from_slice(k.as_ref());
    }
    m.extend_from_slice(&cu_limit.to_le_bytes());
    m.extend_from_slice(&loaded.to_le_bytes());
    for ci in &msg.instructions {
        m.push(ci.program_id_index);
        m.push(ci.accounts.len() as u8);
        m.extend_from_slice(&(ci.data.len() as u16).to_le_bytes());
    }
    for ci in &msg.instructions {
        m.extend_from_slice(&ci.accounts);
        m.extend_from_slice(&ci.data);
    }
    let mut out = m.clone();
    for k in &msg.account_keys[..msg.header.num_required_signatures as usize] {
        let s = signers.iter().find(|s| s.pubkey() == *k).expect("signer");
        out.extend_from_slice(&sig64(s, &m));
    }
    out
}

fn build() -> Value {
    let pid = x402_settle::id();
    let pidb = pid.to_bytes();
    let (payer, payer_seed) = kp(1);
    let (payee, payee_seed) = kp(2);
    let (fee_payer, fee_seed) = kp(3);
    let mint = Pubkey::new_from_array(h32("mint", 1));

    // Salt.
    let salt_cases: Vec<Value> = (0..3u64)
        .map(|i| {
            let m = if i == 0 { [0u8; 32] } else { h32("mint", i) };
            let sh = h32("slot_hash", i);
            let slot = 400_000_000 + i * 17;
            json!({ "program_id": hx(&pidb), "mint": hx(&m), "slot": slot.to_string(), "slot_hash": hx(&sh),
                    "salt": hx(&crypto::ledger_salt(&pidb, &m, slot, &sh)) })
        })
        .collect();
    let salt = crypto::ledger_salt(&pidb, &mint.to_bytes(), 400_000_000, &h32("slot_hash", 0));

    // Vouchers.
    let voucher_cases: Vec<Value> = (0..5u64)
        .map(|i| {
            let scope = 1 + i * 3;
            let cum = 1_000 + i * i * 7_919;
            let expiry = 400_001_000 + i;
            let q = h32("quote", i);
            let msg = crypto::voucher_message(&pidb, &mint.to_bytes(), &salt, &payer.pubkey().to_bytes(), &payee.pubkey().to_bytes(), scope, cum, expiry, &q);
            let sig = sig64(&payer, &msg);
            let w = WireVoucher { escrow_ix: 1 + i as u8, pair_ix: i as u8, book_ix: 9, slot: 3 * i as u8, cumulative: cum, expiry_slot: expiry, quote_hash: q, sig };
            let mut wire = vec![];
            w.encode(&mut wire);
            let c = WireClose { channel_ix: 2 + i as u8, book_ix: ix::NO_BOOK, slot: i as u8, cumulative: cum, expiry_slot: expiry, quote_hash: q, sig };
            let mut cwire = vec![];
            c.encode(&mut cwire);
            let delta = cum / 2 + 1;
            assert!(crypto::verify(&payer.pubkey().to_bytes(), &msg, &sig));
            json!({
                "scope": scope.to_string(), "cumulative": cum.to_string(), "expiry_slot": expiry.to_string(), "quote_hash": hx(&q),
                "message": hx(&msg), "signature": hx(&sig),
                "wire": { "escrow_ix": w.escrow_ix, "pair_ix": w.pair_ix, "book_ix": w.book_ix, "slot": w.slot, "hex": hx(&wire) },
                "close_wire": { "channel_ix": c.channel_ix, "book_ix": c.book_ix, "slot": c.slot, "hex": hx(&cwire) },
                "delta": delta.to_string(), "leaf": hx(&crypto::batch_leaf(delta, &msg)),
            })
        })
        .collect();

    // Merkle.
    let zeros: Vec<String> = (0..9).map(|h| hx(&crypto::zero_root(h))).collect();
    let leaves: Vec<[u8; 32]> = (0..11u64).map(|i| h32("leaf", i)).collect();
    let (chunk_log, chunk_size) = (2u32, 3usize);
    let chunk_roots: Vec<[u8; 32]> = leaves.chunks(chunk_size).map(|c| crypto::subtree_root(c, chunk_log)).collect();
    let depth = crypto::upper_depth(chunk_roots.len() as u32);
    // root and proofs by explicit padding
    let mut lvl = chunk_roots.clone();
    let mut zero = crypto::zero_root(chunk_log);
    let mut levels = vec![];
    for _ in 0..depth {
        if lvl.len() % 2 == 1 {
            lvl.push(zero);
        }
        levels.push(lvl.clone());
        lvl = lvl.chunks(2).map(|c| crypto::node(&c[0], &c[1])).collect();
        zero = crypto::node(&zero, &zero);
    }
    let root = lvl[0];
    let proofs: Vec<Value> = (0..chunk_roots.len())
        .map(|c| {
            let mut idx = c;
            let p: Vec<[u8; 32]> = levels
                .iter()
                .map(|l| {
                    let s = l[idx ^ 1];
                    idx /= 2;
                    s
                })
                .collect();
            assert_eq!(crypto::fold_proof(chunk_roots[c], c as u32, &p), root);
            json!(p.iter().map(|x| hx(x)).collect::<Vec<_>>())
        })
        .collect();

    // PDAs.
    let (ledger_sol, b0) = ix::ledger_pda(&pid, &ix::SOL_MINT);
    let (ledger, b1) = ix::ledger_pda(&pid, &mint.to_bytes());
    let (vault, b2) = ix::vault_pda(&pid, &ledger);
    let (escrow, b3) = ix::escrow_pda(&pid, &ledger, &payer.pubkey());
    let (book, b4) = ix::book_pda(&pid, &ledger, 3);
    let (channel, b5) = ix::channel_pda(&pid, &ledger, &payer.pubkey(), &payee.pubkey(), 5);
    let (batch, b6) = ix::batch_pda(&pid, &ledger, 9);
    let pda = |k: Pubkey, b: u8| json!({ "address": k.to_string(), "bump": b });

    // Instruction data.
    let w0 = WireVoucher::decode(&hex_to(&voucher_cases[0]["wire"]["hex"]));
    let c0 = WireClose::decode(&hex_to(&voucher_cases[0]["close_wire"]["hex"]));
    let spl = ix::SplAccounts { vault, mint, token_program: x402_settle::token::TOKEN_ID };
    let ixs: Vec<(&str, solana_program::instruction::Instruction)> = vec![
        ("init_ledger_sol", ix::init_ledger_sol(&pid, &fee_payer.pubkey())),
        ("init_ledger_spl", ix::init_ledger_spl(&pid, &fee_payer.pubkey(), &mint, &x402_settle::token::TOKEN_ID, KIND_TOKEN)),
        ("open_escrow", ix::open_escrow(&pid, &ledger, &payer.pubkey(), 8)),
        ("grow_escrow", ix::grow_escrow(&pid, &ledger, &payer.pubkey(), 9)),
        ("deposit_sol", ix::deposit(&pid, &ledger_sol, &payer.pubkey(), &payer.pubkey(), 123_456, None)),
        ("deposit_spl", ix::deposit(&pid, &ledger, &payer.pubkey(), &payer.pubkey(), 123_456, Some((Pubkey::new_from_array(h32("src", 0)), spl)))),
        ("request_exit", ix::request_exit(&pid, &ledger, &payer.pubkey(), 77)),
        ("withdraw_escrow", ix::withdraw_escrow(&pid, &ledger, &payer.pubkey(), &payer.pubkey(), Some(spl))),
        ("close_escrow", ix::close_escrow(&pid, &ledger, &payer.pubkey())),
        ("create_book", ix::create_book(&pid, &ledger, &fee_payer.pubkey(), 3)),
        ("register_payee", ix::register_payee(&pid, &book, &payee.pubkey(), 4)),
        ("withdraw_payee", ix::withdraw_payee(&pid, &ledger, &book, &payee.pubkey(), 4, 999, &payee.pubkey(), None)),
        ("settle", ix::settle(&pid, &ledger, &[escrow, book], &[w0])),
        ("open_channel", ix::open_channel(&pid, &ledger, &payer.pubkey(), &payee.pubkey(), 5, 50_000, 400_100_000)),
        ("close_channels", ix::close_channels(&pid, &ledger, &[channel, book], &[payee.pubkey()], &[c0])),
        ("request_channel_close", ix::request_channel_close(&pid, &ledger, &payer.pubkey(), &channel)),
        ("finalize_channel", ix::finalize_channel(&pid, &channel, Some((&book, 4)), Some(&payee.pubkey()))),
        ("reclaim_channel", ix::reclaim_channel(&pid, &ledger, &channel, &payer.pubkey())),
        ("begin_batch", ix::begin_batch(&pid, &ledger, &fee_payer.pubkey(), 9, &root, 11, 5_000, 2, 3)),
        ("stage_chunk", ix::stage_chunk(&pid, &ledger, &batch, &[escrow], &[book], 1, &[root, chunk_roots[0]], &[w0])),
        ("commit_batch", ix::commit_batch(&pid, &batch, &[book])),
        ("abort_batch", ix::abort_batch(&pid, &batch, &fee_payer.pubkey())),
        ("resolve_staged", ix::resolve_staged(&pid, &batch, &[escrow], &[(1, 0)])),
        ("close_batch", ix::close_batch(&pid, &batch, &fee_payer.pubkey())),
    ];
    let ix_cases: Vec<Value> = ixs
        .iter()
        .map(|(name, i)| {
            json!({
                "name": name, "data": hx(&i.data),
                "accounts": i.accounts.iter().map(|a| json!({ "pubkey": a.pubkey.to_string(), "signer": a.is_signer, "writable": a.is_writable })).collect::<Vec<_>>(),
            })
        })
        .collect();

    // Account layouts.
    let lg = Ledger {
        bump: 254, vault_bump: 253, kind: KIND_TOKEN, decimals: 6, mint: mint.to_bytes(), token_program: x402_settle::token::TOKEN_ID.to_bytes(),
        vault: vault.to_bytes(), salt, exit_delay_slots: EXIT_DELAY_SLOTS, dispute_slots: DISPUTE_SLOTS, batch_timeout_slots: BATCH_TIMEOUT_SLOTS,
        liabilities: 9_876_543_210, next_scope: 42, created_slot: 400_000_001,
    };
    let mut lgb = vec![0u8; LEDGER_LEN];
    lg.pack(&mut lgb);
    let ch = Channel {
        bump: 251, status: CH_CLOSING, ledger: ledger.to_bytes(), payer: payer.pubkey().to_bytes(), payee: payee.pubkey().to_bytes(), channel_id: 5,
        scope: 17, deposit: 50_000, balance: 40_000, best_cum: 10_000, expiry_slot: 400_100_000, dispute_end_slot: 400_001_500,
    };
    let mut chb = vec![0u8; CHANNEL_LEN];
    ch.pack(&mut chb);
    let bh = BatchHdr {
        bump: 250, status: B_STAGING, chunk_log: 2, chunk_size: 3, n_payees: 1, num_chunks: 4, chunks_staged: 1, ledger: ledger.to_bytes(),
        submitter: fee_payer.pubkey().to_bytes(), batch_id: 9, root, count: 11, staged_count: 3, total: 5_000, staged_total: 1_200, held: 1_200,
        deadline_slot: 400_001_500, outstanding: 3,
    };
    let mut bhb = vec![0u8; BATCH_HDR];
    bh.pack(&mut bhb);

    // Full V1 transaction: a settle of the five vouchers (fee payer signs).
    let ws: Vec<WireVoucher> = voucher_cases.iter().map(|v| WireVoucher::decode(&hex_to(&v["wire"]["hex"]))).collect();
    let accounts: Vec<Pubkey> = (0..9u64).map(|i| Pubkey::new_from_array(h32("acct", i))).collect();
    let settle = ix::settle(&pid, &ledger, &accounts, &ws);
    let bhash = solana_sdk::hash::Hash::new_from_array(h32("blockhash", 0));
    let msg = Message::new_with_blockhash(&[settle.clone()], Some(&fee_payer.pubkey()), &bhash);
    let tx = v1_serialize(&msg, 1_400_000, 1 << 20, &[&fee_payer]);
    let (size, addrs, sigs) = v1_size(&[settle], &fee_payer.pubkey());
    assert_eq!(size, tx.len());

    json!({
        "version": 1,
        "program_id": pid.to_string(),
        "constants": {
            "voucher_tag": hx(crypto::VOUCHER_TAG), "msg_len": crypto::MSG_LEN, "voucher_wire_len": ix::VOUCHER_WIRE_LEN, "close_wire_len": ix::CLOSE_WIRE_LEN,
            "exit_delay_slots": EXIT_DELAY_SLOTS, "dispute_slots": DISPUTE_SLOTS, "batch_timeout_slots": BATCH_TIMEOUT_SLOTS,
            "ledger_len": LEDGER_LEN, "escrow_hdr": ESCROW_HDR, "pair_len": PAIR_LEN, "book_len": BOOK_LEN, "book_slots": BOOK_SLOTS,
            "channel_len": CHANNEL_LEN, "batch_len": BATCH_LEN, "max_batch_payees": MAX_BATCH_PAYEES, "error_base": x402_settle::error::ERROR_BASE,
        },
        "keys": {
            "payer": { "seed": hx(&payer_seed), "pubkey": payer.pubkey().to_string() },
            "payee": { "seed": hx(&payee_seed), "pubkey": payee.pubkey().to_string() },
            "fee_payer": { "seed": hx(&fee_seed), "pubkey": fee_payer.pubkey().to_string() },
        },
        "mint": mint.to_string(),
        "salt_cases": salt_cases,
        "salt": hx(&salt),
        "vouchers": voucher_cases,
        "merkle": {
            "zeros": zeros, "leaves": leaves.iter().map(|x| hx(x)).collect::<Vec<_>>(), "chunk_log": chunk_log, "chunk_size": chunk_size,
            "chunk_roots": chunk_roots.iter().map(|x| hx(x)).collect::<Vec<_>>(), "depth": depth, "root": hx(&root), "proofs": proofs,
        },
        "pdas": {
            "ledger_sol": pda(ledger_sol, b0), "ledger": pda(ledger, b1), "vault": pda(vault, b2), "escrow": pda(escrow, b3),
            "book_3": pda(book, b4), "channel_5": pda(channel, b5), "batch_9": pda(batch, b6),
        },
        "instructions": ix_cases,
        "layouts": { "ledger": hx(&lgb), "channel": hx(&chb), "batch_hdr": hx(&bhb) },
        "v1_settle": {
            "accounts": accounts.iter().map(|k| k.to_string()).collect::<Vec<_>>(), "blockhash": bhash.to_string(), "cu_limit": 1_400_000, "loaded_bytes": 1 << 20,
            "size": size, "addresses": addrs, "signatures": sigs, "tx": hx(&tx),
        },
    })
}

fn hex_to(v: &Value) -> Vec<u8> {
    let s = v.as_str().unwrap();
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn vectors_match_file() {
    let v = build();
    let text = serde_json::to_string_pretty(&v).unwrap() + "\n";
    if std::env::var("X402_SETTLE_WRITE_VECTORS").is_ok() {
        std::fs::write(PATH, &text).unwrap();
        return;
    }
    let disk = std::fs::read_to_string(PATH).expect("vector file missing: run with X402_SETTLE_WRITE_VECTORS=1");
    assert_eq!(disk, text, "vectors changed; regenerate with X402_SETTLE_WRITE_VECTORS=1");
}
