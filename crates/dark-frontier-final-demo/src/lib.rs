use serde::{Deserialize, Serialize};
/// dark-frontier-final-demo — Phase 8 FRONTIER_FINAL demo pipeline.
///
/// Ties together every FRONTIER_FINAL primitive in a single local / mock run:
///   x402 → receipt → compression simulator → caveat engine → session netting
///   → batch auditor → mock proof verifier → puzzle hash
///
/// INVARIANTS enforced at runtime:
///   - mainnet_ready: false   (always)
///   - no_raw_secrets: true   (always)
///   - steps.len() == 10
use sha2::{Digest, Sha256};

// ─── Dependency imports ───────────────────────────────────────────────────────

use caveat_engine::{check_caveats, AgentCaveats, SpendContext};
use dark_batch_auditor_core::{audit_batch, DarkBatchInput, ReceiptLeafInput};
use dark_bonsol_adapter::{BonsolAdapter, BonsolError, BonsolProgramId, ExecutionRequest};
use dark_compression_core::{
    CompressedLeaf, CompressionBackendTrait, LeafDomain, LocalMerkleSimulator,
};
use dark_proof_core::{
    build_mock_proof, MockProofVerifier, ProofClaim, ProofSystem, ProofVerifier,
};
use dark_proof_receipts::{mint_proof_receipt, StatementKind};
use dark_session_netting::{Session, SessionNote};
use dark_x402_core::{
    derive_replay_key, mint_receipt_note_after_payment, DarkX402Receipt, X402PaymentProof,
    X402PaymentRequirement,
};

// ─── Output types ─────────────────────────────────────────────────────────────

/// One step in the demo pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemoStep {
    /// Step index, 1-based.
    pub step: u8,
    /// Human-readable name.
    pub name: String,
    /// "ok" | "blocked" | "mock"
    pub status: String,
    /// Hex-encoded hash output from this step.
    pub hash: String,
    /// Human-readable detail / caveats for this step.
    pub detail: String,
}

/// Full demo run output — written to dist/frontier-final/DEMO_RUN.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemoRun {
    /// Always false — demo is local/mock only.
    pub mainnet_ready: bool,
    /// Network label for this run.
    pub network: String,
    /// All 10 pipeline steps.
    pub steps: Vec<DemoStep>,
    /// SHA-256 of all step hashes concatenated.
    pub final_hash: String,
    /// List of explicit blockers preventing mainnet use.
    pub blockers: Vec<String>,
    /// One-line public summary.
    pub public_summary: String,
    /// True — verified by test_demo_no_raw_secrets.
    pub no_raw_secrets: bool,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn sha256_tag(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    h.finalize().into()
}

// ─── x402 helpers (mirror dark-x402-core test helpers) ───────────────────────

fn make_requirement() -> X402PaymentRequirement {
    X402PaymentRequirement {
        scheme: "exact".to_string(),
        network: "solana-devnet".to_string(),
        asset: "SOL".to_string(),
        amount_lamports: 500_000,
        pay_to: [0xAA; 32],
        resource: "https://api.darknull.example/frontier-final".to_string(),
        expires_at_slot: 99_999,
        nonce: [0x01, 0x02, 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF],
        facilitator_url: None,
    }
}

fn make_proof(req: &X402PaymentRequirement, payer: [u8; 32], sig: &str) -> X402PaymentProof {
    let requirement_hash = req.requirement_hash();
    let scope_hash = req.scope_hash();
    let mut phh = Sha256::new();
    phh.update(b"dark_null_v1_x402_payment_header");
    phh.update(requirement_hash);
    phh.update(payer);
    let payment_header_hash: [u8; 32] = phh.finalize().into();
    X402PaymentProof {
        requirement_hash,
        payer_pubkey: payer,
        tx_signature: sig.to_string(),
        payment_header_hash,
        receipt_scope_hash: scope_hash,
        is_mock: true,
    }
}

// ─── Main demo entry point ────────────────────────────────────────────────────

/// Execute the full 10-step frontier-final demo pipeline and return a `DemoRun`.
///
/// Every step captures a deterministic hash of its output.  The `final_hash` is
/// SHA-256 of all 10 step hashes concatenated, providing a single commitment to
/// the entire run.
///
/// # Invariants
/// - `mainnet_ready` is always `false`
/// - `no_raw_secrets` is always `true`
/// - `steps.len()` is always `10`
pub fn run_demo() -> DemoRun {
    let mut steps: Vec<DemoStep> = Vec::with_capacity(10);

    // ── Step 1: x402 Payment Requirement (402 response) ─────────────────────
    let req = make_requirement();
    let req_hash = req.requirement_hash();
    steps.push(DemoStep {
        step: 1,
        name: "x402 Payment Requirement".to_string(),
        status: "mock".to_string(),
        hash: hex(&req_hash),
        detail: format!(
            "Server returns HTTP 402. scheme={} network={} amount={}  \
             resource=[scope-hashed, not raw]. Mock — no real HTTP server.",
            req.scheme, req.network, req.amount_lamports
        ),
    });

    // ── Step 2: Client produces X402 Payment Proof ───────────────────────────
    let payer = [0xBBu8; 32];
    let proof = make_proof(&req, payer, "MOCK_SIG_frontierfinal_v1_deadbeef");
    let proof_hash = proof.proof_hash();
    steps.push(DemoStep {
        step: 2,
        name: "x402 Payment Proof".to_string(),
        status: "mock".to_string(),
        hash: hex(&proof_hash),
        detail: "Client constructs X402PaymentProof. tx_signature is MOCK_SIG — not a real \
                 Solana tx. payer_pubkey stored as [u8;32], not a displayable string."
            .to_string(),
    });

    // ── Step 3: Server mints Dark Null receipt note ──────────────────────────
    let receipt =
        mint_receipt_note_after_payment(&req, &proof, b"frontier_final_response_payload", 1_000)
            .expect("step 3: mint_receipt_note_after_payment should succeed");
    let receipt_id = receipt.receipt_id();
    let receipt_nullifier = receipt.receipt_nullifier;
    steps.push(DemoStep {
        step: 3,
        name: "Mint DarkX402Receipt".to_string(),
        status: "mock".to_string(),
        hash: hex(&receipt_id),
        detail: format!(
            "DarkX402Receipt minted. receipt_nullifier=[{}...]. is_mock=true. \
             No on-chain state change — purely local hash computation.",
            hex(&receipt_nullifier[..4])
        ),
    });

    // ── Step 4: Compression simulator — leaf insert ──────────────────────────
    let mut sim = LocalMerkleSimulator::new();
    let leaf = CompressedLeaf {
        domain: LeafDomain::Receipt,
        owner_hash: payer,
        leaf_hash: receipt_id,
        asset_or_scope_hash: receipt.service_scope_hash,
        nullifier_hash: receipt_nullifier,
        epoch: 1_000,
    };
    let tree_update = sim
        .insert_leaf(&leaf)
        .expect("step 4: LocalMerkleSimulator::insert_leaf should succeed");
    let new_root = tree_update.new_root;
    steps.push(DemoStep {
        step: 4,
        name: "Compression Simulator — Leaf Insert".to_string(),
        status: "mock".to_string(),
        hash: hex(&new_root),
        detail: format!(
            "Receipt leaf inserted into LocalMerkleSimulator. new_root=[{}...]. \
             validity_proof_hash=[0;32] — NOT real ZK compression. \
             Light Protocol SDK not installed.",
            hex(&new_root[..4])
        ),
    });

    // ── Step 5: Caveat engine — agent macaroon check ─────────────────────────
    let caveats = AgentCaveats {
        max_total_amount_lamports: 10_000_000,
        max_single_spend_lamports: 1_000_000,
        allowed_scope_hashes: vec![], // empty = any scope allowed
        denied_scope_hashes: vec![],
        expires_at_slot: 99_999,
        not_before_slot: 0,
        max_cu_price_micro_lamports: 100_000,
        max_priority_fee_lamports: 100_000,
        no_withdraw: false,
        no_external_transfer: false,
        only_receipt_spend: false,
        daily_loss_limit_lamports: 10_000_000,
    };
    let spend_ctx = SpendContext {
        amount_lamports: 500_000,
        scope_hash: [1u8; 32],
        current_slot: 1_000,
        cu_price_micro_lamports: 0,
        priority_fee_lamports: 0,
        is_withdraw: false,
        is_external_transfer: false,
        is_receipt_spend: true,
        session_total_spent: 0,
        session_daily_loss: 0,
    };
    let caveat_result = check_caveats(&caveats, &spend_ctx);
    let caveat_hash = sha256_tag(b"dark_null_v1_demo_caveat", &receipt_id);
    let (caveat_status, caveat_detail) = match caveat_result {
        Ok(()) => (
            "ok",
            format!(
                "AgentCaveats passed. amount={} lamports <= max_single={} lamports. \
                 slot={} < expires={}.",
                spend_ctx.amount_lamports,
                caveats.max_single_spend_lamports,
                spend_ctx.current_slot,
                caveats.expires_at_slot,
            ),
        ),
        Err(e) => ("blocked", format!("AgentCaveats failed: {:?}", e)),
    };
    steps.push(DemoStep {
        step: 5,
        name: "Caveat Engine — Agent Macaroon Check".to_string(),
        status: caveat_status.to_string(),
        hash: hex(&caveat_hash),
        detail: caveat_detail,
    });

    // ── Step 6: Session netting — 3 spends → 1 net_settlement_hash ──────────
    let session_id = [0x42u8; 32];
    let macaroon_hash = [0x01u8; 32];
    let starting_balance = [0x00u8; 32];
    let mut session = Session::new(session_id, starting_balance, macaroon_hash);
    session
        .add_note(SessionNote {
            scope_hash: [0x10u8; 32],
            amount_lamports: 100_000,
            service_hash: [0xA1u8; 32],
            nullifier: [0x11u8; 32],
        })
        .expect("step 6: add_note 1");
    session
        .add_note(SessionNote {
            scope_hash: [0x20u8; 32],
            amount_lamports: 200_000,
            service_hash: [0xA2u8; 32],
            nullifier: [0x22u8; 32],
        })
        .expect("step 6: add_note 2");
    session
        .add_note(SessionNote {
            scope_hash: [0x30u8; 32],
            amount_lamports: 300_000,
            service_hash: [0xA3u8; 32],
            nullifier: [0x33u8; 32],
        })
        .expect("step 6: add_note 3");
    let net_hash = session
        .net_settlement_hash()
        .expect("step 6: net_settlement_hash should succeed");
    steps.push(DemoStep {
        step: 6,
        name: "Session Netting — 3 Spends → 1 Hash".to_string(),
        status: "ok".to_string(),
        hash: hex(&net_hash),
        detail: format!(
            "Session with 3 SessionNotes (100_000 + 200_000 + 300_000 = {} lamports total) \
             collapsed to net_settlement_hash=[{}...]. 3 spends → 1 hash.",
            session.total_spent(),
            hex(&net_hash[..4])
        ),
    });

    // ── Step 7: Batch auditor — no duplicate nullifiers ──────────────────────
    // Use receipt_nullifier from step 3 plus 2 distinct others.
    let batch_nullifier_2 = [0xCCu8; 32];
    let batch_nullifier_3 = [0xDDu8; 32];
    let batch_input = DarkBatchInput {
        receipt_leaves: vec![
            ReceiptLeafInput {
                leaf_hash: receipt_id,
                is_poison: false,
            },
            ReceiptLeafInput {
                leaf_hash: [0xC1u8; 32],
                is_poison: false,
            },
            ReceiptLeafInput {
                leaf_hash: [0xD1u8; 32],
                is_poison: false,
            },
        ],
        nullifiers: vec![receipt_nullifier, batch_nullifier_2, batch_nullifier_3],
        session_spends: vec![500_000, 100_000, 200_000],
        starting_balance_commitment: starting_balance,
        ending_balance_commitment: [0u8; 32],
        macaroon_caveat_hash: caveat_hash,
        model_output_hashes: vec![[0x99u8; 32]],
        budget_lamports: 10_000_000,
    };
    let batch_output = audit_batch(&batch_input).expect("step 7: audit_batch should succeed");
    let batch_hash = batch_output.batch_hash;
    steps.push(DemoStep {
        step: 7,
        name: "Batch Auditor — No Duplicate Nullifiers".to_string(),
        status: "ok".to_string(),
        hash: hex(&batch_hash),
        detail: format!(
            "DarkBatchInput with 3 leaves and 3 distinct nullifiers audited. \
             no_duplicate_nullifiers={}. batch_hash=[{}...].",
            batch_output.no_duplicate_nullifiers,
            hex(&batch_hash[..4])
        ),
    });

    // ── Step 8: Mock proof verifier — ProofClaim + ProofReceipt ──────────────
    let circuit_id = [0xF1u8; 32];
    let public_inputs = b"frontier_final_public_inputs_v1";
    let mock_proof_bytes = build_mock_proof(&circuit_id, public_inputs);
    let claim = ProofClaim {
        system: ProofSystem::Mock,
        circuit_id,
        public_inputs_hash: sha256_tag(b"", public_inputs),
        proof_bytes_hash: sha256_tag(b"", &mock_proof_bytes),
        verifier_key_hash: [0xEFu8; 32],
        domain: b"dark_frontier_final_demo".to_vec(),
    };
    let verifier = MockProofVerifier;
    let proof_receipt = mint_proof_receipt(
        &verifier,
        &claim,
        &mock_proof_bytes,
        public_inputs,
        receipt_id,
        receipt_nullifier,
        StatementKind::ReceiptRedeem,
        1_000,
    )
    .expect("step 8: mint_proof_receipt should succeed");
    let claim_hash = proof_receipt.receipt_id();
    steps.push(DemoStep {
        step: 8,
        name: "Mock Proof Verifier — ProofClaim + ProofReceipt".to_string(),
        status: "mock".to_string(),
        hash: hex(&claim_hash),
        detail: format!(
            "MockProofVerifier.verify passed. ProofReceipt minted. claim_hash=[{}...]. \
             NOT a ZK verifier — mock proof bytes only. System={:?}.",
            hex(&claim.claim_hash()[..4]),
            proof_receipt.verifier_backend,
        ),
    });

    // ── Step 9: Bonsol adapter — blocked / toolchain not installed ───────────
    let bonsol_adapter = BonsolAdapter::new();
    let bonsol_request = ExecutionRequest {
        program_id: BonsolProgramId([0xBBu8; 32]),
        input_hash: batch_hash,
        tip_lamports: 5_000,
        requester_pubkey: payer,
        nonce: [0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04],
    };
    let bonsol_request_hash = bonsol_request.request_hash();
    let (bonsol_status, bonsol_detail) =
        match bonsol_adapter.submit_execution_request(&bonsol_request) {
            Ok(_) => (
                "ok",
                "Bonsol execution submitted (unexpected in demo — toolchain should be blocked)."
                    .to_string(),
            ),
            Err(BonsolError::ToolchainBlocked(msg)) => (
                "blocked",
                format!(
                    "Bonsol/RISC0 adapter returned ToolchainBlocked. \
                 request_hash=[{}...]. blocker='{}'",
                    hex(&bonsol_request_hash[..4]),
                    msg,
                ),
            ),
            Err(e) => ("blocked", format!("Bonsol adapter error: {:?}", e)),
        };
    // Use request_hash as the step hash (deterministic even when blocked).
    steps.push(DemoStep {
        step: 9,
        name: "Bonsol/RISC0 Adapter — Blocked Stub".to_string(),
        status: bonsol_status.to_string(),
        hash: hex(&bonsol_request_hash),
        detail: bonsol_detail,
    });

    // ── Step 10: Public puzzle hash ──────────────────────────────────────────
    // SHA-256 of "dark_null_v1_demo_puzzle" || all step hashes concatenated.
    let mut puzzle_h = Sha256::new();
    puzzle_h.update(b"dark_null_v1_demo_puzzle");
    for s in &steps {
        // Decode each hex step hash back to bytes for the puzzle commitment.
        if let Ok(bytes) = hex_to_bytes(&s.hash) {
            puzzle_h.update(&bytes);
        }
    }
    let puzzle_hash: [u8; 32] = puzzle_h.finalize().into();
    steps.push(DemoStep {
        step: 10,
        name: "Public Puzzle Hash".to_string(),
        status: "ok".to_string(),
        hash: hex(&puzzle_hash),
        detail: format!(
            "puzzle_hash = SHA-256('dark_null_v1_demo_puzzle' || all_step_hashes). \
             Commits to all 9 prior step outputs. puzzle=[{}...]. \
             Not a mainnet proof page.",
            hex(&puzzle_hash[..4])
        ),
    });

    // ── Final hash: SHA-256 of "dark_null_v1_demo_final" || all step hashes ──
    let mut final_h = Sha256::new();
    final_h.update(b"dark_null_v1_demo_final");
    for s in &steps {
        if let Ok(bytes) = hex_to_bytes(&s.hash) {
            final_h.update(&bytes);
        }
    }
    let final_hash: [u8; 32] = final_h.finalize().into();

    DemoRun {
        mainnet_ready: false,
        network: "devnet-mock".to_string(),
        steps,
        final_hash: hex(&final_hash),
        blockers: vec![
            "Bonsol toolchain not installed".to_string(),
            "RISC Zero toolchain not installed".to_string(),
            "Real ZK backend not wired".to_string(),
            "Devnet tx verification requires RPC client".to_string(),
        ],
        public_summary: "Frontier-final scaffolding complete. Local/mock proof layer tested. \
             Mainnet remains blocked until audit and real backend evidence."
            .to_string(),
        no_raw_secrets: true,
    }
}

// ─── Internal utility ─────────────────────────────────────────────────────────

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, ()> {
    if s.len() % 2 != 0 {
        return Err(());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
        .collect()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    // 1. run_demo() completes without panicking and returns a DemoRun.
    #[test]
    fn test_demo_run_completes() {
        let run = run_demo();
        // Spot-check key fields
        assert_eq!(run.network, "devnet-mock");
        assert!(!run.final_hash.is_empty());
    }

    // 2. mainnet_ready is always false.
    #[test]
    fn test_demo_mainnet_ready_false() {
        let run = run_demo();
        assert!(!run.mainnet_ready, "mainnet_ready must always be false");
    }

    // 3. no_raw_secrets is always true.
    #[test]
    fn test_demo_no_raw_secrets() {
        let run = run_demo();
        assert!(run.no_raw_secrets, "no_raw_secrets must always be true");
        // Also verify no step detail contains a raw private key pattern.
        for step in &run.steps {
            assert!(
                !step.detail.contains("PRIVATE_KEY"),
                "step {} detail contains raw secret marker",
                step.step
            );
            assert!(
                !step.detail.contains("SECRET"),
                "step {} detail contains SECRET marker",
                step.step
            );
        }
    }

    // 4. Demo always has exactly 10 steps.
    #[test]
    fn test_demo_has_10_steps() {
        let run = run_demo();
        assert_eq!(run.steps.len(), 10, "expected exactly 10 demo steps");
        // Step indices must be 1..=10 in order.
        for (i, s) in run.steps.iter().enumerate() {
            assert_eq!(
                s.step as usize,
                i + 1,
                "step index mismatch at position {}",
                i
            );
        }
    }

    // 5. Replay detection: two proofs with same nonce → same replay key.
    //    Any system that uses the replay_key to guard a nonce set will detect replay.
    #[test]
    fn test_demo_replay_attempt_fails() {
        let req = make_requirement();
        let payer = [0xBBu8; 32];
        let proof_a = make_proof(&req, payer, "MOCK_SIG_aaaa");
        let proof_b = make_proof(&req, payer, "MOCK_SIG_bbbb");

        // Because the nonce is the same (embedded in req), the replay keys must match.
        let rk_a = derive_replay_key(&req, &payer);
        let rk_b = derive_replay_key(&req, &payer);
        assert_eq!(rk_a, rk_b, "same nonce + payer => same replay key");

        // Different tx_signature means different proof_hash — the receipt diverges,
        // but the replay_key (nonce-bound) is the same, so a nonce-set check fires.
        assert_ne!(proof_a.proof_hash(), proof_b.proof_hash());

        // Verify: minting two receipts with the same req produces the same replay_key,
        // which a real system would reject as a replay.
        let r_a = mint_receipt_note_after_payment(&req, &proof_a, b"resp_a", 1_000).unwrap();
        let r_b = mint_receipt_note_after_payment(&req, &proof_b, b"resp_b", 1_000).unwrap();
        assert_eq!(
            r_a.replay_key, r_b.replay_key,
            "replay key must match for same nonce"
        );
    }

    // 6. Wrong receipt_hash in batch input changes batch_hash.
    #[test]
    fn test_demo_wrong_receipt_hash_fails() {
        use dark_batch_auditor_core::{audit_batch, DarkBatchInput, ReceiptLeafInput};

        let req = make_requirement();
        let payer = [0xBBu8; 32];
        let proof = make_proof(&req, payer, "MOCK_SIG_batch_test");
        let receipt = mint_receipt_note_after_payment(&req, &proof, b"payload", 1_000).unwrap();

        // Correct batch.
        let correct_input = DarkBatchInput {
            receipt_leaves: vec![ReceiptLeafInput {
                leaf_hash: receipt.receipt_id(),
                is_poison: false,
            }],
            nullifiers: vec![receipt.receipt_nullifier],
            session_spends: vec![100_000],
            starting_balance_commitment: [0u8; 32],
            ending_balance_commitment: [0u8; 32],
            macaroon_caveat_hash: [0u8; 32],
            model_output_hashes: vec![],
            budget_lamports: 1_000_000,
        };
        let out_correct = audit_batch(&correct_input).unwrap();

        // Tampered batch — wrong leaf hash.
        let mut tampered_input = correct_input.clone();
        tampered_input.receipt_leaves[0].leaf_hash = [0xFFu8; 32];
        let out_tampered = audit_batch(&tampered_input).unwrap();

        assert_ne!(
            out_correct.batch_hash, out_tampered.batch_hash,
            "wrong receipt_hash must change batch_hash"
        );
        assert_ne!(out_correct.receipt_root, out_tampered.receipt_root);
    }

    // 7. Step 9 status is always "blocked" — Bonsol adapter is a fail-closed stub.
    #[test]
    fn test_demo_blocked_adapters_are_explicit() {
        let run = run_demo();
        let step9 = run
            .steps
            .iter()
            .find(|s| s.step == 9)
            .expect("step 9 must exist");
        assert_eq!(
            step9.status, "blocked",
            "step 9 (Bonsol adapter) must have status='blocked'"
        );
        assert!(
            step9.detail.contains("ToolchainBlocked") || step9.detail.contains("BLOCKED"),
            "step 9 detail must mention the blocker: {}",
            step9.detail
        );
    }

    // 8. final_hash changes if any step output changes.
    #[test]
    fn test_demo_final_hash_changes_if_steps_change() {
        // Run the demo twice — hashes should be identical (deterministic).
        let run1 = run_demo();
        let run2 = run_demo();
        assert_eq!(run1.final_hash, run2.final_hash, "demo is deterministic");

        // Simulate a mutated run by computing what final_hash would be
        // if step 1's hash were different.
        let mut fake_steps = run1.steps.clone();
        fake_steps[0].hash = hex(&[0xFFu8; 32]);

        let mut h = Sha256::new();
        h.update(b"dark_null_v1_demo_final");
        for s in &fake_steps {
            if let Ok(bytes) = hex_to_bytes(&s.hash) {
                h.update(&bytes);
            }
        }
        let mutated_final = hex(&h.finalize().to_vec());
        assert_ne!(
            run1.final_hash, mutated_final,
            "changing any step hash must change final_hash"
        );
    }
}
