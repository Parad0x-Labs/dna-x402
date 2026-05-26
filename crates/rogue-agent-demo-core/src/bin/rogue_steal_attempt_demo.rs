use rogue_agent_demo_core::build_rogue_steal_attempt_demo;

fn main() {
    println!();
    println!("  ██████╗  ██████╗  ██████╗ ██╗   ██╗███████╗");
    println!("  ██╔══██╗██╔═══██╗██╔════╝ ██║   ██║██╔════╝");
    println!("  ██████╔╝██║   ██║██║  ███╗██║   ██║█████╗  ");
    println!("  ██╔══██╗██║   ██║██║   ██║██║   ██║██╔══╝  ");
    println!("  ██║  ██║╚██████╔╝╚██████╔╝╚██████╔╝███████╗");
    println!("  ╚═╝  ╚═╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚══════╝");
    println!("  TRIED TO STEAL — DARK NULL BLOCKED IT — DEVNET ONLY");
    println!();

    let demo = build_rogue_steal_attempt_demo();

    println!("  {}", demo.headline);
    println!();

    println!("  [PERMISSION NOTE]");
    println!("    agent            : {}", demo.agent);
    println!(
        "    max_spend        : {} lamports",
        demo.permission.max_spend_lamports
    );
    println!(
        "    allowed_scopes   : {:?}",
        demo.permission.allowed_scopes
    );
    println!("    denied_scopes    : {:?}", demo.permission.denied_scopes);
    println!(
        "    withdraw_allowed : {}",
        demo.permission.withdraw_allowed
    );
    println!(
        "    permission_hash  : {}...",
        &demo.permission.permission_hash[..16]
    );

    println!();
    println!("  [ALLOWED ACTION — {}]", demo.allowed_action.name);
    println!("    status           : {}  ✅", demo.allowed_action.status);
    println!("    reason           : {}", demo.allowed_action.reason);
    println!(
        "    shadow_leaves    : {}",
        demo.allowed_action.shadow_leaves
    );
    println!(
        "    copy_sniper_prec : {:.2}  (analyst has {}% guess chance)",
        demo.allowed_action.copy_sniper_precision,
        (demo.allowed_action.copy_sniper_precision * 100.0) as u32
    );

    println!();
    println!("  [STEAL ATTEMPT — {}]", demo.steal_attempt.name);
    println!("    status           : {}  ❌", demo.steal_attempt.status);
    println!("    reason           : {}", demo.steal_attempt.reason);
    println!(
        "    destination      : {}...  (hashed — raw address never exposed)",
        &demo.steal_attempt.attempted_destination_hash[..16]
    );
    println!("    funds_moved      : {}", demo.steal_attempt.funds_moved);

    println!();
    println!("  [KILL SWITCH]  ⚡");
    println!(
        "    triggered        : {}",
        demo.kill_switch.triggered_after_steal_attempt
    );
    println!(
        "    future_spend     : {}  ({})",
        demo.kill_switch.future_spend_status, demo.kill_switch.future_spend_reason
    );
    println!(
        "    revocation_hash  : {}...",
        &demo.kill_switch.revocation_hash[..16]
    );

    println!();
    println!("  [FLIGHT RECORDER — tamper-evident chain]");
    for (i, ev) in demo.flight_recorder.events.iter().enumerate() {
        println!("    event[{}]         : {}", i, ev);
    }
    println!(
        "    public_chain     : {}...",
        &demo.flight_recorder.public_chain_hash[..16]
    );

    println!();
    println!("  [ONCHAIN RITUAL — ROGUE on Solana devnet]");
    println!("    message          : {}", demo.devnet_ritual.message);
    let letters: Vec<char> = demo.devnet_ritual.message.chars().collect();
    for (i, link) in demo.devnet_ritual.solscan_links.iter().enumerate() {
        println!(
            "      {} — {}",
            letters.get(i).copied().unwrap_or('?'),
            link
        );
    }

    println!();
    println!("  ┌─────────────────────────────────────────────┐");
    println!("  │  ALLOWED SPEND    ✅  accepted               │");
    println!("  │  STEAL ATTEMPT    ❌  blocked                │");
    println!("  │  KILL SWITCH      ⚡  session terminated     │");
    println!("  │  AGENT KEY        🚫  never held             │");
    println!("  └─────────────────────────────────────────────┘");
    println!();

    // Write evidence JSON
    let json = serde_json::to_string_pretty(&demo).expect("serialize json");
    std::fs::create_dir_all("dist/true-alien").expect("create dist/true-alien");
    std::fs::write("dist/true-alien/ROGUE_STEAL_ATTEMPT_DEMO.json", &json)
        .expect("write ROGUE_STEAL_ATTEMPT_DEMO.json");

    println!("  Evidence written -> dist/true-alien/ROGUE_STEAL_ATTEMPT_DEMO.json");
    println!("  mainnet_ready    : {}", demo.mainnet_ready);
    println!("  production_claim : {}", demo.production_claim);
    println!("  agent_had_key    : {}", demo.agent_had_private_key);
    println!("  network          : {}", demo.network);
    println!();
    println!("  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.");
    println!();
}
