// ritual_gate_devnet_call — Live devnet call to dark_ritual_gate
//
// NOT_PRODUCTION — devnet only, mainnet_ready=false
//
// Sends two instructions to the deployed dark_ritual_gate program:
//   1. EchoProof    — [0x01][ritual_hash:32]    — echoes back the ritual hash
//   2. VerifyRitualShape — [0x00][0x01][shape_hash:32] — verifies AgentSpendNoCustodyV1 grammar
//
// Program ID: 31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy
// Writes: dist/ritual-vm/RITUAL_GATE_DEVNET.json

use sha2::{Digest, Sha256};
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Signer},
    sysvar,
    transaction::Transaction,
};
use std::str::FromStr;

const PROGRAM_ID: &str = "31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy";
const RPC_URL: &str = "https://api.devnet.solana.com";
// ritual_hash from dist/ritual-vm/RITUAL_VM_DEMO.json
const RITUAL_HASH_HEX: &str = "1c0ffefb9e1faa3846403f0cc7d9209cf46a2656c5417529f62b608c7d65aeb2";

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

fn hex_decode_32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Compute the canonical shape hash for AgentSpendNoCustodyV1 as the program computes it:
/// SHA256("dark_null_v1_ritual_shape" || step0_bytes || step1_bytes || ...)
/// Note: dark_ritual_gate uses step names only (not data hashes) for the canonical check.
fn canonical_shape_hash() -> [u8; 32] {
    let steps: &[&str] = &[
        "ComputeBudget",
        "IntentCapsule",
        "PermissionProof",
        "SpendShadow",
        "ReceiptSoul",
        "NullifierInsert",
        "ChaffMaintenance",
    ];
    let slices: Vec<&[u8]> = steps.iter().map(|s| s.as_bytes()).collect();
    sha256_domain(b"dark_null_v1_ritual_shape", &slices)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!();
    println!("  dark_ritual_gate — DEVNET LIVE CALL");
    println!("  NOT_PRODUCTION — devnet only, mainnet_ready=false");
    println!();

    let program_id = Pubkey::from_str(PROGRAM_ID)?;
    let rpc_url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| RPC_URL.to_string());

    // Use the persistent wallet (has 20+ devnet SOL)
    let keypair_path = std::env::var("KEYPAIR_PATH").unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        format!("{}/.config/solana/id.json", home)
    });
    let keypair_path = std::path::PathBuf::from(&keypair_path);
    let payer = read_keypair_file(&keypair_path)
        .map_err(|e| format!("read keypair from {}: {}", keypair_path.display(), e))?;

    println!("  payer     : {}", payer.pubkey());
    println!("  program   : {}", program_id);
    println!("  rpc       : {}", rpc_url);
    println!();

    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());

    let balance = client.get_balance(&payer.pubkey())?;
    println!(
        "  balance   : {} lamports ({:.4} SOL)",
        balance,
        balance as f64 / 1e9
    );

    // ── TX 1: EchoProof ───────────────────────────────────────────────────────
    println!();
    println!("  [TX 1] EchoProof");
    let ritual_hash = hex_decode_32(RITUAL_HASH_HEX);
    let mut echo_data = vec![0x01u8];
    echo_data.extend_from_slice(&ritual_hash);

    let echo_ix = Instruction {
        program_id,
        accounts: vec![],
        data: echo_data,
    };

    let recent_blockhash = client.get_latest_blockhash()?;
    let tx1 = Transaction::new_signed_with_payer(
        &[echo_ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    let sig1 = client.send_and_confirm_transaction_with_spinner(&tx1)?;
    let sig1_str = sig1.to_string();
    println!("    signature : {}", sig1_str);
    println!(
        "    solscan   : https://solscan.io/tx/{}?cluster=devnet",
        sig1_str
    );

    // ── TX 2: VerifyRitualShape ───────────────────────────────────────────────
    println!();
    println!("  [TX 2] VerifyRitualShape — AgentSpendNoCustodyV1");
    let shape_hash = canonical_shape_hash();
    println!("    shape_hash: {}", hex_encode(&shape_hash));

    let mut verify_data = vec![0x00u8, 0x01u8]; // discriminant + ritual_type_byte=1
    verify_data.extend_from_slice(&shape_hash);

    let instructions_sysvar = sysvar::instructions::id();
    let verify_ix = Instruction {
        program_id,
        accounts: vec![AccountMeta::new_readonly(instructions_sysvar, false)],
        data: verify_data,
    };

    let recent_blockhash = client.get_latest_blockhash()?;
    let tx2 = Transaction::new_signed_with_payer(
        &[verify_ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    let sig2 = client.send_and_confirm_transaction_with_spinner(&tx2)?;
    let sig2_str = sig2.to_string();
    println!("    signature : {}", sig2_str);
    println!(
        "    solscan   : https://solscan.io/tx/{}?cluster=devnet",
        sig2_str
    );

    // ── Write evidence ────────────────────────────────────────────────────────
    let evidence = serde_json::json!({
        "network": "solana-devnet",
        "mainnet_ready": false,
        "production_claim": false,
        "program_id": PROGRAM_ID,
        "program_slot": 464996215u64,
        "ritual_hash": RITUAL_HASH_HEX,
        "shape_hash": hex_encode(&shape_hash),
        "tx_echo_proof": {
            "instruction": "EchoProof",
            "data_prefix": "0x01",
            "signature": sig1_str,
            "solscan": format!("https://solscan.io/tx/{}?cluster=devnet", sig1_str)
        },
        "tx_verify_ritual": {
            "instruction": "VerifyRitualShape",
            "ritual_type": "AgentSpendNoCustodyV1",
            "ritual_type_byte": 1u8,
            "data_prefix": "0x00 0x01",
            "signature": sig2_str,
            "solscan": format!("https://solscan.io/tx/{}?cluster=devnet", sig2_str)
        }
    });

    std::fs::create_dir_all("dist/ritual-vm")?;
    std::fs::write(
        "dist/ritual-vm/RITUAL_GATE_DEVNET.json",
        serde_json::to_string_pretty(&evidence)?,
    )?;

    println!();
    println!("  Evidence written -> dist/ritual-vm/RITUAL_GATE_DEVNET.json");
    println!("  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.");
    println!();

    Ok(())
}
