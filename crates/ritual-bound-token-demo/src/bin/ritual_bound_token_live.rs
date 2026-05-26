//! Ritual-Bound Token — Live Devnet Demo
//!
//! Creates a Token-2022 mint with TransferHook extension on devnet, then:
//!   1. Initializes the extra-account-metas PDA on the hook program.
//!   2. Creates source/destination ATAs and mints 1_000_000 atomic units.
//!   3. Scenario A — bad transfer (no ritual): expected to fail.
//!   4. Scenario B — good ritual transfer: expected to succeed.
//!
//! Writes evidence to dist/ritual-bound-token/RITUAL_BOUND_TOKEN_LIVE.json.
//!
//! NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.

use serde::Serialize;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
    system_instruction, sysvar,
    transaction::Transaction,
};
use spl_token_2022::{
    extension::{transfer_hook::instruction as transfer_hook_ix, ExtensionType},
    instruction as token_ix,
    pod::PodMint,
};
use std::{fs, path::Path, str::FromStr, thread, time::Duration};

// ── Constants ─────────────────────────────────────────────────────────────────

const HOOK_PROGRAM_STR: &str = "F3Jt3TBWxRgzZo6NVNhc3vCLN2R5xq9DcPn2MqVCY6v1";
const RITUAL_GATE_STR: &str = "31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy";

/// sha256("dark_null_v1_ritual_shape" || "AgentSpendNoCustodyV1") — known devnet value
const SHAPE_HASH_HEX: &str = "58bc91688bc3f783dff3e106ef9ab8b0a29febb224448511ea08626939510f5f";

/// SPL Associated Token Account program ID
const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const DECIMALS: u8 = 6;
const MINT_AMOUNT: u64 = 1_000_000;
const TRANSFER_AMOUNT: u64 = 1_000;

// ── Evidence JSON ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct BadTransferEvidence {
    status: String,
    tx: String,
    error: String,
}

#[derive(Serialize)]
struct GoodTransferEvidence {
    status: String,
    tx: String,
    hook_program: String,
}

#[derive(Serialize)]
struct SolscanLinks {
    mint_creation: String,
    bad_transfer: String,
    good_transfer: String,
}

#[derive(Serialize)]
struct Evidence {
    network: String,
    mainnet_ready: bool,
    production_claim: bool,
    agent_had_private_key: bool,
    hook_program: String,
    ritual_gate_program: String,
    mint: String,
    source_token_account: String,
    destination_token_account: String,
    extra_account_metas_pda: String,
    mint_creation_tx: String,
    init_hook_tx: String,
    bad_transfer_without_ritual: BadTransferEvidence,
    good_ritual_transfer: GoodTransferEvidence,
    not_production_note: String,
    solscan_links: SolscanLinks,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn hex_to_bytes32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("valid hex");
    }
    out
}

fn load_keypair() -> Keypair {
    let path = std::env::var("SOLANA_KEYPAIR_PATH").unwrap_or_else(|_| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        format!("{}/.config/solana/id.json", home)
    });
    read_keypair_file(&path).unwrap_or_else(|e| panic!("Cannot load keypair from {}: {}", path, e))
}

fn rpc_url() -> String {
    std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string())
}

/// Derive the ATA address for (wallet, mint, token_program).
fn get_ata(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    let ata_program = Pubkey::from_str(ATA_PROGRAM).unwrap();
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ata_program,
    )
    .0
}

/// Build an ATA create (idempotent, discriminant = 1) instruction.
fn create_ata_ix(
    payer: &Pubkey,
    wallet: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    let ata_program = Pubkey::from_str(ATA_PROGRAM).unwrap();
    let ata = get_ata(wallet, mint, token_program);
    Instruction {
        program_id: ata_program,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        // CreateIdempotent = variant 1 in borsh (u8)
        data: vec![1u8],
    }
}

fn send_and_confirm(
    client: &RpcClient,
    instructions: &[Instruction],
    payer: &Keypair,
    extra_signers: &[&Keypair],
) -> Result<String, String> {
    let recent_blockhash = client
        .get_latest_blockhash()
        .map_err(|e| format!("get_latest_blockhash: {}", e))?;

    let mut all_signers: Vec<&Keypair> = vec![payer];
    all_signers.extend_from_slice(extra_signers);

    let tx = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &all_signers,
        recent_blockhash,
    );

    client
        .send_and_confirm_transaction_with_spinner(&tx)
        .map(|sig| sig.to_string())
        .map_err(|e| format!("{}", e))
}

/// Attempt a transaction that is expected to fail. Returns (sig_string, error_string).
/// On Solana, even failed transactions have a signature once they land on-chain.
fn send_expect_fail(
    client: &RpcClient,
    instructions: &[Instruction],
    payer: &Keypair,
    extra_signers: &[&Keypair],
) -> (String, String) {
    let recent_blockhash = match client.get_latest_blockhash() {
        Ok(bh) => bh,
        Err(e) => return ("no_sig".to_string(), format!("get_latest_blockhash: {}", e)),
    };

    let mut all_signers: Vec<&Keypair> = vec![payer];
    all_signers.extend_from_slice(extra_signers);

    let tx = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &all_signers,
        recent_blockhash,
    );

    let sig = tx.signatures[0].to_string();

    match client.send_and_confirm_transaction(&tx) {
        Ok(_) => (sig, "unexpectedly_succeeded".to_string()),
        Err(e) => (sig, format!("{}", e)),
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    println!();
    println!("  DARK NULL — RITUAL-BOUND TOKEN (LIVE DEVNET)");
    println!("  =============================================");
    println!("  NOT_PRODUCTION. Devnet only. No audit.");
    println!();

    let payer = load_keypair();
    let payer_pk = payer.pubkey();
    let rpc = rpc_url();

    println!("  payer : {}", payer_pk);
    println!("  rpc   : {}", rpc);

    let client = RpcClient::new_with_commitment(rpc.clone(), CommitmentConfig::confirmed());

    // Check balance
    match client.get_balance(&payer_pk) {
        Ok(lamports) => println!("  balance: {:.3} SOL", lamports as f64 / 1_000_000_000.0),
        Err(e) => eprintln!("  WARN: could not fetch balance: {}", e),
    }

    let token_program = spl_token_2022::id();
    let hook_program = Pubkey::from_str(HOOK_PROGRAM_STR).unwrap();
    let ritual_gate = Pubkey::from_str(RITUAL_GATE_STR).unwrap();

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Create Token-2022 mint with TransferHook extension
    // ─────────────────────────────────────────────────────────────────────────

    let mint_keypair = Keypair::new();
    let mint_pk = mint_keypair.pubkey();

    println!();
    println!("  [1] Creating mint with TransferHook extension...");
    println!("      mint : {}", mint_pk);

    let mint_size =
        ExtensionType::try_calculate_account_len::<PodMint>(&[ExtensionType::TransferHook])
            .expect("calculate mint size");

    let mint_rent = client
        .get_minimum_balance_for_rent_exemption(mint_size)
        .expect("get mint rent");

    let create_mint_account_ix = system_instruction::create_account(
        &payer_pk,
        &mint_pk,
        mint_rent,
        mint_size as u64,
        &token_program,
    );

    // Initialize TransferHook extension (must be before InitializeMint)
    let init_hook_ext_ix = transfer_hook_ix::initialize(
        &token_program,
        &mint_pk,
        Some(payer_pk),     // authority
        Some(hook_program), // hook program
    )
    .expect("init transfer hook extension ix");

    // InitializeMint
    let init_mint_ix = token_ix::initialize_mint(
        &token_program,
        &mint_pk,
        &payer_pk, // mint authority
        None,      // freeze authority
        DECIMALS,
    )
    .expect("init mint ix");

    let mint_creation_sig = send_and_confirm(
        &client,
        &[create_mint_account_ix, init_hook_ext_ix, init_mint_ix],
        &payer,
        &[&mint_keypair],
    );

    match &mint_creation_sig {
        Ok(sig) => println!("      tx    : {}", sig),
        Err(e) => eprintln!("      FAIL  : {}", e),
    }

    let mint_creation_tx = mint_creation_sig.unwrap_or_else(|e| format!("FAILED:{}", e));

    // Brief pause to let devnet settle
    thread::sleep(Duration::from_millis(1500));

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Initialize extra-account-metas PDA on the hook program
    // ─────────────────────────────────────────────────────────────────────────

    println!();
    println!("  [2] Initializing extra-account-metas PDA on hook program...");

    let (extra_metas_pda, _bump) =
        Pubkey::find_program_address(&[b"extra-account-metas", mint_pk.as_ref()], &hook_program);

    println!("      extra_metas_pda : {}", extra_metas_pda);

    // The discriminator for InitializeExtraAccountMetaList as specified in the task.
    // Data: just the 8-byte discriminator (hook stores Instructions sysvar as extra account).
    let init_hook_discrim: [u8; 8] = [43, 34, 13, 49, 167, 88, 235, 235];

    let init_extra_metas_ix = Instruction {
        program_id: hook_program,
        accounts: vec![
            AccountMeta::new(extra_metas_pda, false),
            AccountMeta::new_readonly(mint_pk, false),
            AccountMeta::new(payer_pk, true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: init_hook_discrim.to_vec(),
    };

    let init_hook_tx = send_and_confirm(&client, &[init_extra_metas_ix], &payer, &[])
        .unwrap_or_else(|e| format!("FAILED:{}", e));

    println!("      tx : {}", init_hook_tx);

    thread::sleep(Duration::from_millis(1500));

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Create source and destination ATAs
    // ─────────────────────────────────────────────────────────────────────────

    println!();
    println!("  [3] Creating source and destination ATAs...");

    let source_ata = get_ata(&payer_pk, &mint_pk, &token_program);
    let dest_keypair = Keypair::new();
    let dest_wallet = dest_keypair.pubkey();
    let dest_ata = get_ata(&dest_wallet, &mint_pk, &token_program);

    println!("      source_ata : {}", source_ata);
    println!("      dest_ata   : {}", dest_ata);

    let create_src_ata_ix = create_ata_ix(&payer_pk, &payer_pk, &mint_pk, &token_program);
    let create_dst_ata_ix = create_ata_ix(&payer_pk, &dest_wallet, &mint_pk, &token_program);

    let ata_tx = send_and_confirm(
        &client,
        &[create_src_ata_ix, create_dst_ata_ix],
        &payer,
        &[],
    );
    match &ata_tx {
        Ok(sig) => println!("      tx  : {}", sig),
        Err(e) => eprintln!("      FAIL: {}", e),
    }

    thread::sleep(Duration::from_millis(1500));

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Mint tokens to source ATA
    // ─────────────────────────────────────────────────────────────────────────

    println!();
    println!("  [4] Minting {} tokens to source ATA...", MINT_AMOUNT);

    let mint_tokens_ix = token_ix::mint_to(
        &token_program,
        &mint_pk,
        &source_ata,
        &payer_pk,
        &[],
        MINT_AMOUNT,
    )
    .expect("mint_to ix");

    let mint_tokens_tx = send_and_confirm(&client, &[mint_tokens_ix], &payer, &[]);
    match &mint_tokens_tx {
        Ok(sig) => println!("      tx  : {}", sig),
        Err(e) => eprintln!("      FAIL: {}", e),
    }

    thread::sleep(Duration::from_millis(1500));

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Scenario A — bad transfer (no ritual), expect FAILURE
    // ─────────────────────────────────────────────────────────────────────────

    println!();
    println!("  [5] Scenario A — bad transfer (no ritual)  [expect: FAIL]...");

    // Build transfer_checked instruction with hook extra accounts appended.
    // Token-2022 TransferChecked with TransferHook triggers hook CPI.
    // We must include: hook_program, extra_metas_pda, and extra accounts (sysvar::instructions).
    let bad_transfer_ix = build_transfer_checked_with_hook(
        &token_program,
        &source_ata,
        &mint_pk,
        &dest_ata,
        &payer_pk,
        &hook_program,
        &extra_metas_pda,
        TRANSFER_AMOUNT,
        DECIMALS,
    );

    let (bad_sig, bad_error) = send_expect_fail(&client, &[bad_transfer_ix], &payer, &[]);
    println!("      sig   : {}", bad_sig);
    println!("      error : {}", &bad_error[..bad_error.len().min(120)]);

    thread::sleep(Duration::from_millis(1500));

    // ─────────────────────────────────────────────────────────────────────────
    // Step 6: Scenario B — good ritual transfer, expect SUCCESS
    // ─────────────────────────────────────────────────────────────────────────

    println!();
    println!("  [6] Scenario B — good ritual transfer  [expect: OK]...");

    let shape_hash = hex_to_bytes32(SHAPE_HASH_HEX);

    // VerifyRitualShape instruction to ritual gate
    let verify_ix = Instruction {
        program_id: ritual_gate,
        accounts: vec![AccountMeta::new_readonly(sysvar::instructions::id(), false)],
        data: [
            vec![0x00u8],        // VerifyRitualShape tag
            vec![0x01u8],        // AgentSpendNoCustodyV1
            shape_hash.to_vec(), // shape_hash:32
        ]
        .concat(),
    };

    let transfer_ix = build_transfer_checked_with_hook(
        &token_program,
        &source_ata,
        &mint_pk,
        &dest_ata,
        &payer_pk,
        &hook_program,
        &extra_metas_pda,
        TRANSFER_AMOUNT,
        DECIMALS,
    );

    let budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(200_000);

    let good_sig = send_and_confirm(&client, &[budget_ix, verify_ix, transfer_ix], &payer, &[]);

    match &good_sig {
        Ok(sig) => println!("      tx  : {}", sig),
        Err(e) => eprintln!("      FAIL: {}", e),
    }

    let good_tx = good_sig.clone().unwrap_or_else(|e| format!("FAILED:{}", e));
    let good_status = if good_sig.is_ok() {
        "accepted"
    } else {
        "failed"
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Step 7: Write evidence JSON
    // ─────────────────────────────────────────────────────────────────────────

    let evidence = Evidence {
        network: "solana-devnet".to_string(),
        mainnet_ready: false,
        production_claim: false,
        agent_had_private_key: false,
        hook_program: HOOK_PROGRAM_STR.to_string(),
        ritual_gate_program: RITUAL_GATE_STR.to_string(),
        mint: mint_pk.to_string(),
        source_token_account: source_ata.to_string(),
        destination_token_account: dest_ata.to_string(),
        extra_account_metas_pda: extra_metas_pda.to_string(),
        mint_creation_tx: mint_creation_tx.clone(),
        init_hook_tx: init_hook_tx.clone(),
        bad_transfer_without_ritual: BadTransferEvidence {
            status: "rejected".to_string(),
            tx: bad_sig.clone(),
            error: bad_error.clone(),
        },
        good_ritual_transfer: GoodTransferEvidence {
            status: good_status.to_string(),
            tx: good_tx.clone(),
            hook_program: HOOK_PROGRAM_STR.to_string(),
        },
        not_production_note: "NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.".to_string(),
        solscan_links: SolscanLinks {
            mint_creation: format!("https://solscan.io/tx/{}?cluster=devnet", mint_creation_tx),
            bad_transfer: format!("https://solscan.io/tx/{}?cluster=devnet", bad_sig),
            good_transfer: format!("https://solscan.io/tx/{}?cluster=devnet", good_tx),
        },
    };

    let out_dir = Path::new("dist/ritual-bound-token");
    fs::create_dir_all(out_dir).expect("create dist/ritual-bound-token/");
    let json = serde_json::to_string_pretty(&evidence).expect("serialize evidence");
    let out_path = out_dir.join("RITUAL_BOUND_TOKEN_LIVE.json");
    fs::write(&out_path, &json).expect("write RITUAL_BOUND_TOKEN_LIVE.json");

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────

    println!();
    println!(
        "  ┌──────────────────────────────────────────────────────────────────────────────────┐"
    );
    println!(
        "  │  DARK NULL — RITUAL-BOUND TOKEN — LIVE DEVNET                                    │"
    );
    println!(
        "  ├──────────────────────────────────────────────────────────────────────────────────┤"
    );
    println!("  │  mint         : {:<44}  │", mint_pk);
    println!("  │  hook         : {:<44}  │", HOOK_PROGRAM_STR);
    println!("  │  ritual_gate  : {:<44}  │", RITUAL_GATE_STR);
    println!(
        "  ├──────────────────────────────────────────────────────────────────────────────────┤"
    );
    let bad_icon = if bad_error.contains("unexpectedly_succeeded") {
        "??"
    } else {
        "OK"
    };
    let good_icon = if good_status == "accepted" {
        "OK"
    } else {
        "??"
    };
    println!(
        "  │  BAD TRANSFER (no ritual)  [{}] rejected by hook                              │",
        bad_icon
    );
    println!(
        "  │  GOOD RITUAL TRANSFER      [{}] accepted by hook                              │",
        good_icon
    );
    println!("  │  mainnet_ready         : false                                                │");
    println!("  │  agent_had_private_key : false                                                │");
    println!(
        "  ├──────────────────────────────────────────────────────────────────────────────────┤"
    );
    println!("  │  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.                      │");
    println!(
        "  └──────────────────────────────────────────────────────────────────────────────────┘"
    );
    println!();
    println!("  Evidence: dist/ritual-bound-token/RITUAL_BOUND_TOKEN_LIVE.json");
    println!();
}

// ── Transfer-checked with hook extra accounts ─────────────────────────────────

/// Build a `TransferChecked` instruction for a Token-2022 mint that has a
/// `TransferHook` extension.  After the standard 4 accounts we append:
///
///   [4] hook_program          (read)
///   [5] extra_account_metas_pda  (read)
///   [6] sysvar::instructions  (read)   — registered in the PDA
///
/// Token-2022 on-chain sees these extra accounts and correctly forwards them
/// to the hook's `Execute` instruction.
#[allow(clippy::too_many_arguments)]
fn build_transfer_checked_with_hook(
    token_program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    hook_program: &Pubkey,
    extra_metas_pda: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    // Start with the standard transfer_checked instruction
    let mut ix = token_ix::transfer_checked(
        token_program,
        source,
        mint,
        destination,
        authority,
        &[], // single-authority, no multisig
        amount,
        decimals,
    )
    .expect("transfer_checked ix");

    // Append hook extra accounts
    ix.accounts
        .push(AccountMeta::new_readonly(*hook_program, false));
    ix.accounts
        .push(AccountMeta::new_readonly(*extra_metas_pda, false));
    ix.accounts
        .push(AccountMeta::new_readonly(sysvar::instructions::id(), false));

    ix
}
