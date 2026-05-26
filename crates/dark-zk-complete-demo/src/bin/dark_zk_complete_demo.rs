// DARK ZK COMPLETE DEMO
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false
//
// Demonstrates the complete DARK_ZK_PRIMITIVES_V1 flow:
// 1. Create note commitment (deposit)
// 2. Generate BN254 withdrawal proof bundle
// 3. Verify circuit constraints
// 4. Make shielded x402 payment for alpha signal
// 5. Verify buyer identity hidden from signal seller
// 6. Compress note to 32-byte leaf (99.8% rent savings modelled)
// 7. Build complete evidence JSON
// Output: dist/dark-zk/DARK_ZK_COMPLETE.json

use sha2::{Digest, Sha256};

fn sha256_pair(label: &str, value: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(label.as_bytes());
    h.update(value.as_bytes());
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn main() {
    println!("DARK_ZK_PRIMITIVES_V1");
    println!("=====================");
    println!("NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false");
    println!();

    let mut steps_proven = 0u32;

    // -----------------------------------------------------------------------
    // Real data
    // -----------------------------------------------------------------------
    let secret = sha256_pair("demo-secret", "dark-zk-demo-v1");
    let slot: u64 = 400_000_000;
    let value: u64 = 1_000_000_000; // 1 SOL in lamports
    let recipient_hash = sha256_pair("recipient", "alice-wallet");
    let amount_to_withdraw: u64 = 500_000_000; // 0.5 SOL

    // -----------------------------------------------------------------------
    // Step 1 — Create note commitment (deposit)
    // -----------------------------------------------------------------------
    let note = dark_shielded_client::create_note_from_secret(&secret, value, &recipient_hash, slot);
    steps_proven += 1;
    println!("✅ Step 1 — Note commitment created");

    // -----------------------------------------------------------------------
    // Step 2 — Generate BN254 withdrawal proof bundle
    // -----------------------------------------------------------------------
    // Build the circuit inputs: we need the nullifier derived from the note
    // commitment, the secret, and a merkle root (zero root for devnet demo).
    let merkle_root = [0u8; 32];
    let nullifier = dark_poseidon_bn254::nullifier_hash(&note.commitment, &secret, &merkle_root);

    let circuit_inputs = dark_bn254_circuit::WithdrawCircuitInputs {
        merkle_root,
        nullifier,
        withdraw_amount: amount_to_withdraw,
        note_value: value,
        note_randomness: dark_shielded_client::derive_randomness(&secret, slot),
        note_secret: secret,
        recipient_hash,
    };

    let proof_bundle = dark_bn254_proof_gen::generate_devnet_test_proof(&circuit_inputs)
        .expect("proof generation must succeed for valid inputs");

    steps_proven += 1;
    println!("✅ Step 2 — BN254 proof bundle generated (devnet test mode)");

    // -----------------------------------------------------------------------
    // Step 3 — Verify circuit constraints
    // -----------------------------------------------------------------------
    let pub_inputs = dark_bn254_circuit::simulate_verify(&circuit_inputs)
        .expect("circuit verification must pass for valid inputs");

    let constraints = dark_bn254_circuit::circuit_constraints_description();
    let constraint_list = constraints.join(", ");

    steps_proven += 1;
    println!(
        "✅ Step 3 — Circuit constraints verified: [{}]",
        constraint_list
    );

    // -----------------------------------------------------------------------
    // Step 4 — Purchase alpha signal via shielded x402 payment
    // -----------------------------------------------------------------------
    let listing = dark_anon_signal::SignalListing {
        signal_hash: sha256_pair("signal", "epl-man-utd-model-v3"),
        price_lamports: 1_000_000,
        seller_hash: sha256_pair("seller", "nulla-analyst"),
        expiry_slot: slot + 100_000,
    };

    let buyer_hash = sha256_pair("buyer", "anon-trader");
    let payment = dark_anon_signal::PlainX402Payment {
        buyer_hash,
        amount_lamports: 1_000_000,
        service_hash: sha256_pair("service", "nulla-signal-service"),
        payment_tx_hash: sha256_pair("tx", "mock-payment-tx"),
        slot,
    };

    // Nonce for commitment blinding
    let nonce = sha256_pair("nonce", "dark-zk-demo-nonce-v1");

    let purchase = dark_anon_signal::purchase_signal(&listing, &payment, &nonce, slot)
        .expect("signal purchase must succeed");

    steps_proven += 1;
    println!("✅ Step 4 — Signal purchased via shielded x402 payment");

    // -----------------------------------------------------------------------
    // Step 5 — Verify buyer identity hidden from seller
    // -----------------------------------------------------------------------
    let seller_view = dark_anon_signal::seller_sees_only_commitment(&purchase);
    let seller_json_str = seller_view.to_string();
    let buyer_hash_hex = hex(&buyer_hash);
    let buyer_hidden = !seller_json_str.contains(&buyer_hash_hex);

    // Confirm expected fields present, buyer absent
    let has_commitment_hash = seller_json_str.contains("commitment_hash");
    assert!(
        has_commitment_hash,
        "seller view must contain commitment_hash"
    );
    assert!(buyer_hidden, "seller view must not contain buyer_hash");
    // Also confirm "buyer_hash" key itself is absent from the seller view JSON
    assert!(
        !seller_json_str.contains("buyer_hash"),
        "seller view must not contain buyer_hash field"
    );

    steps_proven += 1;
    println!(
        "✅ Step 5 — Buyer identity hidden from seller: {}",
        buyer_hidden
    );

    // -----------------------------------------------------------------------
    // Step 6 — Compress note to 32-byte leaf
    // -----------------------------------------------------------------------
    let compressed_leaf = dark_note_compression::compress_note(&note, 0, slot);
    let savings_report = dark_note_compression::compute_compression_savings(1);

    steps_proven += 1;
    println!(
        "✅ Step 6 — Note compressed: {} → {} bytes, savings: {:.1}%",
        savings_report.regular_pda_bytes,
        savings_report.compressed_leaf_bytes,
        savings_report.savings_pct
    );

    // -----------------------------------------------------------------------
    // Step 7 — Build complete evidence JSON and write to dist/dark-zk/
    // -----------------------------------------------------------------------
    let all_steps_proven = steps_proven == 6;
    let proof_json = dark_bn254_proof_gen::proof_bundle_to_json(&proof_bundle);
    let compression_json = dark_note_compression::compression_report_json(&savings_report);

    let evidence = serde_json::json!({
        "schema": "DARK_ZK_COMPLETE_V1",
        "slot": slot,
        "mainnet_ready": false,
        "production_claim": false,
        "agent_had_private_key": false,
        "devnet_only": true,
        "not_audited": true,
        "all_steps_proven": all_steps_proven,
        "steps_proven": steps_proven,
        "step1_note": {
            "commitment": hex(&note.commitment),
            "value": note.value,
            "deposited_at_slot": note.deposited_at_slot,
        },
        "step2_proof_bundle": proof_json,
        "step3_circuit": {
            "constraints": dark_bn254_circuit::circuit_constraints_description(),
            "merkle_root": hex(&pub_inputs.merkle_root),
            "nullifier": hex(&pub_inputs.nullifier),
            "withdraw_amount": pub_inputs.withdraw_amount,
        },
        "step4_signal_purchase": {
            "signal_hash": hex(&purchase.signal_hash),
            "purchased_at_slot": purchase.purchased_at_slot,
            "receipt_commitment": hex(&purchase.receipt.commitment_hash),
        },
        "step5_seller_view": seller_view,
        "step5_buyer_hidden": buyer_hidden,
        "step6_compression": {
            "commitment": hex(&compressed_leaf.commitment),
            "leaf_index": compressed_leaf.leaf_index,
            "savings_report": compression_json,
        },
    });

    // Write evidence to dist/dark-zk/DARK_ZK_COMPLETE.json
    // Resolve the dist path relative to the workspace root (two levels up from the crate).
    let dist_path = {
        // Prefer the CARGO_MANIFEST_DIR env var set by cargo at build time;
        // fall back to the current working directory.
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
        // manifest_dir is <repo-root>\crates\dark-zk-complete-demo
        let base = std::path::PathBuf::from(&manifest_dir);
        // go up to workspace root, then into dist/dark-zk
        base.join("..").join("..").join("dist").join("dark-zk")
    };

    // Ensure the dist directory exists (it may only have .gitkeep)
    std::fs::create_dir_all(&dist_path).expect("could not create dist/dark-zk directory");

    let out_path = dist_path.join("DARK_ZK_COMPLETE.json");
    let json_str = serde_json::to_string_pretty(&evidence).expect("serialisation must not fail");
    std::fs::write(&out_path, json_str).expect("could not write DARK_ZK_COMPLETE.json");

    println!();
    if all_steps_proven {
        println!("✅ All 7 steps proven. DARK_ZK_PRIMITIVES_V1 complete.");
        println!("   Evidence written to dist/dark-zk/DARK_ZK_COMPLETE.json");
        std::process::exit(0);
    } else {
        eprintln!("❌ Not all steps proven (proven: {}/6)", steps_proven);
        std::process::exit(1);
    }
}
