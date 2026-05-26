use ritual_vm_demo::build_ritual_vm_demo;

fn main() {
    println!();
    println!("  ██████╗ ██╗████████╗██╗   ██╗ █████╗ ██╗");
    println!("  ██╔══██╗██║╚══██╔══╝██║   ██║██╔══██╗██║");
    println!("  ██████╔╝██║   ██║   ██║   ██║███████║██║");
    println!("  ██╔══██╗██║   ██║   ██║   ██║██╔══██║██║");
    println!("  ██║  ██║██║   ██║   ╚██████╔╝██║  ██║███████╗");
    println!("  ╚═╝  ╚═╝╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝");
    println!("  TRANSACTION RITUAL VM — DARK NULL — DEVNET ONLY");
    println!();

    let demo = build_ritual_vm_demo();

    println!("  [RITUAL GRAMMAR]");
    println!("    type      : {}", demo.ritual.ritual_type);
    println!("    verdict   : {}", demo.ritual.verdict);
    println!("    steps     : {}", demo.ritual.grammar_steps.join(" → "));
    println!("    shape     : {}...", &demo.ritual.shape_hash[..16]);
    println!("    ritual_h  : {}...", &demo.ritual.ritual_hash[..16]);
    println!("    capsule   : {}...", &demo.ritual.capsule_hash[..16]);
    println!("    encoded   : {} bytes", demo.ritual.encoded_bytes);
    println!("    summary   : {}", demo.ritual.public_summary);

    println!();
    println!("  [CPI FIREWALL]");
    println!(
        "    manifest  : {}...",
        &demo.cpi_firewall.manifest_hash[..16]
    );
    println!(
        "    bound     : {}...",
        &demo.cpi_firewall.bound_to_ritual[..16]
    );
    println!("    policy    : {}", demo.cpi_firewall.policy);
    println!("    violations: {}", demo.cpi_firewall.violations);

    println!();
    println!("  [ACCOUNT LOCK ALCHEMY]");
    println!(
        "    overall   : {:.3}  ({})",
        demo.lock_alchemy.overall_score, demo.lock_alchemy.recommendation
    );
    println!(
        "    heat      : {:.2}  fingerprint_uniqueness: {:.2}",
        demo.lock_alchemy.fee_heat_score, demo.lock_alchemy.fingerprint_uniqueness
    );
    println!(
        "    parallelism: {:.2}  shape_pool: {:.2}",
        demo.lock_alchemy.parallelism_score, demo.lock_alchemy.shape_pool_score
    );
    println!("    plan_hash : {}...", &demo.lock_alchemy.plan_hash[..16]);

    println!();
    println!("  [RENT DELTA PROOF]");
    println!("    locked    : {} lamports", demo.rent_delta.rent_locked);
    println!(
        "    reclaimed : {} lamports",
        demo.rent_delta.rent_reclaimed
    );
    println!(
        "    net       : {} lamports  ({})",
        demo.rent_delta.net_rent_cost, demo.rent_delta.net_label
    );
    println!("    chaff_rwd : {} lamports", demo.rent_delta.chaff_reward);

    println!();
    println!("  [SHAPE MARKET — k-ANONYMITY]");
    println!(
        "    k_shape   : {}  ({})",
        demo.shape_market.k_shape, demo.shape_market.risk_level
    );
    println!("    class     : {}...", &demo.shape_market.class_hash[..16]);

    println!();
    println!("  [DEVNET RITUAL — ROGUE]");
    println!("    message   : {}", demo.devnet_ritual.message);
    print!("    shards    : [");
    let letters: Vec<char> = demo.devnet_ritual.message.chars().collect();
    for (i, b) in demo.devnet_ritual.shard_path.iter().enumerate() {
        if i > 0 {
            print!(", ");
        }
        print!("{}", b);
    }
    println!("]  (R=82 O=79 G=71 U=85 E=69)");
    for (i, link) in demo.devnet_ritual.solscan_links.iter().enumerate() {
        println!(
            "      {} — {}",
            letters.get(i).copied().unwrap_or('?'),
            link
        );
    }

    // Write evidence JSON
    let json = serde_json::to_string_pretty(&demo).expect("serialize json");
    std::fs::create_dir_all("dist/ritual-vm").expect("create dist/ritual-vm");
    std::fs::write("dist/ritual-vm/RITUAL_VM_DEMO.json", &json).expect("write RITUAL_VM_DEMO.json");

    println!();
    println!("  Evidence written -> dist/ritual-vm/RITUAL_VM_DEMO.json");
    println!("  mainnet_ready    : {}", demo.mainnet_ready);
    println!("  production_claim : {}", demo.production_claim);
    println!("  network          : {}", demo.network);
    println!();
    println!("  NOT_PRODUCTION. Devnet only. No audit. No mainnet keys.");
    println!();
}
