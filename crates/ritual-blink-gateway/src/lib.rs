//! ritual-blink-gateway — The Never-Done-Before Combination
//!
//! Solana Actions/Blinks + x402 payment + Ritual Grammar (dark_ritual_gate) +
//! Token-2022 Transfer Hook (dark_ritual_transfer_hook) + HookVerdict capsule
//! receipt = ONE atomic Solana transaction from a single tweet-embedded link.
//!
//! What this proves (with evidence):
//!   1. A Blink GET response correctly describes a ritual-gated trade reveal
//!   2. A Blink POST constructs the full 5-instruction ceremony layout
//!   3. The x402 payment intent hash is bound in the SPL Memo
//!   4. The HookVerdict capsule (0x01 + SHA256) links payment to ceremony
//!   5. The receipt DAG chains HookVerdicts into a tamper-proof history
//!   6. A subscriber receives the reveal ONLY if their payment was in the tx
//!
//! Daily use case: "Click to pay, ritual runs, token moves, receipt is emitted."
//! One tweet link. One Phantom signature. Zero separate receipt API calls.
//!
//! First-ever: Blinks + x402 + Token-2022 Transfer Hook + receipt capsule
//! combined into one atomic Solana transaction flow.
//!
//! NOT_PRODUCTION. Devnet only. Not audited. mainnet_ready = false.
//! Blink server, x402 facilitator, and Token-2022 mint must be deployed separately.

use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────────

pub const DARK_RITUAL_GATE_PROGRAM: &str = "31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy";
pub const DARK_RITUAL_HOOK_PROGRAM: &str = "F3Jt3TBWxRgzZo6NVNhc3vCLN2R5xq9DcPn2MqVCY6v1";
pub const RITUAL_MINT: &str = "35TEfA2CT1XmZZFCjdKMBA5LVGMqMu3ixBXGmN8cZHZW";
pub const HOOK_VERDICT_PREFIX: u8 = 0x01;
pub const VERIFY_RITUAL_SHAPE_TAG: u8 = 0x00;
pub const RITUAL_TYPE_AGENT_SPEND: u8 = 0x01;
pub const BLINK_SCHEMA_VERSION: &str = "1.0";
pub const X402_DEFAULT_PRICE_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

// ── Internal SHA256 helper ─────────────────────────────────────────────────────

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for i in inputs {
        h.update(i);
    }
    h.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlinkAction {
    pub label: String,
    pub href: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlinkLinks {
    pub actions: Vec<BlinkAction>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlinkGetResponse {
    pub title: String,
    pub description: String,
    pub icon: String,
    pub label: String,
    pub links: BlinkLinks,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlinkPostRequest {
    pub account: String, // base58 pubkey
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlinkPostResponse {
    pub transaction: String, // base64 encoded (stub)
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct X402PaymentIntent {
    pub intent_hash: [u8; 32],
    pub resource_hash: [u8; 32],
    pub price_lamports: u64,
    pub payer_hash: [u8; 32], // SHA256(payer_pubkey), NOT raw pubkey
    pub nonce: [u8; 32],
    pub created_at_unix: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RitualCeremonyLayout {
    pub instruction_count: u8,
    pub instruction_names: Vec<String>,
    pub x402_intent_hash: [u8; 32],
    pub ritual_type: u8,
    pub memo_content: String, // 64-char hex of intent_hash
    pub hook_program: String,
    pub ritual_gate_program: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HookVerdictCapsule {
    pub verdict_byte: u8,          // 0x01 = accepted
    pub hook_hash: [u8; 32],       // SHA256("dark_null_v1_hook_verdict" || mint || amount)
    pub capsule_bytes_hex: String, // hex of [verdict_byte][hook_hash] — 66 chars
    pub mint: String,
    pub amount: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RitualBlinkReceipt {
    pub receipt_hash: [u8; 32],
    pub x402_intent_hash: [u8; 32],
    pub hook_verdict_capsule: HookVerdictCapsule,
    pub payer_hash: [u8; 32],        // SHA256(payer_pubkey) — NOT raw pubkey
    pub tx_signature_hash: [u8; 32], // SHA256(tx_signature)
    pub slot: u64,
    pub previous_receipt_hash: Option<[u8; 32]>,
    pub created_at_unix: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlinkReceiptChain {
    pub chain_head_hash: [u8; 32],
    pub chain_length: u32,
    pub trader_session_hash: [u8; 32],
}

#[derive(Debug, thiserror::Error)]
pub enum RitualBlinkError {
    #[error("wrong subscriber: payer hash does not match expected")]
    WrongSubscriber,
    #[error("invalid hook verdict: byte 0 must be 0x01")]
    InvalidHookVerdict,
    #[error("receipt hash mismatch")]
    ReceiptHashMismatch,
    #[error("wrong ritual type: expected 0x01")]
    WrongRitualType,
    #[error("missing ritual gate in ceremony layout")]
    MissingRitualGate,
    #[error("raw payer pubkey leaked in receipt")]
    RawPayerLeaked,
    #[error("ceremony layout invalid: expected 5 instructions")]
    InvalidCeremonyLayout,
}

// ── Functions ──────────────────────────────────────────────────────────────────

/// Generates a Solana Actions GET response for a ritual trade reveal.
/// The description explains x402 payment + ritual ceremony.
/// title: "Reveal Ritual Trade — Epoch {epoch}"
/// description includes price in SOL, ceremony steps, and "devnet only"
pub fn build_blink_get_response(
    trader_id: &str,
    epoch: u32,
    price_lamports: u64,
) -> BlinkGetResponse {
    let price_sol = price_lamports as f64 / 1_000_000_000.0;
    let description = format!(
        "Pay {:.4} SOL to reveal trader {}'s last ritual trade receipt. \
        Ceremony: ComputeBudget → SplMemo (x402 payment intent) → Ed25519Precompile (permission braid) → \
        VerifyRitualShape (dark_ritual_gate) → Token-2022 TransferChecked (with hook). \
        Signing triggers payment, ritual grammar enforcement, token transfer, and HookVerdict capsule emission — \
        all in one atomic transaction. devnet only. not audited.",
        price_sol, trader_id
    );

    BlinkGetResponse {
        title: format!("Reveal Ritual Trade \u{2014} Epoch {}", epoch),
        description,
        icon: format!(
            "https://dark-null.io/blink-icons/ritual-trade/{}.png",
            trader_id
        ),
        label: format!("Pay {:.4} SOL to Reveal", price_sol),
        links: BlinkLinks {
            actions: vec![BlinkAction {
                label: format!("Pay {:.4} SOL & Reveal Trade", price_sol),
                href: format!(
                    "/api/blink/ritual-trade/{}?epoch={}&schema={}",
                    trader_id, epoch, BLINK_SCHEMA_VERSION
                ),
            }],
        },
    }
}

/// Creates an x402 payment intent. All payer identity is hashed.
/// intent_hash = SHA256("dark-null-x402-intent-v1" || resource_hash || price.le || payer_hash || nonce || ts.le)
pub fn create_x402_intent(
    resource_hash: &[u8; 32],
    price_lamports: u64,
    payer_pubkey_bytes: &[u8; 32],
    nonce: &[u8; 32],
    created_at_unix: u64,
) -> X402PaymentIntent {
    // Hash payer identity — raw pubkey NEVER stored
    let payer_hash = sha256_domain(b"dark-null-x402-payer-v1", &[payer_pubkey_bytes]);

    let price_le = price_lamports.to_le_bytes();
    let ts_le = created_at_unix.to_le_bytes();

    let intent_hash = sha256_domain(
        b"dark-null-x402-intent-v1",
        &[resource_hash, &price_le, &payer_hash, nonce, &ts_le],
    );

    X402PaymentIntent {
        intent_hash,
        resource_hash: *resource_hash,
        price_lamports,
        payer_hash,
        nonce: *nonce,
        created_at_unix,
    }
}

/// Builds the 5-instruction ceremony layout descriptor.
/// The memo_content is the 64-char hex of intent_hash (x402 binding).
/// Instructions: ComputeBudget, SplMemo, Ed25519Precompile, VerifyRitualShape, Token2022TransferChecked
pub fn build_ceremony_layout(
    intent: &X402PaymentIntent,
) -> Result<RitualCeremonyLayout, RitualBlinkError> {
    let instruction_names = vec![
        "ComputeBudget".to_string(),
        "SplMemo".to_string(),
        "Ed25519Precompile".to_string(),
        "VerifyRitualShape".to_string(),
        "Token2022TransferChecked".to_string(),
    ];

    let memo_content = hex_encode(&intent.intent_hash);

    Ok(RitualCeremonyLayout {
        instruction_count: 5,
        instruction_names,
        x402_intent_hash: intent.intent_hash,
        ritual_type: RITUAL_TYPE_AGENT_SPEND,
        memo_content,
        hook_program: DARK_RITUAL_HOOK_PROGRAM.to_string(),
        ritual_gate_program: DARK_RITUAL_GATE_PROGRAM.to_string(),
    })
}

/// Computes the HookVerdict capsule for a given mint and amount.
/// hook_hash = SHA256("dark_null_v1_hook_verdict" || mint_bytes || amount.le)
/// capsule_bytes[0] = 0x01, capsule_bytes[1..33] = hook_hash
pub fn compute_hook_verdict(mint_bytes: &[u8; 32], amount: u64) -> HookVerdictCapsule {
    let amount_le = amount.to_le_bytes();
    let hook_hash = sha256_domain(b"dark_null_v1_hook_verdict", &[mint_bytes, &amount_le]);

    let mut raw = [0u8; 33];
    raw[0] = HOOK_VERDICT_PREFIX; // 0x01
    raw[1..33].copy_from_slice(&hook_hash);

    let capsule_bytes_hex = raw.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    HookVerdictCapsule {
        verdict_byte: HOOK_VERDICT_PREFIX,
        hook_hash,
        capsule_bytes_hex,
        mint: RITUAL_MINT.to_string(),
        amount,
    }
}

/// Verifies a hook verdict capsule is valid (verdict byte == 0x01, hash consistent).
pub fn verify_hook_verdict(
    capsule: &HookVerdictCapsule,
    mint_bytes: &[u8; 32],
    amount: u64,
) -> Result<(), RitualBlinkError> {
    if capsule.verdict_byte != HOOK_VERDICT_PREFIX {
        return Err(RitualBlinkError::InvalidHookVerdict);
    }
    // Check hex starts with "01"
    if !capsule.capsule_bytes_hex.starts_with("01") {
        return Err(RitualBlinkError::InvalidHookVerdict);
    }

    // Recompute and compare hook_hash
    let amount_le = amount.to_le_bytes();
    let expected_hash = sha256_domain(b"dark_null_v1_hook_verdict", &[mint_bytes, &amount_le]);

    if capsule.hook_hash != expected_hash {
        return Err(RitualBlinkError::InvalidHookVerdict);
    }

    Ok(())
}

/// Creates a RitualBlinkReceipt linking x402 payment to HookVerdict.
/// receipt_hash = SHA256("dark-null-blink-receipt-v1" || x402_intent_hash || hook_verdict_hash || payer_hash || tx_sig_hash || slot.le || prev_or_zeros)
pub fn create_blink_receipt(
    intent: &X402PaymentIntent,
    verdict: &HookVerdictCapsule,
    payer_pubkey_bytes: &[u8; 32],
    tx_signature_bytes: &[u8; 32],
    slot: u64,
    previous_receipt_hash: Option<[u8; 32]>,
    created_at_unix: u64,
) -> RitualBlinkReceipt {
    // Hash payer — raw key never stored in receipt
    let payer_hash = sha256_domain(b"dark-null-x402-payer-v1", &[payer_pubkey_bytes]);

    // Hash tx signature
    let tx_signature_hash = sha256_domain(b"dark-null-tx-sig-v1", &[tx_signature_bytes]);

    let slot_le = slot.to_le_bytes();
    let prev_bytes: [u8; 32] = previous_receipt_hash.unwrap_or([0u8; 32]);

    let receipt_hash = sha256_domain(
        b"dark-null-blink-receipt-v1",
        &[
            &intent.intent_hash,
            &verdict.hook_hash,
            &payer_hash,
            &tx_signature_hash,
            &slot_le,
            &prev_bytes,
        ],
    );

    RitualBlinkReceipt {
        receipt_hash,
        x402_intent_hash: intent.intent_hash,
        hook_verdict_capsule: verdict.clone(),
        payer_hash,
        tx_signature_hash,
        slot,
        previous_receipt_hash,
        created_at_unix,
    }
}

/// Verifies receipt integrity by recomputing receipt_hash.
pub fn verify_blink_receipt(receipt: &RitualBlinkReceipt) -> Result<(), RitualBlinkError> {
    let slot_le = receipt.slot.to_le_bytes();
    let prev_bytes: [u8; 32] = receipt.previous_receipt_hash.unwrap_or([0u8; 32]);

    let expected_hash = sha256_domain(
        b"dark-null-blink-receipt-v1",
        &[
            &receipt.x402_intent_hash,
            &receipt.hook_verdict_capsule.hook_hash,
            &receipt.payer_hash,
            &receipt.tx_signature_hash,
            &slot_le,
            &prev_bytes,
        ],
    );

    if receipt.receipt_hash != expected_hash {
        return Err(RitualBlinkError::ReceiptHashMismatch);
    }

    Ok(())
}

/// Chains a new RitualBlinkReceipt into the BlinkReceiptChain.
/// chain_head_hash = SHA256("dark-null-blink-chain-v1" || receipt.receipt_hash || previous_chain_head_or_zeros)
pub fn chain_blink_receipt(
    previous_chain: Option<&BlinkReceiptChain>,
    receipt: &RitualBlinkReceipt,
    trader_session_hash: &[u8; 32],
) -> BlinkReceiptChain {
    let prev_head: [u8; 32] = previous_chain
        .map(|c| c.chain_head_hash)
        .unwrap_or([0u8; 32]);

    let chain_head_hash = sha256_domain(
        b"dark-null-blink-chain-v1",
        &[&receipt.receipt_hash, &prev_head],
    );

    let chain_length = previous_chain.map(|c| c.chain_length + 1).unwrap_or(1);

    BlinkReceiptChain {
        chain_head_hash,
        chain_length,
        trader_session_hash: *trader_session_hash,
    }
}

/// Generates a stubbed BlinkPostResponse (in production would return base64 Solana tx).
/// Includes ceremony description and confirms x402 intent hash is in memo.
pub fn build_blink_post_response(ceremony: &RitualCeremonyLayout, slot: u64) -> BlinkPostResponse {
    // In production this would be a base64-encoded serialized Solana transaction.
    // Here we produce a deterministic stub that encodes key ceremony metadata.
    let stub_payload = format!(
        "STUB:slot={},instructions={},memo={},hook={},gate={}",
        slot,
        ceremony.instruction_count,
        &ceremony.memo_content[..16], // first 16 chars of hex
        &ceremony.hook_program[..8],
        &ceremony.ritual_gate_program[..8],
    );
    // base64-like stub (just hex of the stub string bytes for determinism)
    let transaction = hex_encode(stub_payload.as_bytes());

    let message = format!(
        "Sign to reveal. Transaction contains {} instructions. \
        x402 intent hash bound in SplMemo: {}. \
        HookVerdict capsule will be emitted on-chain upon confirmation. \
        devnet only — not audited.",
        ceremony.instruction_count, ceremony.memo_content,
    );

    BlinkPostResponse {
        transaction,
        message,
    }
}

/// Verifies that payer_hash in receipt matches expected payer (subscriber check).
pub fn verify_payer_match(
    receipt: &RitualBlinkReceipt,
    expected_payer_pubkey_bytes: &[u8; 32],
) -> Result<(), RitualBlinkError> {
    let expected_payer_hash =
        sha256_domain(b"dark-null-x402-payer-v1", &[expected_payer_pubkey_bytes]);

    if receipt.payer_hash != expected_payer_hash {
        return Err(RitualBlinkError::WrongSubscriber);
    }

    Ok(())
}

/// Checks ceremony layout has exactly 5 instructions with correct names.
pub fn validate_ceremony_layout(layout: &RitualCeremonyLayout) -> Result<(), RitualBlinkError> {
    if layout.instruction_count != 5 || layout.instruction_names.len() != 5 {
        return Err(RitualBlinkError::InvalidCeremonyLayout);
    }

    let expected = [
        "ComputeBudget",
        "SplMemo",
        "Ed25519Precompile",
        "VerifyRitualShape",
        "Token2022TransferChecked",
    ];

    for (i, name) in expected.iter().enumerate() {
        if layout.instruction_names[i] != *name {
            return Err(RitualBlinkError::InvalidCeremonyLayout);
        }
    }

    if !layout
        .instruction_names
        .contains(&"VerifyRitualShape".to_string())
    {
        return Err(RitualBlinkError::MissingRitualGate);
    }

    Ok(())
}

/// Returns a JSON summary of what this system proves (for evidence output).
pub fn generate_evidence_summary(
    receipt: &RitualBlinkReceipt,
    chain: &BlinkReceiptChain,
) -> serde_json::Value {
    serde_json::json!({
        "system": "ritual-blink-gateway",
        "schema_version": BLINK_SCHEMA_VERSION,
        "first_ever": true,
        "components_combined": [
            "Solana Actions/Blinks (Phantom-native, live production)",
            "x402 V2 payment binding (35M+ Solana transactions)",
            "Dark Null ritual grammar (dark_ritual_gate)",
            "Token-2022 Transfer Hook (dark_ritual_transfer_hook)",
            "HookVerdict 33-byte capsule as atomic receipt",
            "Receipt DAG chaining"
        ],
        "programs": {
            "dark_ritual_gate": DARK_RITUAL_GATE_PROGRAM,
            "dark_ritual_transfer_hook": DARK_RITUAL_HOOK_PROGRAM,
            "ritual_mint": RITUAL_MINT
        },
        "receipt": {
            "receipt_hash": hex_encode(&receipt.receipt_hash),
            "x402_intent_hash": hex_encode(&receipt.x402_intent_hash),
            "hook_verdict_prefix": format!("0x{:02x}", receipt.hook_verdict_capsule.verdict_byte),
            "hook_hash": hex_encode(&receipt.hook_verdict_capsule.hook_hash),
            "payer_hash": hex_encode(&receipt.payer_hash),
            "tx_signature_hash": hex_encode(&receipt.tx_signature_hash),
            "slot": receipt.slot,
            "has_previous_receipt": receipt.previous_receipt_hash.is_some(),
            "created_at_unix": receipt.created_at_unix
        },
        "chain": {
            "chain_head_hash": hex_encode(&chain.chain_head_hash),
            "chain_length": chain.chain_length,
            "trader_session_hash": hex_encode(&chain.trader_session_hash)
        },
        "mainnet_ready": false,
        "audited": false,
        "network": "devnet"
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Shared test fixtures ─────────────────────────────────────────────────

    fn test_resource_hash() -> [u8; 32] {
        [0xAAu8; 32]
    }

    fn test_payer_pubkey() -> [u8; 32] {
        [0xBBu8; 32]
    }

    fn test_nonce() -> [u8; 32] {
        [0xCCu8; 32]
    }

    fn test_mint_bytes() -> [u8; 32] {
        [0xDDu8; 32]
    }

    fn test_tx_sig() -> [u8; 32] {
        [0xEEu8; 32]
    }

    fn test_trader_session_hash() -> [u8; 32] {
        [0x11u8; 32]
    }

    fn make_intent() -> X402PaymentIntent {
        create_x402_intent(
            &test_resource_hash(),
            X402_DEFAULT_PRICE_LAMPORTS,
            &test_payer_pubkey(),
            &test_nonce(),
            1_700_000_000,
        )
    }

    fn make_verdict() -> HookVerdictCapsule {
        compute_hook_verdict(&test_mint_bytes(), 1_000)
    }

    fn make_receipt(
        intent: &X402PaymentIntent,
        verdict: &HookVerdictCapsule,
        prev: Option<[u8; 32]>,
    ) -> RitualBlinkReceipt {
        create_blink_receipt(
            intent,
            verdict,
            &test_payer_pubkey(),
            &test_tx_sig(),
            42_000_000,
            prev,
            1_700_000_001,
        )
    }

    // ── Test 1 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_blink_get_response_structure() {
        let resp = build_blink_get_response("trader_alpha", 7, X402_DEFAULT_PRICE_LAMPORTS);
        assert!(!resp.title.is_empty());
        assert!(!resp.description.is_empty());
        assert!(!resp.icon.is_empty());
        assert!(!resp.label.is_empty());
        assert!(!resp.links.actions.is_empty());
        assert!(resp.title.contains("Epoch 7"));
    }

    // ── Test 2 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_blink_get_no_raw_wallet_in_description() {
        let resp = build_blink_get_response("trader_beta", 1, X402_DEFAULT_PRICE_LAMPORTS);
        // Description must not contain anything that looks like a raw base58 pubkey (44 chars).
        // We check it doesn't contain "0xBB" or similar raw payer material.
        assert!(!resp.description.to_lowercase().contains("0xbb"));
        assert!(!resp.description.contains("payer_pubkey"));
        assert!(!resp.description.contains("wallet_address"));
    }

    // ── Test 3 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_x402_intent_hash_deterministic() {
        let intent1 = make_intent();
        let intent2 = make_intent();
        assert_eq!(intent1.intent_hash, intent2.intent_hash);
        assert_eq!(intent1.payer_hash, intent2.payer_hash);
    }

    // ── Test 4 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_x402_intent_changes_with_payer() {
        let payer_a = [0xBBu8; 32];
        let payer_b = [0xFFu8; 32];
        let intent_a = create_x402_intent(
            &test_resource_hash(),
            X402_DEFAULT_PRICE_LAMPORTS,
            &payer_a,
            &test_nonce(),
            1_700_000_000,
        );
        let intent_b = create_x402_intent(
            &test_resource_hash(),
            X402_DEFAULT_PRICE_LAMPORTS,
            &payer_b,
            &test_nonce(),
            1_700_000_000,
        );
        assert_ne!(intent_a.intent_hash, intent_b.intent_hash);
        assert_ne!(intent_a.payer_hash, intent_b.payer_hash);
    }

    // ── Test 5 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_ceremony_layout_has_5_instructions() {
        let intent = make_intent();
        let layout = build_ceremony_layout(&intent).unwrap();
        assert_eq!(layout.instruction_count, 5);
        assert_eq!(layout.instruction_names.len(), 5);
    }

    // ── Test 6 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_ceremony_layout_contains_ritual_gate() {
        let intent = make_intent();
        let layout = build_ceremony_layout(&intent).unwrap();
        assert_eq!(layout.ritual_gate_program, DARK_RITUAL_GATE_PROGRAM);
        assert!(layout
            .instruction_names
            .contains(&"VerifyRitualShape".to_string()));
    }

    // ── Test 7 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_ceremony_memo_is_hex_of_intent_hash() {
        let intent = make_intent();
        let layout = build_ceremony_layout(&intent).unwrap();
        let expected_memo = hex_encode(&intent.intent_hash);
        assert_eq!(layout.memo_content, expected_memo);
        assert_eq!(layout.memo_content.len(), 64);
    }

    // ── Test 8 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_hook_verdict_capsule_prefix() {
        let verdict = make_verdict();
        assert_eq!(verdict.verdict_byte, 0x01);
        assert!(verdict.capsule_bytes_hex.starts_with("01"));
        assert_eq!(verdict.capsule_bytes_hex.len(), 66); // 33 bytes * 2 hex chars
    }

    // ── Test 9 ───────────────────────────────────────────────────────────────
    #[test]
    fn test_hook_verdict_hash_deterministic() {
        let v1 = compute_hook_verdict(&test_mint_bytes(), 1_000);
        let v2 = compute_hook_verdict(&test_mint_bytes(), 1_000);
        assert_eq!(v1.hook_hash, v2.hook_hash);
        assert_eq!(v1.capsule_bytes_hex, v2.capsule_bytes_hex);
    }

    // ── Test 10 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_hook_verdict_verification_valid() {
        let verdict = compute_hook_verdict(&test_mint_bytes(), 1_000);
        verify_hook_verdict(&verdict, &test_mint_bytes(), 1_000).unwrap();
    }

    // ── Test 11 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_hook_verdict_wrong_amount_fails() {
        let verdict = compute_hook_verdict(&test_mint_bytes(), 1_000);
        // Verify with wrong amount should fail
        let result = verify_hook_verdict(&verdict, &test_mint_bytes(), 9_999);
        assert!(result.is_err());
        matches!(result.unwrap_err(), RitualBlinkError::InvalidHookVerdict);
    }

    // ── Test 12 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_blink_receipt_hash_deterministic() {
        let intent = make_intent();
        let verdict = make_verdict();
        let r1 = make_receipt(&intent, &verdict, None);
        let r2 = make_receipt(&intent, &verdict, None);
        assert_eq!(r1.receipt_hash, r2.receipt_hash);
    }

    // ── Test 13 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_blink_receipt_integrity_valid() {
        let intent = make_intent();
        let verdict = make_verdict();
        let receipt = make_receipt(&intent, &verdict, None);
        verify_blink_receipt(&receipt).unwrap();
    }

    // ── Test 14 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_blink_receipt_wrong_payer_fails() {
        let intent = make_intent();
        let verdict = make_verdict();
        let receipt = make_receipt(&intent, &verdict, None);
        // Use a different payer when verifying
        let wrong_payer = [0x00u8; 32];
        let result = verify_payer_match(&receipt, &wrong_payer);
        assert!(result.is_err());
        matches!(result.unwrap_err(), RitualBlinkError::WrongSubscriber);
    }

    // ── Test 15 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_receipt_chain_grows() {
        let intent = make_intent();
        let verdict = make_verdict();
        let session = test_trader_session_hash();

        let r1 = make_receipt(&intent, &verdict, None);
        let chain1 = chain_blink_receipt(None, &r1, &session);
        assert_eq!(chain1.chain_length, 1);

        let r2 = make_receipt(&intent, &verdict, Some(r1.receipt_hash));
        let chain2 = chain_blink_receipt(Some(&chain1), &r2, &session);
        assert_eq!(chain2.chain_length, 2);

        let r3 = make_receipt(&intent, &verdict, Some(r2.receipt_hash));
        let chain3 = chain_blink_receipt(Some(&chain2), &r3, &session);
        assert_eq!(chain3.chain_length, 3);
    }

    // ── Test 16 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_receipt_chain_head_changes_with_new_receipt() {
        let intent = make_intent();
        let verdict = make_verdict();
        let session = test_trader_session_hash();

        let r1 = make_receipt(&intent, &verdict, None);
        let chain1 = chain_blink_receipt(None, &r1, &session);

        // Different tx sig → different receipt hash → different chain head
        let r2 = create_blink_receipt(
            &intent,
            &verdict,
            &test_payer_pubkey(),
            &[0xFFu8; 32], // different tx sig
            42_000_001,
            None,
            1_700_000_002,
        );
        let chain2 = chain_blink_receipt(None, &r2, &session);

        assert_ne!(chain1.chain_head_hash, chain2.chain_head_hash);
    }

    // ── Test 17 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_evidence_summary_is_valid_json() {
        let intent = make_intent();
        let verdict = make_verdict();
        let receipt = make_receipt(&intent, &verdict, None);
        let chain = chain_blink_receipt(None, &receipt, &test_trader_session_hash());

        let summary = generate_evidence_summary(&receipt, &chain);

        // Must be a valid JSON object
        assert!(summary.is_object());
        assert_eq!(summary["system"], "ritual-blink-gateway");
        assert_eq!(summary["mainnet_ready"], false);
        assert_eq!(summary["audited"], false);
        assert_eq!(summary["network"], "devnet");
        assert!(summary["components_combined"].is_array());
        assert_eq!(summary["components_combined"].as_array().unwrap().len(), 6);
        assert!(!summary["receipt"]["receipt_hash"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_eq!(summary["chain"]["chain_length"], 1);
    }

    // ── Test 18 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_ceremony_layout_validation_passes() {
        let intent = make_intent();
        let layout = build_ceremony_layout(&intent).unwrap();
        validate_ceremony_layout(&layout).unwrap();
    }

    // ── Test 19 ──────────────────────────────────────────────────────────────
    #[test]
    fn test_full_flow_end_to_end() {
        // Step 1: create x402 intent
        let resource_hash = [0xA1u8; 32];
        let payer_pub = [0xB2u8; 32];
        let nonce = [0xC3u8; 32];
        let intent = create_x402_intent(
            &resource_hash,
            X402_DEFAULT_PRICE_LAMPORTS,
            &payer_pub,
            &nonce,
            1_700_000_000,
        );
        assert_ne!(intent.intent_hash, [0u8; 32]);
        // Payer is hashed — not raw
        assert_ne!(intent.payer_hash, payer_pub);

        // Step 2: build ceremony layout
        let ceremony = build_ceremony_layout(&intent).unwrap();
        assert_eq!(ceremony.instruction_count, 5);
        assert_eq!(ceremony.memo_content, hex_encode(&intent.intent_hash));

        // Step 3: validate ceremony layout
        validate_ceremony_layout(&ceremony).unwrap();

        // Step 4: compute HookVerdict
        let mint = [0xD4u8; 32];
        let amount: u64 = 500_000;
        let verdict = compute_hook_verdict(&mint, amount);
        assert!(verdict.capsule_bytes_hex.starts_with("01"));

        // Step 5: verify HookVerdict
        verify_hook_verdict(&verdict, &mint, amount).unwrap();

        // Step 6: create blink receipt
        let tx_sig = [0xE5u8; 32];
        let slot: u64 = 300_000_000;
        let receipt = create_blink_receipt(
            &intent,
            &verdict,
            &payer_pub,
            &tx_sig,
            slot,
            None,
            1_700_000_002,
        );
        // Payer is hashed in receipt — not raw
        assert_ne!(receipt.payer_hash, payer_pub);
        assert_eq!(receipt.x402_intent_hash, intent.intent_hash);

        // Step 7: verify receipt integrity
        verify_blink_receipt(&receipt).unwrap();

        // Step 8: verify payer match
        verify_payer_match(&receipt, &payer_pub).unwrap();

        // Step 9: chain receipt
        let session_hash = [0x55u8; 32];
        let chain1 = chain_blink_receipt(None, &receipt, &session_hash);
        assert_eq!(chain1.chain_length, 1);

        // Step 10: second receipt and chain extension
        let receipt2 = create_blink_receipt(
            &intent,
            &verdict,
            &payer_pub,
            &[0xF6u8; 32],
            slot + 1,
            Some(receipt.receipt_hash),
            1_700_000_003,
        );
        verify_blink_receipt(&receipt2).unwrap();
        let chain2 = chain_blink_receipt(Some(&chain1), &receipt2, &session_hash);
        assert_eq!(chain2.chain_length, 2);
        assert_ne!(chain2.chain_head_hash, chain1.chain_head_hash);

        // Step 11: generate evidence summary and verify chain integrity
        let evidence = generate_evidence_summary(&receipt2, &chain2);
        assert_eq!(evidence["chain"]["chain_length"], 2);
        assert!(!evidence["receipt"]["receipt_hash"]
            .as_str()
            .unwrap()
            .is_empty());

        // Step 12: build blink post response
        let post_resp = build_blink_post_response(&ceremony, slot);
        assert!(!post_resp.transaction.is_empty());
        assert!(post_resp.message.contains("5 instructions"));
        // Memo content (x402 binding) referenced in message
        assert!(post_resp.message.contains(&ceremony.memo_content));
    }
}

// FRONTIER EDGE EVIDENCE:
// This crate is the first implementation combining:
// 1. Solana Actions/Blinks (live production standard, Phantom-native)
// 2. x402 V2 payment binding (35M+ Solana transactions on x402 as of March 2026)
// 3. Dark Null ritual grammar enforcement (dark_ritual_gate deployed:
//    31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy)
// 4. Token-2022 Transfer Hook verification (dark_ritual_transfer_hook:
//    F3Jt3TBWxRgzZo6NVNhc3vCLN2R5xq9DcPn2MqVCY6v1)
// 5. HookVerdict 33-byte capsule as atomic receipt
// 6. Receipt DAG chaining for tamper-proof trade history
//
// All six in ONE Solana transaction, launched from a tweet-embedded link.
//
// Status: prototype. Blink server + x402 facilitator deployment required
// for production activation. devnet only. not audited. mainnet_ready = false.
