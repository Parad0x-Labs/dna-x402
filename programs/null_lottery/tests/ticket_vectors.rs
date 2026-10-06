// Cross-language vectors for the tickets tree (ticket.rs), the fallback
// selection, draw_numbers and the ClaimJackpot instruction data. The
// null-miner-sdk lottery tests check the TypeScript implementation against them.
//
//   TICKET_VECTORS_OUT=<file>   write the vectors (pseudo-random cases)
//   TICKET_VECTORS_SEED=<u64>   PRNG seed (default DEFAULT_SEED)
//
// Without TICKET_VECTORS_OUT the committed SDK fixture, when present, must equal
// the output for the default seed.

use dark_null_lottery::{
    processor::draw_numbers,
    ticket::{
        fallback_winner_index, root_from_proof, sorted_numbers, ticket_leaf, tickets_proof,
        tickets_root, tree_depth,
    },
};
use std::fmt::Write as _;

const DEFAULT_SEED: u64 = 0x7E57_DA7A_0F7A_11B0;
const CASES: usize = 12;
const FIXTURE: &str = "../../packages/null-miner-sdk/tests/fixtures/lottery-ticket-vectors.json";

struct SplitMix(u64);
impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn bytes32(&mut self) -> [u8; 32] {
        let mut b = [0u8; 32];
        for c in b.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes());
        }
        b
    }
    fn numbers(&mut self) -> [u8; 5] {
        let mut out = [0u8; 5];
        let mut n = 0;
        while n < 5 {
            let x = (self.next() % 30) as u8 + 1;
            if !out[..n].contains(&x) {
                out[n] = x;
                n += 1;
            }
        }
        sorted_numbers(&out)
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn claim_data(nullifier: &[u8; 32], numbers: &[u8; 5], index: u64, proof: &[[u8; 32]]) -> Vec<u8> {
    let mut d = vec![0x06u8];
    d.extend_from_slice(nullifier);
    d.extend_from_slice(numbers);
    d.extend_from_slice(&index.to_le_bytes());
    d.push(proof.len() as u8);
    for h in proof {
        d.extend_from_slice(h);
    }
    d
}

fn generate(prng_seed: u64) -> String {
    let mut r = SplitMix(prng_seed);
    let mut out = String::new();
    write!(out, "{{\n  \"generator\": \"programs/null_lottery/tests/ticket_vectors.rs\",\n  \"prngSeed\": \"{prng_seed}\",\n  \"cases\": [").unwrap();
    for case in 0..CASES {
        let round_id = if case % 3 == 0 { r.next() } else { r.next() % 1000 };
        let count = (r.next() % 13 + 1) as usize;
        let seed = r.bytes32();
        let tickets: Vec<([u8; 32], [u8; 5], [u8; 32])> =
            (0..count).map(|_| (r.bytes32(), r.numbers(), r.bytes32())).collect();
        let leaves: Vec<[u8; 32]> =
            tickets.iter().map(|(o, n, x)| ticket_leaf(round_id, o, n, x)).collect();
        let root = tickets_root(&leaves);
        let index = fallback_winner_index(&seed, round_id, count as u64);
        assert!(index < count as u64);
        let drawn = draw_numbers(&seed, round_id);

        write!(out, "{}\n    {{\n      \"roundId\": \"{round_id}\",\n      \"seed\": \"{}\",\n      \"drawn\": {:?},\n      \"fallbackIndex\": {index},\n      \"root\": \"{}\",\n      \"tickets\": [",
            if case == 0 { "" } else { "," }, hex(&seed), drawn, hex(&root)).unwrap();
        for (i, (owner, numbers, nullifier)) in tickets.iter().enumerate() {
            let proof = tickets_proof(&leaves, i);
            assert_eq!(proof.len(), tree_depth(count as u64));
            assert_eq!(root_from_proof(leaves[i], i as u64, &proof), root);
            let proof_hex: Vec<String> = proof.iter().map(|h| format!("\"{}\"", hex(h))).collect();
            write!(out, "{}\n        {{ \"owner\": \"{}\", \"numbers\": {:?}, \"nullifier\": \"{}\", \"leaf\": \"{}\", \"proof\": [{}] }}",
                if i == 0 { "" } else { "," }, hex(owner), numbers, hex(nullifier), hex(&leaves[i]), proof_hex.join(", ")).unwrap();
        }
        let (_, numbers, nullifier) = &tickets[index as usize];
        let data = claim_data(nullifier, numbers, index, &tickets_proof(&leaves, index as usize));
        write!(out, "\n      ],\n      \"fallbackClaimData\": \"{}\"\n    }}", hex(&data)).unwrap();
    }
    out.push_str("\n  ]\n}\n");
    out
}

#[test]
fn ticket_vectors() {
    let seed = std::env::var("TICKET_VECTORS_SEED")
        .ok()
        .map(|s| s.parse::<u64>().expect("TICKET_VECTORS_SEED must be a u64"))
        .unwrap_or(DEFAULT_SEED);
    let json = generate(seed);
    if let Ok(path) = std::env::var("TICKET_VECTORS_OUT") {
        std::fs::write(&path, &json).expect("write vectors");
        return;
    }
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    if let Ok(committed) = std::fs::read_to_string(&fixture) {
        assert_eq!(seed, DEFAULT_SEED, "compare the fixture with the default seed");
        assert!(committed == json, "SDK fixture differs from ticket.rs output; regenerate with TICKET_VECTORS_OUT");
    }
}
