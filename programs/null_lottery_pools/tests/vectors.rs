// Cross-language vectors: leaf, tree root and proofs, fee split, cap, draw
// selection and numbers, instruction encodings. The TypeScript client in
// packages/lottery-pools recomputes the same file.
//
// Regenerate with `NLP_WRITE_VECTORS=1 cargo test --test vectors`.

use null_lottery_pools::{
    draw::{self, Selection},
    econ::{self, PoolParams},
    instruction::PoolInstruction,
    state::{Pool, Round, POOL_LEN, ROUND_DRAWN, ROUND_LEN},
    tree,
};
use serde_json::{json, Value};
use solana_program::hash::hashv;

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/lottery_pools_v1.json");

fn hx(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn h32(tag: &str, i: u64) -> [u8; 32] {
    hashv(&[tag.as_bytes(), &i.to_le_bytes()]).to_bytes()
}

fn nums(v: &[u8]) -> [u8; 8] {
    let mut a = [0u8; 8];
    a[..v.len()].copy_from_slice(v);
    a
}

fn build() -> Value {
    // Zero table.
    let zeros: Vec<String> = tree::ZEROS.iter().map(|z| hx(z)).collect();

    // Leaves.
    let leaf_cases: Vec<Value> = (0..6u64)
        .map(|i| {
            let pool = h32("pool", i);
            let owner = h32("owner", i);
            let numbers = nums(&[(1 + i) as u8, (7 + 3 * i) as u8, 40]);
            let round_id = i * 1_000_003;
            let index = i * i * 97;
            json!({
                "pool": hx(&pool), "round_id": round_id.to_string(), "owner": hx(&owner),
                "numbers": numbers.to_vec(), "ticket_index": index.to_string(),
                "leaf": hx(&tree::ticket_leaf(&pool, round_id, &owner, &numbers, index)),
            })
        })
        .collect();

    // Trees.
    let tree_cases: Vec<Value> = [0usize, 1, 2, 3, 5, 8, 13]
        .iter()
        .map(|&n| {
            let leaves: Vec<[u8; 32]> = (0..n as u64).map(|i| h32("leaf", i)).collect();
            let root = tree::root_of(&leaves);
            let proofs: Vec<Value> = (0..n)
                .filter(|i| i % 2 == 0 || *i == n - 1)
                .map(|i| json!({ "index": i, "proof": tree::proof_of(&leaves, i).iter().map(|p| hx(p)).collect::<Vec<_>>() }))
                .collect();
            json!({ "leaves": leaves.iter().map(|l| hx(l)).collect::<Vec<_>>(), "root": hx(&root), "proofs": proofs })
        })
        .collect();

    // Fee splits.
    let mut fee_cases = Vec::new();
    let pools = [
        (1_000_000_000u64, 10_000_000u64, 2_500u16, 200u16, 500u16),
        (5_000_000, 3_000_000, 2_500, 200, 500),
        (7, 10_007, 3_000, 0, 2_000),
        (123_456_789, 1_234_567, 1_777, 13, 333),
        (50_000_000, 10_000_000, 0, 0, 1_000),
    ];
    for (seed, price, fmax, fmin, res) in pools {
        let vr = econ::recoup_volume(seed, fmax).unwrap();
        let p = PoolParams {
            seed,
            ticket_price: price,
            fee_max_bps: fmax,
            fee_min_bps: fmin,
            reserve_bps: res,
            cap_bps: 7_000,
            pick_k: 5,
            range_n: 36,
            round_slots: 150,
            claim_window_slots: 150,
        };
        let vs = [0, price, vr.saturating_sub(price / 3), vr.saturating_sub(1), vr, vr.saturating_add(price / 2), vr.saturating_mul(3), vr.saturating_mul(1_000)];
        for v in vs.map(|v| v.min(u64::MAX / 4)) {
            for retired in [false, true] {
                let s = econ::split_ticket(&p, vr, v, retired).unwrap();
                fee_cases.push(json!({
                    "seed": seed.to_string(), "ticket_price": price.to_string(),
                    "fee_max_bps": fmax, "fee_min_bps": fmin, "reserve_bps": res,
                    "recoup_volume": vr.to_string(), "v_before": v.to_string(), "retired": retired,
                    "rate_bps": econ::fee_rate(vr, fmax, fmin, v),
                    "creator": s.creator.to_string(), "reserve": s.reserve.to_string(), "jackpot": s.jackpot.to_string(),
                }));
            }
        }
    }

    // Caps.
    let cap_cases: Vec<Value> = [(7_000u16, 10_000_000u64, 5u8, 36u8), (7_000, 10_000_000, 1, 4), (1_000, 12_345, 8, 80), (9_000, 1_000_000_000, 6, 49)]
        .iter()
        .map(|&(b, p, k, n)| {
            let c = econ::binom(n, k).unwrap();
            json!({ "cap_bps": b, "ticket_price": p.to_string(), "k": k, "n": n, "combos": c.to_string(), "cap": econ::jackpot_cap(b, p, c).unwrap().to_string() })
        })
        .collect();

    // Slot selection.
    let windows: Vec<(u64, Vec<u64>)> = vec![
        (1_000, (980..=1_040).step_by(3).collect()),           // covered, T_0 = 1_032 skipped -> 1_034
        (1_000, (1_100..=1_700).step_by(25).collect()),        // aged out -> T_1 = 1_544 -> 1_550
        (1_000, (900..=1_020).step_by(10).collect()),          // too early
        (5_000, vec![4_000, 5_032, 5_544, 6_056]),             // exact T_0
        (5_000, (6_100..=6_600).step_by(50).collect()),        // attempt 3 -> T_3 = 6_568 -> 6_600
    ];
    let sel_cases: Vec<Value> = windows
        .into_iter()
        .map(|(close, slots)| {
            let entries: Vec<(u64, [u8; 32])> = slots.iter().map(|&s| (s, h32("slot", s))).collect();
            let data = draw::encode_slot_hashes(&entries);
            let t0 = draw::first_target(close).unwrap();
            let res = match draw::select(&data, t0) {
                Ok(s) => json!({ "attempt": s.attempt.to_string(), "target_slot": s.target_slot.to_string(), "used_slot": s.used_slot.to_string(), "hash": hx(&s.hash) }),
                Err(e) => json!({ "error": format!("{e:?}") }),
            };
            json!({ "close_slot": close.to_string(), "slots": slots.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "slot_hash_tag": "slot", "result": res })
        })
        .collect();

    // Draws.
    let draw_cases: Vec<Value> = [(5u8, 36u8), (1, 2), (6, 49), (8, 80), (3, 4)]
        .iter()
        .enumerate()
        .map(|(i, &(k, n))| {
            let i = i as u64;
            let pool = h32("pool", 100 + i);
            let sel = Selection { attempt: i % 2, target_slot: 77_000 + i, used_slot: 77_001 + i, hash: h32("hash", i) };
            let root = h32("root", i);
            let count = 1 + 31 * i;
            let e = draw::entropy(&pool, 40 + i, &sel, &root, count);
            json!({
                "pool": hx(&pool), "round_id": (40 + i).to_string(), "attempt": sel.attempt.to_string(),
                "target_slot": sel.target_slot.to_string(), "used_slot": sel.used_slot.to_string(),
                "slot_hash": hx(&sel.hash), "root": hx(&root), "ticket_count": count.to_string(),
                "entropy": hx(&e), "k": k, "n": n, "numbers": draw::draw_numbers(&e, k, n).to_vec(),
            })
        })
        .collect();

    // Instruction encodings.
    let create = PoolInstruction::CreatePool {
        nonce: 42,
        params: PoolParams {
            seed: 1_000_000_000,
            ticket_price: 10_000_000,
            fee_max_bps: 2_500,
            fee_min_bps: 200,
            reserve_bps: 500,
            cap_bps: 7_000,
            pick_k: 5,
            range_n: 36,
            round_slots: 9_000,
            claim_window_slots: 216_000,
        },
    };
    let buy = PoolInstruction::BuyTicket { round_id: 3, owner: h32("owner", 9), numbers: nums(&[3, 9, 17, 22, 35]) };
    let mut proof = [[0u8; 32]; tree::TREE_DEPTH];
    for (i, p) in proof.iter_mut().enumerate() {
        *p = h32("proof", i as u64);
    }
    let claim = PoolInstruction::Claim { ticket_index: 1_234, numbers: nums(&[3, 9, 17, 22, 35]), proof: Box::new(proof) };
    let ix_cases = json!([
        { "name": "create_pool", "hex": hx(&create.pack()) },
        { "name": "buy_ticket", "hex": hx(&buy.pack()) },
        { "name": "claim", "hex": hx(&claim.pack()) },
        { "name": "draw", "hex": hx(&PoolInstruction::Draw.pack()) },
        { "name": "withdraw_creator_fees", "hex": hx(&PoolInstruction::WithdrawCreatorFees { amount: 987_654_321 }.pack()) },
    ]);

    // Account layouts.
    let pool = Pool {
        creator: h32("creator", 1),
        nonce: 2,
        params: PoolParams {
            seed: 3_000_000_000,
            ticket_price: 10_000_000,
            fee_max_bps: 2_500,
            fee_min_bps: 200,
            reserve_bps: 500,
            cap_bps: 7_000,
            pick_k: 5,
            range_n: 36,
            round_slots: 9_000,
            claim_window_slots: 216_000,
        },
        retired: false,
        last_settle_won: true,
        has_pending: true,
        bump: 254,
        combos: 376_992,
        cap: 2_638_944_000_000,
        recoup_volume: 12_000_000_000,
        jackpot: 11,
        reserve: 12,
        creator_owed: 13,
        creator_withdrawn: 14,
        locked_prize: 15,
        owed_prizes: 16,
        total_sales: 17,
        pending_round_id: 18,
        round_id: 19,
        round_open_slot: 20,
        round_close_slot: 21,
        ticket_count: 22,
        root: h32("root", 23),
    };
    let mut pool_bytes = vec![0u8; POOL_LEN];
    pool.pack(&mut pool_bytes);
    let round = Round {
        pool: h32("pool", 31),
        round_id: 32,
        status: ROUND_DRAWN,
        bump: 253,
        attempt: 1,
        target_slot: 33,
        used_slot: 34,
        slot_hash: h32("hash", 35),
        root: h32("root", 36),
        ticket_count: 37,
        numbers: nums(&[1, 2, 3, 4, 5]),
        prize: 38,
        window_end: 39,
        winners: 40,
        share: 41,
        paid: 42,
        rent_payer: h32("payer", 43),
        draw_slot: 44,
    };
    let mut round_bytes = vec![0u8; ROUND_LEN];
    round.pack(&mut round_bytes);
    let accounts = json!({
        "pool_hex": hx(&pool_bytes),
        "pool": { "creator": hx(&pool.creator), "nonce": "2", "seed": "3000000000", "bump": 254, "has_pending": true,
                  "last_settle_won": true, "retired": false, "cap": "2638944000000", "recoup_volume": "12000000000",
                  "jackpot": "11", "owed_prizes": "16", "ticket_count": "22", "root": hx(&pool.root),
                  "claim_window_slots": "216000" },
        "round_hex": hx(&round_bytes),
        "round": { "pool": hx(&round.pool), "round_id": "32", "status": "drawn", "bump": 253, "attempt": "1",
                   "numbers": round.numbers.to_vec(), "prize": "38", "share": "41", "rent_payer": hx(&round.rent_payer),
                   "draw_slot": "44" },
    });

    json!({
        "version": 1,
        "accounts": accounts,
        "note": "Generated by programs/null_lottery_pools/tests/vectors.rs. u64 values are decimal strings. h32(tag, i) = sha256(tag || u64_le(i)).",
        "zeros": zeros,
        "leaves": leaf_cases,
        "trees": tree_cases,
        "fees": fee_cases,
        "caps": cap_cases,
        "selections": sel_cases,
        "draws": draw_cases,
        "instructions": ix_cases,
    })
}

#[test]
fn vectors_match_file() {
    let v = build();
    if std::env::var("NLP_WRITE_VECTORS").is_ok() {
        std::fs::write(PATH, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
        return;
    }
    let file: Value = serde_json::from_str(&std::fs::read_to_string(PATH).expect("vectors file")).unwrap();
    assert_eq!(file, v, "vectors drifted; regenerate and re-run the TS tests");
}
