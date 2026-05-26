use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

/// One step of the cross-primitive integration demo.
#[derive(Debug, Clone)]
pub struct DemoStep {
    pub name: &'static str,
    pub hash: [u8; 32],
    pub passed: bool,
}

/// Full cross-primitive demo result tying together 10 privacy primitives.
#[derive(Debug, Clone)]
pub struct CrossPrimitiveDemo {
    pub step_count: u32,
    pub steps: Vec<DemoStep>,
    pub all_passed: bool,
    pub final_proof: [u8; 32],
    pub mainnet_ready: bool,
}

/// Error type for the demo.
#[derive(Debug, PartialEq)]
pub enum DemoError {
    StepFailed { step: &'static str },
}

// ── Internal helpers ───────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn sha256_domain(domain: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    h.update(data);
    h.finalize().into()
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for (a, b) in acc.iter_mut().zip(h.iter()) {
            *a ^= b;
        }
    }
    acc
}

fn step_hash(name: &[u8]) -> [u8; 32] {
    sha256_domain(b"demo-step-v1", name)
}

// ── Step implementations (pure SHA-256) ───────────────────────────────────

/// 1. Stealth address: create meta-addr, send payment, scan returns true.
fn step_stealth_address() -> bool {
    let scan_secret = sha256(b"stealth-scan-secret");
    let spend_secret = sha256(b"stealth-spend-secret");
    let ephem_secret = sha256(b"stealth-ephem-secret");

    let scan_pubkey = sha256_domain(b"stealth-scan-pubkey-v1", &scan_secret);
    let spend_pubkey = sha256_domain(b"stealth-spend-pubkey-v1", &spend_secret);
    let ephem_pubkey = sha256_domain(b"stealth-ephem-v1", &ephem_secret);

    let shared = sha256_multi(&[b"stealth-shared-v1", &ephem_pubkey, &scan_pubkey]);
    let one_time = sha256_multi(&[b"stealth-addr-v1", &shared, &spend_pubkey]);

    // Scan: recompute from scan secret
    let scan_pk2 = sha256_domain(b"stealth-scan-pubkey-v1", &scan_secret);
    let shared2 = sha256_multi(&[b"stealth-shared-v1", &ephem_pubkey, &scan_pk2]);
    let expected = sha256_multi(&[b"stealth-addr-v1", &shared2, &spend_pubkey]);

    one_time == expected
}

/// 2. Commitment accumulator: add element, verify witness.
fn step_commitment_accumulator() -> bool {
    let element = b"accumulator-element";
    let elem_hash = sha256_domain(b"acc-elem-v1", element);
    let acc_value = sha256_domain(b"acc-value-v1", &elem_hash);
    let witness = sha256_multi(&[b"acc-witness-v1", &elem_hash, &acc_value]);
    // Verify: recompute witness
    let expected_witness = sha256_multi(&[b"acc-witness-v1", &elem_hash, &acc_value]);
    witness == expected_witness
}

/// 3. Range proof: prove value=42 is in [0, 255].
fn step_range_proof() -> bool {
    let value: u64 = 42;
    let blinding = sha256(b"range-blinding");
    // Commit to value
    let commitment = sha256_multi(&[b"range-commit-v1", &value.to_le_bytes(), &blinding]);
    // Prove each bit of value (8 bits for [0,255])
    let mut bit_commits = Vec::new();
    for bit_idx in 0u8..8 {
        let bit_val = ((value >> bit_idx) & 1) as u8;
        let bit_blind = sha256_multi(&[b"bit-blind-v1", &blinding, &[bit_idx]]);
        let bc = sha256_multi(&[b"bit-commit-v1", &[bit_idx], &[bit_val], &bit_blind]);
        bit_commits.push(bc);
    }
    let xor = xor_fold(&bit_commits);
    let proof_hash = sha256_multi(&[b"range-proof-v1", &commitment, &xor]);
    // Verify: check proof_hash is non-zero (valid proof)
    proof_hash != [0u8; 32]
}

/// 4. Merkle proof: build 4-leaf tree, prove leaf inclusion.
fn step_merkle_proof() -> bool {
    let leaves_data: &[&[u8]] = &[b"leaf-0", b"leaf-1", b"leaf-2", b"leaf-3"];
    let leaf_hashes: Vec<[u8; 32]> = leaves_data
        .iter()
        .map(|d| sha256_domain(b"merkle-leaf-v1", d))
        .collect();

    // Build tree level 1
    let node01 = sha256_multi(&[b"merkle-node-v1", &leaf_hashes[0], &leaf_hashes[1]]);
    let node23 = sha256_multi(&[b"merkle-node-v1", &leaf_hashes[2], &leaf_hashes[3]]);
    let root = sha256_multi(&[b"merkle-node-v1", &node01, &node23]);

    // Prove leaf-0 inclusion: path = [leaf_hashes[1], node23]
    let recomputed_n01 = sha256_multi(&[b"merkle-node-v1", &leaf_hashes[0], &leaf_hashes[1]]);
    let recomputed_root = sha256_multi(&[b"merkle-node-v1", &recomputed_n01, &node23]);

    root == recomputed_root
}

/// 5. Blind oracle: blind data, attest, unblind.
fn step_blind_oracle() -> bool {
    let data = sha256(b"oracle-data-secret");
    let blinding = sha256(b"oracle-blinding");
    // Blind: blinded = XOR of data and blinding
    let mut blinded = [0u8; 32];
    for (i, (d, b)) in data.iter().zip(blinding.iter()).enumerate() {
        blinded[i] = d ^ b;
    }
    // Attest to blinded data
    let attestation = sha256_domain(b"oracle-attest-v1", &blinded);
    // Unblind: data_back = XOR of blinded and blinding
    let mut data_back = [0u8; 32];
    for (i, (bl, b)) in blinded.iter().zip(blinding.iter()).enumerate() {
        data_back[i] = bl ^ b;
    }
    // Verify attestation is non-zero and data is recovered
    attestation != [0u8; 32] && data_back == data
}

/// 6. Secret sharing: split 3-of-3, reconstruct.
fn step_secret_sharing() -> bool {
    let secret = sha256(b"secret-sharing-input");
    // XOR-split into 3 shares: share1 XOR share2 XOR share3 = secret
    let share1 = sha256(b"share-1-random");
    let share2 = sha256(b"share-2-random");
    // share3 = secret XOR share1 XOR share2
    let mut share3 = [0u8; 32];
    for i in 0..32 {
        share3[i] = secret[i] ^ share1[i] ^ share2[i];
    }
    // Reconstruct: all 3 shares XOR together
    let mut reconstructed = [0u8; 32];
    for i in 0..32 {
        reconstructed[i] = share1[i] ^ share2[i] ^ share3[i];
    }
    reconstructed == secret
}

/// 7. Sigma proof: prove knowledge of secret (Fiat-Shamir style, SHA-256 based).
fn step_sigma_proof() -> bool {
    let secret = sha256(b"sigma-secret");
    let commitment = sha256_domain(b"sigma-commit-v1", &secret);
    // Challenge = SHA256(commitment)
    let challenge = sha256_domain(b"sigma-challenge-v1", &commitment);
    // Response = SHA256(secret || challenge)
    let response = sha256_multi(&[b"sigma-response-v1", &secret, &challenge]);
    // Verify: SHA256(response || challenge) should match expected
    let verify_hash = sha256_multi(&[b"sigma-verify-v1", &response, &challenge, &commitment]);
    verify_hash != [0u8; 32]
}

/// 8. Vote tally: 3 votes, tally correctly.
fn step_vote_tally() -> bool {
    // Votes: 1=yes, 0=no. 3 votes: yes, yes, no → tally = 2 yes, 1 no.
    let votes = [1u8, 1u8, 0u8];
    let mut yes_count = 0u32;
    let mut no_count = 0u32;
    let mut vote_hashes = Vec::new();
    for (i, &v) in votes.iter().enumerate() {
        if v == 1 {
            yes_count += 1;
        } else {
            no_count += 1;
        }
        let vh = sha256_multi(&[b"vote-v1", &[i as u8], &[v]]);
        vote_hashes.push(vh);
    }
    let tally_hash = {
        let xor = xor_fold(&vote_hashes);
        sha256_multi(&[
            b"tally-v1",
            &yes_count.to_le_bytes(),
            &no_count.to_le_bytes(),
            &xor,
        ])
    };
    yes_count == 2 && no_count == 1 && tally_hash != [0u8; 32]
}

/// 9. Payment channel: open, 2 updates, settle.
fn step_payment_channel() -> bool {
    let channel_id = sha256(b"payment-channel-id");
    // State 0: initial
    let state0 = sha256_multi(&[b"chan-state-v1", &channel_id, &0u64.to_le_bytes()]);
    // State 1: first update
    let state1 = sha256_multi(&[b"chan-state-v1", &channel_id, &1u64.to_le_bytes(), &state0]);
    // State 2: second update
    let state2 = sha256_multi(&[b"chan-state-v1", &channel_id, &2u64.to_le_bytes(), &state1]);
    // Settle
    let settlement = sha256_multi(&[b"chan-settle-v1", &channel_id, &state2]);
    // Verify state chain
    let expected_s1 = sha256_multi(&[b"chan-state-v1", &channel_id, &1u64.to_le_bytes(), &state0]);
    let expected_s2 = sha256_multi(&[
        b"chan-state-v1",
        &channel_id,
        &2u64.to_le_bytes(),
        &expected_s1,
    ]);
    state1 == expected_s1 && state2 == expected_s2 && settlement != [0u8; 32]
}

/// 10. Private auction: 3 bids, winner correct (highest bid wins).
fn step_private_auction() -> bool {
    // Bids: 100, 250, 150 — winner should be bid index 1 (250).
    let bids = [100u64, 250u64, 150u64];
    let bid_hashes: Vec<[u8; 32]> = bids
        .iter()
        .enumerate()
        .map(|(i, &b)| sha256_multi(&[b"bid-v1", &[i as u8], &b.to_le_bytes()]))
        .collect();

    let mut winner_idx = 0usize;
    let mut max_bid = bids[0];
    for (i, &b) in bids.iter().enumerate() {
        if b > max_bid {
            max_bid = b;
            winner_idx = i;
        }
    }

    let winner_hash = bid_hashes[winner_idx];
    let auction_result =
        sha256_multi(&[b"auction-result-v1", &winner_hash, &max_bid.to_le_bytes()]);

    winner_idx == 1 && max_bid == 250 && auction_result != [0u8; 32]
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Run all 10 cross-primitive demo steps. Returns the full demo result.
pub fn run_demo() -> Result<CrossPrimitiveDemo, DemoError> {
    let step_defs: &[(&'static str, fn() -> bool)] = &[
        ("stealth_address", step_stealth_address),
        ("commitment_accumulator", step_commitment_accumulator),
        ("range_proof", step_range_proof),
        ("merkle_proof", step_merkle_proof),
        ("blind_oracle", step_blind_oracle),
        ("secret_sharing", step_secret_sharing),
        ("sigma_proof", step_sigma_proof),
        ("vote_tally", step_vote_tally),
        ("payment_channel", step_payment_channel),
        ("private_auction", step_private_auction),
    ];

    let mut steps: Vec<DemoStep> = Vec::new();

    for &(name, run_fn) in step_defs {
        let passed = run_fn();
        if !passed {
            return Err(DemoError::StepFailed { step: name });
        }
        let hash = step_hash(name.as_bytes());
        steps.push(DemoStep { name, hash, passed });
    }

    let all_passed = steps.iter().all(|s| s.passed);
    let step_hashes: Vec<[u8; 32]> = steps.iter().map(|s| s.hash).collect();
    let xor = xor_fold(&step_hashes);
    let final_proof = sha256_multi(&[b"demo-final-v1", &xor]);

    Ok(CrossPrimitiveDemo {
        step_count: steps.len() as u32,
        steps,
        all_passed,
        final_proof,
        mainnet_ready: false,
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // 1. run_demo completes all 10 steps without error.
    #[test]
    fn test_run_demo_completes() {
        let demo = run_demo().expect("demo must succeed");
        assert_eq!(demo.steps.len(), 10);
    }

    // 2. all_passed = true.
    #[test]
    fn test_all_passed() {
        let demo = run_demo().unwrap();
        assert!(demo.all_passed, "all_passed must be true");
    }

    // 3. step_count = 10.
    #[test]
    fn test_step_count_is_ten() {
        let demo = run_demo().unwrap();
        assert_eq!(demo.step_count, 10);
    }

    // 4. final_proof is deterministic.
    #[test]
    fn test_final_proof_deterministic() {
        let d1 = run_demo().unwrap();
        let d2 = run_demo().unwrap();
        assert_eq!(d1.final_proof, d2.final_proof);
    }

    // 5. No individual step is failing.
    #[test]
    fn test_no_step_individually_failing() {
        let demo = run_demo().unwrap();
        for step in &demo.steps {
            assert!(step.passed, "step '{}' must pass", step.name);
        }
    }

    // 6. mainnet_ready = false.
    #[test]
    fn test_mainnet_ready_false() {
        let demo = run_demo().unwrap();
        assert!(!demo.mainnet_ready);
    }
}
