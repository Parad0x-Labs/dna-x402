// x402_devnet_real — Real Devnet Payment Evidence Generator
//
// NOT_PRODUCTION — devnet only, mainnet_ready=false
//
// What this binary does:
//   1. Generates a fresh payer keypair (ephemeral, printed to stdout)
//   2. Airdrops 1 SOL to payer from devnet faucet
//   3. Transfers 1_000_000 lamports to a generated test recipient
//   4. Verifies the tx via DevnetPaymentVerifier (real RPC fetch + balance delta check)
//   5. Mints a DarkX402Receipt (is_mock=false)
//   6. Writes dist/alien-final/evidence/x402_devnet_real.json
//
// Usage:
//   cargo run -p dark-x402-devnet-verify --bin x402_devnet_real
//
// Optional env vars:
//   SOLANA_RPC_URL=https://api.devnet.solana.com (default)
//
// Requirements:
//   - devnet RPC accessible
//   - devnet faucet not rate-limited
//
// What is NOT production:
//   - no real facilitator
//   - no mainnet
//   - no custody / escrow
//   - no persistent server database or nullifier store
//   - no audit
//   - ephemeral keypairs (regenerated each run)

use dark_x402_core::*;
use dark_x402_devnet_verify::{
    build_evidence_json, build_real_proof, hex_encode, DevnetPaymentVerifier, PaymentVerifier,
};
use solana_client::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_instruction;
use solana_sdk::transaction::Transaction;
use std::time::Duration;

const TRANSFER_LAMPORTS: u64 = 1_000_000;
const AIRDROP_LAMPORTS: u64 = 1_000_000_000; // 1 SOL
const MIN_BALANCE: u64 = 2_000_000; // require at least 2× transfer amount

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== dark-x402-devnet-verify: Real Devnet Payment Evidence ===");
    println!("NOT_PRODUCTION — devnet only, mainnet_ready=false\n");

    let rpc_url = std::env::var("SOLANA_RPC_URL")
        .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
    println!("RPC: {}", rpc_url);

    let client = RpcClient::new_with_commitment(rpc_url.clone(), CommitmentConfig::confirmed());

    // ── Keypairs ─────────────────────────────────────────────────────────────
    let payer = Keypair::new();
    let recipient = Keypair::new();
    let payer_pubkey = payer.pubkey();
    let recipient_pubkey = recipient.pubkey();
    println!("Payer:     {}", payer_pubkey);
    println!("Recipient: {}", recipient_pubkey);

    // ── Airdrop if needed ─────────────────────────────────────────────────────
    let balance = client
        .get_balance(&payer_pubkey)
        .map_err(|e| format!("RPC error fetching balance (is devnet reachable?): {}", e))?;

    println!("Payer balance: {} lamports", balance);

    if balance < MIN_BALANCE {
        println!(
            "Balance too low — requesting airdrop of {} lamports...",
            AIRDROP_LAMPORTS
        );
        let airdrop_sig = client
            .request_airdrop(&payer_pubkey, AIRDROP_LAMPORTS)
            .map_err(|e| format!("Airdrop request failed: {}", e))?;

        println!(
            "Airdrop submitted: {} — waiting for confirmation...",
            airdrop_sig
        );
        let confirmed = wait_for_confirmation(&client, &airdrop_sig, 30)?;
        if !confirmed {
            return Err(
                "Airdrop timed out after 60 seconds — devnet faucet may be slow or rate-limited"
                    .into(),
            );
        }
        println!("Airdrop confirmed.");
    } else {
        println!("Balance sufficient — skipping airdrop.");
    }

    // ── Transfer ─────────────────────────────────────────────────────────────
    println!(
        "\nTransferring {} lamports → {}...",
        TRANSFER_LAMPORTS, recipient_pubkey
    );

    let blockhash = client
        .get_latest_blockhash()
        .map_err(|e| format!("Failed to get blockhash: {}", e))?;

    let transfer_ix =
        system_instruction::transfer(&payer_pubkey, &recipient_pubkey, TRANSFER_LAMPORTS);

    let tx = Transaction::new_signed_with_payer(
        &[transfer_ix],
        Some(&payer_pubkey),
        &[&payer],
        blockhash,
    );

    let signature = client
        .send_and_confirm_transaction(&tx)
        .map_err(|e| format!("Transfer failed: {}", e))?;

    let sig_str = signature.to_string();
    println!("Transfer confirmed: {}", sig_str);

    // ── Verify via DevnetPaymentVerifier ──────────────────────────────────────
    println!("\nVerifying payment via RPC...");
    let verifier = DevnetPaymentVerifier::new(rpc_url.clone());
    let recipient_bytes = recipient_pubkey.to_bytes();

    let verified = verifier
        .verify_transfer(&sig_str, &recipient_bytes, TRANSFER_LAMPORTS)
        .map_err(|e| format!("Payment verification failed: {}", e))?;

    println!(
        "Verified: slot={} amount={} lamports",
        verified.slot, verified.amount_lamports
    );

    // ── Build x402 requirement and proof ─────────────────────────────────────
    let payer_bytes = payer_pubkey.to_bytes();

    let req = X402PaymentRequirement {
        scheme: "exact".to_string(),
        network: "solana-devnet".to_string(),
        asset: "SOL".to_string(),
        amount_lamports: TRANSFER_LAMPORTS,
        pay_to: recipient_bytes,
        resource: "https://api.darknull.example/devnet-evidence-resource".to_string(),
        expires_at_slot: verified.slot + 1000,
        nonce: {
            let mut n = [0u8; 8];
            n.copy_from_slice(&verified.slot.to_le_bytes()[..8]);
            n
        },
        facilitator_url: None,
    };

    let proof = build_real_proof(&req, payer_bytes, &sig_str);

    // ── Mint receipt ──────────────────────────────────────────────────────────
    println!("\nMinting DarkX402Receipt...");
    let receipt =
        mint_receipt_note_after_payment(&req, &proof, b"devnet_evidence_payload", verified.slot)
            .map_err(|e| format!("Receipt mint failed: {:?}", e))?;

    println!("Receipt ID:        {}", hex_encode(&receipt.receipt_id()));
    println!(
        "Receipt nullifier: {}",
        hex_encode(&receipt.receipt_nullifier)
    );
    println!("is_mock:           {}", receipt.is_mock);

    // ── Get git commit ────────────────────────────────────────────────────────
    let commit = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    // ── Build and validate evidence ───────────────────────────────────────────
    let evidence = build_evidence_json(&commit, &verified, &proof, &receipt);

    evidence
        .validate()
        .map_err(|e| format!("Evidence validation failed: {}", e))?;

    // ── Write evidence file ───────────────────────────────────────────────────
    let evidence_dir = "dist/alien-final/evidence";
    std::fs::create_dir_all(evidence_dir)?;
    let evidence_path = format!("{}/x402_devnet_real.json", evidence_dir);
    let json = serde_json::to_string_pretty(&evidence)?;
    std::fs::write(&evidence_path, &json)?;

    // ── Summary ───────────────────────────────────────────────────────────────
    println!("\n=== Evidence Written ===");
    println!("Path:         {}", evidence_path);
    println!("Tx:           {}", evidence.tx_signature);
    println!("Slot:         {}", evidence.verified_at_slot);
    println!("Amount:       {} lamports", evidence.amount_lamports);
    println!("Pay-to:       {}", evidence.pay_to);
    println!("mock:         {}", evidence.mock);
    println!("mainnet_ready:{}", evidence.mainnet_ready);

    println!("\nTo check x402 evidence in the mainnet gate:");
    println!("  node scripts/check-mainnet-alien-final.mjs");
    println!("\nNOT_PRODUCTION: devnet only — no mainnet, no audit, no custody.");

    Ok(())
}

/// Poll for signature confirmation with a timeout.
fn wait_for_confirmation(
    client: &RpcClient,
    sig: &solana_sdk::signature::Signature,
    max_attempts: u32,
) -> Result<bool, Box<dyn std::error::Error>> {
    for attempt in 0..max_attempts {
        std::thread::sleep(Duration::from_secs(2));
        match client.confirm_transaction(sig) {
            Ok(true) => return Ok(true),
            Ok(false) => {
                println!(
                    "  attempt {}/{}: not yet confirmed...",
                    attempt + 1,
                    max_attempts
                );
            }
            Err(e) => {
                println!(
                    "  attempt {}/{}: RPC error: {}",
                    attempt + 1,
                    max_attempts,
                    e
                );
            }
        }
    }
    Ok(false)
}
