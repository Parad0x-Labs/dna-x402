use rogue_agent_demo_core::build_wow_demo;

fn main() {
    println!();
    println!("  ██████╗  ██████╗  ██████╗ ██╗   ██╗███████╗");
    println!("  ██╔══██╗██╔═══██╗██╔════╝ ██║   ██║██╔════╝");
    println!("  ██████╔╝██║   ██║██║  ███╗██║   ██║█████╗  ");
    println!("  ██╔══██╗██║   ██║██║   ██║██║   ██║██╔══╝  ");
    println!("  ██║  ██║╚██████╔╝╚██████╔╝╚██████╔╝███████╗");
    println!("  ╚═╝  ╚═╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚══════╝");
    println!("  ALPHA  —  DARK NULL WOW DEMO  —  DEVNET ONLY");
    println!();

    let demo = build_wow_demo();

    println!("  [PERMISSION]");
    println!("    agent            : {}", demo.agent);
    println!(
        "    max_spend        : {} lamports",
        demo.permission.max_spend_lamports
    );
    println!(
        "    withdraw_allowed : {}",
        demo.permission.withdraw_allowed
    );
    println!("    expires_at_slot  : {}", demo.permission.expires_at_slot);
    println!(
        "    permission_hash  : {}...",
        &demo.permission.permission_hash[..16]
    );

    println!();
    println!("  [ALLOWED SPEND — API access]");
    println!("    status           : {}", demo.allowed_spend.status);
    println!(
        "    spend_hash       : {}...",
        &demo.allowed_spend.spend_hash[..16]
    );
    println!(
        "    shadow_bundle    : {}...",
        &demo.allowed_spend.shadow_bundle_hash[..16]
    );
    println!(
        "    copy_sniper_prec : {:.1}  (5 leaves, 20% chance of correct guess)",
        demo.allowed_spend.copy_sniper_precision
    );

    println!();
    println!("  [FORBIDDEN WITHDRAW — REJECTED]");
    println!("    status           : {}", demo.forbidden_withdraw.status);
    println!("    reason           : {}", demo.forbidden_withdraw.reason);

    println!();
    println!("  [KILL SWITCH]");
    println!("    status           : {}", demo.kill_switch.status);
    println!(
        "    revocation_hash  : {}...",
        &demo.kill_switch.revocation_hash[..16]
    );

    println!();
    println!("  [RECEIPT SOUL — BurnAfterRead]");
    println!("    policy           : {}", demo.receipt_soul.policy);
    println!(
        "    nullifier        : {}...",
        &demo.receipt_soul.nullifier[..16]
    );

    println!();
    println!("  [SESSION CHANNEL]");
    println!(
        "    payments_collapsed : {}",
        demo.session.payments_collapsed
    );
    println!(
        "    settlement_root    : {}...",
        &demo.session.settlement_root[..16]
    );

    println!();
    println!("  [FLIGHT RECORDER]");
    println!(
        "    record_hash      : {}...",
        &demo.flight_recorder.record_hash[..16]
    );
    println!(
        "    redacted_view    : {}...",
        &demo.flight_recorder.redacted_public_view_hash[..16]
    );

    println!();
    println!("  [NO-CUSTODY ATTESTATION]");
    println!(
        "    risk_score       : {} (0 = agent holds ZERO keys)",
        demo.no_custody.risk_score
    );
    println!(
        "    attestation_hash : {}...",
        &demo.no_custody.attestation_hash[..16]
    );

    println!();
    println!("  [ONCHAIN RITUAL — ROGUE on Solana devnet]");
    println!("    message          : {}", demo.devnet_ritual.message);
    print!("    shard_path       : [");
    for (i, b) in demo.devnet_ritual.shard_path.iter().enumerate() {
        if i > 0 {
            print!(", ");
        }
        print!("{}", b);
    }
    println!("]  (R=82 O=79 G=71 U=85 E=69)");
    println!("    live devnet txs  :");
    let letters: Vec<char> = demo.devnet_ritual.message.chars().collect();
    for (i, link) in demo.devnet_ritual.solscan_links.iter().enumerate() {
        println!(
            "      {} — {}",
            letters.get(i).copied().unwrap_or('?'),
            link
        );
    }

    // Write evidence JSON
    let json = serde_json::to_string_pretty(&demo).expect("serialize json");
    std::fs::create_dir_all("dist/true-frontier").expect("create dist/true-frontier");
    std::fs::write("dist/true-frontier/ROGUE_WOW_DEMO.json", &json)
        .expect("write ROGUE_WOW_DEMO.json");

    println!();
    println!("  Evidence written -> dist/true-frontier/ROGUE_WOW_DEMO.json");
    println!("  mainnet_ready    : {}", demo.mainnet_ready);
    println!("  production_claim : {}", demo.production_claim);
    println!("  network          : {}", demo.network);
    println!();
    println!("  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.");
    println!();
}
