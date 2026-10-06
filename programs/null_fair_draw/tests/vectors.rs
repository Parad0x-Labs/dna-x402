// Cross-language vectors: leaves, sum-tree roots and proofs, seeds, stream
// blocks, wide reduction, winner sequences, instruction encodings and the
// draw account layout. packages/fair-draw recomputes the same file.
//
// Regenerate with `NFD_WRITE_VECTORS=1 cargo test --test vectors`.

use null_fair_draw::{
    instruction::{CreateParams, DrawInstruction, LeafProof},
    state::{Draw, RoundInfo, Slot, Tier, MAX_ROUNDS, MAX_TIERS, MODE_LIST, SLOT_WON, STATUS_RESOLVING},
    stream, sumtree,
};
use serde_json::{json, Value};
use solana_program::hash::hashv;

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/fair_draw_v1.json");

fn hx(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn h32(tag: &str, i: u64) -> [u8; 32] {
    hashv(&[tag.as_bytes(), &i.to_le_bytes()]).to_bytes()
}

fn build() -> Value {
    let zeros: Vec<String> = sumtree::ZEROS.iter().map(|z| hx(z)).collect();

    let leaves: Vec<Value> = (0..5u64)
        .map(|i| {
            let draw = h32("draw", i);
            let wallet = h32("wallet", i);
            let weight = [1u64, 7, 1_000_000, u64::MAX / 3, 42][i as usize];
            json!({ "draw": hx(&draw), "wallet": hx(&wallet), "weight": weight.to_string(),
                    "leaf": hx(&sumtree::leaf(&draw, &wallet, weight)) })
        })
        .collect();

    // Trees: (weights, depth); wallets h32("w", i), draw h32("tree-draw", case).
    let tree_cases: Vec<(Vec<u64>, usize)> = vec![
        (vec![1], 1),
        (vec![3, 4, 1, 7, 5], 3),
        (vec![1, 1, 1, 1, 1, 1, 1], 3),
        (vec![10, 0, 5], 2),
        ((1..=13).collect(), 20),
        (vec![2, 9], 22),
    ];
    let trees: Vec<Value> = tree_cases
        .iter()
        .enumerate()
        .map(|(c, (weights, depth))| {
            let draw = h32("tree-draw", c as u64);
            let pairs: Vec<sumtree::Pair> = weights
                .iter()
                .enumerate()
                .map(|(i, &w)| (sumtree::leaf(&draw, &h32("w", i as u64), w), w))
                .collect();
            let (root, total) = sumtree::root_of(&pairs, *depth);
            let mut start = 0u64;
            let proofs: Vec<Value> = weights
                .iter()
                .enumerate()
                .map(|(i, &w)| {
                    let p = sumtree::proof_of(&pairs, *depth, i);
                    let ok = sumtree::verify(&root, total, *depth, weights.len() as u64, i as u64, &pairs[i].0, w, &p);
                    let v = json!({ "index": i, "path": hx(&p), "start": start.to_string(), "valid": ok.is_some() });
                    start += w;
                    v
                })
                .collect();
            json!({ "draw": hx(&draw), "weights": weights.iter().map(|w| w.to_string()).collect::<Vec<_>>(),
                    "depth": depth, "root": hx(&root), "total": total.to_string(), "proofs": proofs })
        })
        .collect();

    let seeds: Vec<Value> = (0..3u64)
        .map(|i| {
            let draw = h32("seed-draw", i);
            let hash = h32("slot-hash", i);
            let root = h32("root", i);
            let s = stream::seed(&draw, i as u8, 1_000 + i, 1_001 + i, &hash, &root, 77 * (i + 1), 5 + i);
            json!({ "draw": hx(&draw), "round": i, "target_slot": (1_000 + i).to_string(), "used_slot": (1_001 + i).to_string(),
                    "slot_hash": hx(&hash), "root": hx(&root), "total": (77 * (i + 1)).to_string(), "count": (5 + i).to_string(),
                    "seed": hx(&s) })
        })
        .collect();

    let mods = [1u64, 2, 3, 97, 1_000_003, (1u64 << 63) + 5, u64::MAX];
    let blocks: Vec<Value> = (0..4u64)
        .map(|j| {
            let s = h32("stream-seed", j);
            let b = stream::block(&s, j * 1_000);
            json!({ "seed": hx(&s), "j": (j * 1_000).to_string(), "block": hx(&b),
                    "mods": mods.iter().map(|m| json!({ "m": m.to_string(), "r": stream::wide_mod(&b, *m).to_string() })).collect::<Vec<_>>() })
        })
        .collect();

    // Winner sequences.
    let draw_cases: Vec<(Vec<u64>, Vec<usize>, u64, usize)> = vec![
        ((0..10).map(|_| 1).collect(), vec![], 0, 10),
        (vec![3, 4, 1, 7, 5], vec![], 0, 6),
        (vec![1_000, 1, 0, 2], vec![], 0, 4),
        (vec![4, 1, 2, 7, 3, 5], vec![0, 3], 7, 3),
        ((1..=50).collect(), vec![], 0, 25),
    ];
    let draws: Vec<Value> = draw_cases
        .iter()
        .enumerate()
        .map(|(c, (weights, won, start, slots))| {
            let s = h32("draw-seed", c as u64);
            let w = stream::reference_draw(weights, won, &s, *start, *slots);
            json!({ "weights": weights.iter().map(|w| w.to_string()).collect::<Vec<_>>(), "already_won": won,
                    "seed": hx(&s), "first_slot": start.to_string(), "slots": slots,
                    "winners": w.iter().map(|x| x.map(|i| i as i64).unwrap_or(-1)).collect::<Vec<_>>() })
        })
        .collect();

    // Instruction encodings.
    let proof = LeafProof { leaf_index: 5, wallet: h32("wallet", 5), weight: 9, path: (0..3).flat_map(|i| {
        let mut v = h32("path", i).to_vec();
        v.extend_from_slice(&(i * 11).to_le_bytes());
        v
    }).collect() };
    let create = DrawInstruction::CreateDraw {
        draw_id: 42,
        params: CreateParams {
            mode: 0,
            weighted: true,
            redraw_rounds: 2,
            tiers: vec![Tier { count: 1, amount: 1_000_000_000 }, Tier { count: 5, amount: 100_000_000 }, Tier { count: 50, amount: 10_000_000 }],
            entry_price: 5_000_000,
            wallet_cap: 10,
            close_slot: 123_456,
            claim_window_slots: 216_000,
            prize_mint: [0; 32],
            entry_mint: h32("entry-mint", 0),
            fee_dest: h32("fee", 0),
        },
    };
    let ixs = json!([
        { "name": "create_draw", "hex": hx(&create.pack()) },
        { "name": "fund_prizes", "hex": hx(&DrawInstruction::FundPrizes.pack()) },
        { "name": "enter", "hex": hx(&DrawInstruction::Enter { count: 3, owner: h32("owner", 1) }.pack()) },
        { "name": "commit_list", "hex": hx(&DrawInstruction::CommitList { root: h32("root", 9), total_weight: 20, leaf_count: 5, depth: 3 }.pack()) },
        { "name": "draw", "hex": hx(&DrawInstruction::Draw.pack()) },
        { "name": "resolve", "hex": hx(&DrawInstruction::Resolve { max: 1, proofs: vec![proof.clone()] }.pack()) },
        { "name": "resolve_unweighted", "hex": hx(&DrawInstruction::Resolve { max: 0, proofs: vec![] }.pack()) },
        { "name": "claim", "hex": hx(&DrawInstruction::Claim { slot: 3, proof: Some(proof.clone()) }.pack()) },
        { "name": "claim_no_proof", "hex": hx(&DrawInstruction::Claim { slot: 3, proof: None }.pack()) },
        { "name": "advance", "hex": hx(&DrawInstruction::Advance.pack()) },
        { "name": "reclaim", "hex": hx(&DrawInstruction::Reclaim.pack()) },
        { "name": "close", "hex": hx(&DrawInstruction::Close.pack()) },
        { "name": "cancel", "hex": hx(&DrawInstruction::Cancel.pack()) },
        { "name": "prove_entry", "hex": hx(&DrawInstruction::ProveEntry { proof }.pack()) },
        { "name": "close_entrant", "hex": hx(&DrawInstruction::CloseEntrant.pack()) },
        { "name": "extend", "hex": hx(&DrawInstruction::Extend.pack()) },
    ]);

    // Account layout: a list draw with capacity 4 (2 prizes, 1 re-draw round).
    let mut tiers = [Tier::default(); MAX_TIERS];
    tiers[0] = Tier { count: 1, amount: 500 };
    tiers[1] = Tier { count: 1, amount: 100 };
    let mut rounds = [RoundInfo::default(); MAX_ROUNDS];
    rounds[0] = RoundInfo { first_target: 1_032, target_slot: 1_032, used_slot: 1_033, attempt: 0, slot_hash: h32("acct-hash", 0), seed: h32("acct-seed", 0) };
    let d = Draw {
        organizer: h32("organizer", 0),
        draw_id: 7,
        bump: 254,
        vault_bump: 253,
        mode: MODE_LIST,
        weighted: true,
        status: STATUS_RESOLVING,
        round: 0,
        redraw_rounds: 1,
        tier_count: 2,
        depth: 3,
        won_count: 1,
        prize_mint: h32("mint", 0),
        entry_mint: [0; 32],
        fee_dest: [0; 32],
        entry_price: 0,
        wallet_cap: 0,
        close_slot: 0,
        claim_window_slots: 216_000,
        tiers,
        total_prize: 600,
        funded: 600,
        paid: 0,
        returned: 0,
        refundable: 0,
        root: h32("acct-root", 0),
        total_weight: 20,
        leaf_count: 5,
        commit_slot: 1_000,
        won_weight: 3,
        capacity: 4,
        slot_count: 2,
        next_slot: 1,
        round_first_slot: 0,
        window_end: 0,
        rounds,
    };
    let mut bytes = vec![0u8; d.len()];
    d.pack(&mut bytes);
    let s0 = Slot { start: 0, weight: 3, leaf_index: 0, wallet: h32("wallet", 0), tier: 0, status: SLOT_WON, round: 0 };
    d.write_slot(&mut bytes, 0, &s0);
    d.write_slot(&mut bytes, 1, &Slot { tier: 1, ..Slot::default() });
    let mut dm = d;
    dm.won_count = 0;
    dm.won_insert(&mut bytes, 0, 3);
    assert_eq!(Draw::unpack(&bytes), Some(d));
    let account = json!({
        "hex": hx(&bytes),
        "organizer": hx(&d.organizer), "draw_id": "7", "bump": 254, "vault_bump": 253, "mode": 1, "weighted": true,
        "status": 3, "redraw_rounds": 1, "tier_count": 2, "depth": 3, "won_count": 1,
        "tiers": [{ "count": 1, "amount": "500" }, { "count": 1, "amount": "100" }],
        "total_prize": "600", "funded": "600", "root": hx(&d.root), "total_weight": "20", "leaf_count": "5",
        "capacity": 4, "slot_count": 2, "next_slot": 1, "claim_window_slots": "216000",
        "round0": { "first_target": "1032", "target_slot": "1032", "used_slot": "1033", "attempt": "0",
                    "slot_hash": hx(&rounds[0].slot_hash), "seed": hx(&rounds[0].seed) },
        "slot0": { "start": "0", "weight": "3", "leaf_index": "0", "wallet": hx(&s0.wallet), "tier": 0, "status": 1, "round": 0 },
        "won0": ["0", "3"],
    });

    // PDAs (program id h32("program", i)).
    let pdas: Vec<Value> = (0..3u64)
        .map(|i| {
            let program = solana_program::pubkey::Pubkey::new_from_array(h32("program", i));
            let organizer = solana_program::pubkey::Pubkey::new_from_array(h32("organizer", i));
            let owner = solana_program::pubkey::Pubkey::new_from_array(h32("owner", i));
            let (dk, db) = null_fair_draw::instruction::draw_address(&program, &organizer, i * 1_000 + 1);
            let (vk, vb) = null_fair_draw::instruction::vault_address(&program, &dk);
            let (ek, eb) = null_fair_draw::instruction::entrant_address(&program, &dk, &owner);
            json!({ "program": program.to_string(), "organizer": organizer.to_string(), "draw_id": (i * 1_000 + 1).to_string(),
                    "draw": dk.to_string(), "draw_bump": db, "vault": vk.to_string(), "vault_bump": vb,
                    "owner": owner.to_string(), "entrant": ek.to_string(), "entrant_bump": eb })
        })
        .collect();

    // A consistent resolved draw for the TS verify(): list mode, weighted, three
    // prizes, round 0 resolved (slot 2 not claimed), one re-draw round resolved.
    let vdraw = h32("verify-draw", 0);
    let ventries: Vec<([u8; 32], u64)> = (0..9u64).map(|i| (h32("vw", i), [5, 1, 3, 8, 2, 2, 7, 1, 4][i as usize])).collect();
    let vpairs: Vec<sumtree::Pair> = ventries.iter().map(|(w, x)| (sumtree::leaf(&vdraw, w, *x), *x)).collect();
    let vdepth = 4usize;
    let (vroot, vtotal) = sumtree::root_of(&vpairs, vdepth);
    let vweights: Vec<u64> = ventries.iter().map(|e| e.1).collect();
    let mut vtiers = [Tier::default(); MAX_TIERS];
    vtiers[0] = Tier { count: 1, amount: 1_000 };
    vtiers[1] = Tier { count: 2, amount: 100 };
    let mut vrounds = [RoundInfo::default(); MAX_ROUNDS];
    let mut vd = Draw {
        organizer: h32("verify-org", 0), draw_id: 3, bump: 255, vault_bump: 0, mode: MODE_LIST, weighted: true,
        status: STATUS_RESOLVING, round: 1, redraw_rounds: 1, tier_count: 2, depth: vdepth as u8, won_count: 0,
        prize_mint: [0; 32], entry_mint: [0; 32], fee_dest: [0; 32], entry_price: 0, wallet_cap: 0, close_slot: 0,
        claim_window_slots: 150, tiers: vtiers, total_prize: 1_200, funded: 1_200, paid: 1_100, returned: 0,
        refundable: 0, root: vroot, total_weight: vtotal, leaf_count: 9, commit_slot: 5_000, won_weight: 0,
        capacity: 6, slot_count: 4, next_slot: 4, round_first_slot: 3, window_end: 5_500, rounds: vrounds,
    };
    let mut vbytes = vec![0u8; vd.len()];
    let mut starts = vec![0u64; 9];
    for i in 1..9 { starts[i] = starts[i - 1] + vweights[i - 1]; }
    let mut won: Vec<usize> = Vec::new();
    for (r, (first_target, used_off, slots, first_slot)) in [(5_032u64, 1u64, 3usize, 0u64), (5_532, 0, 1, 3)].iter().enumerate() {
        let hash = h32("verify-slot-hash", r as u64);
        let target = *first_target;
        let used = target + used_off;
        let seed = stream::seed(&vdraw, r as u8, target, used, &hash, &vroot, vtotal, 9);
        vrounds[r] = RoundInfo { first_target: target, target_slot: target, used_slot: used, attempt: 0, slot_hash: hash, seed };
        let w = stream::reference_draw(&vweights, &won, &seed, *first_slot, *slots);
        for (k, x) in w.iter().enumerate() {
            let i = x.unwrap();
            let j = *first_slot as usize + k;
            let tier = if j == 0 { 0 } else { 1 };
            let status = match j { 2 => null_fair_draw::state::SLOT_FORFEITED, 3 => SLOT_WON, _ => null_fair_draw::state::SLOT_CLAIMED };
            vd.write_slot(&mut vbytes, j, &Slot { start: starts[i], weight: vweights[i], leaf_index: i as u64, wallet: ventries[i].0, tier, status, round: r as u8 });
            vd.won_insert(&mut vbytes, starts[i], vweights[i]);
            vd.won_weight += vweights[i];
            won.push(i);
        }
    }
    vd.rounds = vrounds;
    vd.pack(&mut vbytes);
    assert_eq!(Draw::unpack(&vbytes).map(|x| x.won_count), Some(4));
    let verify_fixture = json!({
        "draw": hx(&vdraw), "hex": hx(&vbytes),
        "entries": ventries.iter().map(|(w, x)| json!({ "wallet": hx(w), "weight": x.to_string() })).collect::<Vec<_>>(),
        "winners": won,
    });

    json!({
        "version": 1,
        "verify": verify_fixture,
        "pdas": pdas,
        "note": "Generated by programs/null_fair_draw/tests/vectors.rs. u64 values are decimal strings. h32(tag, i) = sha256(tag || u64_le(i)). Tree wallets are h32(\"w\", i).",
        "zeros": zeros,
        "leaves": leaves,
        "trees": trees,
        "seeds": seeds,
        "blocks": blocks,
        "draws": draws,
        "instructions": ixs,
        "account": account,
    })
}

#[test]
fn vectors_match_file() {
    let v = build();
    if std::env::var("NFD_WRITE_VECTORS").is_ok() {
        std::fs::write(PATH, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
        return;
    }
    let file: Value = serde_json::from_str(&std::fs::read_to_string(PATH).expect("vectors file")).unwrap();
    assert_eq!(file, v, "vectors drifted; regenerate and re-run the TS tests");
}
