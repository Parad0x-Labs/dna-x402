use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use account_lock_alchemy::{
    compute_plan_hash, score_lock_plan, AccountLockPlan, ShapePrivacyScore, WritableHeat,
};
use cpi_firewall::{
    bind_manifest_to_ritual, manifest_hash, validate_cpi_manifest, AllowedCpi, CpiManifest,
    CpiPolicy,
};
use rent_delta_proof::{compute_rent_delta, summarize_rent_delta, RentAction};
use ritual_compiler::{compile_ritual, program_hash, RitualInput};
use ritual_proof_capsule::{capsule_hash, encode_capsule, redacted_display};
use ritual_shape_market::{compute_class_hash, ShapeMarket, ShapeObservation, ShapeRiskLevel};

// ── Private helper ────────────────────────────────────────────────────────────

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Output JSON types ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualSection {
    pub ritual_type: String,
    pub grammar_steps: Vec<String>,
    pub shape_hash: String,
    pub ritual_hash: String,
    pub verdict: String,
    pub capsule_hash: String,
    pub encoded_bytes: usize,
    pub public_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpiFirewallSection {
    pub manifest_hash: String,
    pub bound_to_ritual: String,
    pub policy: String,
    pub violations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockAlchemySection {
    pub overall_score: f32,
    pub recommendation: String,
    pub plan_hash: String,
    pub fee_heat_score: f32,
    pub fingerprint_uniqueness: f32,
    pub parallelism_score: f32,
    pub shape_pool_score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RentDeltaSection {
    pub rent_locked: u64,
    pub rent_reclaimed: u64,
    pub net_rent_cost: i64,
    pub chaff_reward: u64,
    pub net_label: String,
    pub summary_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapeMarketSection {
    pub k_shape: usize,
    pub risk_level: String,
    pub class_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevnetRitualSection {
    pub message: String,
    pub shard_path: Vec<u8>,
    pub note: String,
    pub solscan_links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualVmDemo {
    pub network: String,
    pub mainnet_ready: bool,
    pub production_claim: bool,
    pub ritual: RitualSection,
    pub cpi_firewall: CpiFirewallSection,
    pub lock_alchemy: LockAlchemySection,
    pub rent_delta: RentDeltaSection,
    pub shape_market: ShapeMarketSection,
    pub devnet_ritual: DevnetRitualSection,
}

// ── build_ritual_vm_demo ──────────────────────────────────────────────────────

/// Build the full ritual VM demo. Deterministic — no randomness.
pub fn build_ritual_vm_demo() -> RitualVmDemo {
    // ── 1. Compile a ritual from canonical inputs ──────────────────────────────
    let permission_hash = sha256_domain(b"dark_null_v1_demo_permission", &[&[0x01u8; 32]]);
    let spend_hash = sha256_domain(b"dark_null_v1_demo_spend", &[&[0x02u8; 32]]);
    let shadow_hash = sha256_domain(b"dark_null_v1_demo_shadow", &[&[0x03u8; 32]]);
    let receipt_hash = sha256_domain(b"dark_null_v1_demo_receipt", &[&[0x04u8; 32]]);
    let settlement_root = sha256_domain(b"dark_null_v1_demo_settlement", &[&[0x05u8; 32]]);
    let no_custody_hash = sha256_domain(b"dark_null_v1_demo_nocustody", &[&[0x06u8; 32]]);

    let input = RitualInput {
        ritual_type: "AgentSpendNoCustodyV1".to_string(),
        permission_hash,
        spend_hash,
        shadow_bundle_hash: shadow_hash,
        receipt_soul_hash: receipt_hash,
        settlement_root,
        no_custody_hash,
        max_spend_lamports: 1_000_000,
        withdraw_allowed: false,
    };

    let (plan, capsule) = compile_ritual(&input).expect("ritual compilation must succeed");

    let ch = capsule_hash(&capsule);
    let encoded = encode_capsule(&capsule);
    let redacted = redacted_display(&capsule);

    let grammar_steps: Vec<String> = plan
        .instructions
        .iter()
        .map(|i| i.step_name.clone())
        .collect();

    // ── 2. CPI firewall ────────────────────────────────────────────────────────
    let system_prog_hash = program_hash("SystemProgram");
    let nullifier_prog_hash = program_hash("DarkNullifierBanks");

    let manifest = CpiManifest {
        declaring_program_hash: program_hash("DarkRitualGate"),
        allowed_cpis: vec![
            AllowedCpi {
                program_id_hash: system_prog_hash,
                max_count: 1,
                allowed_receiver_hash: None,
                allowed_mint_hash: None,
            },
            AllowedCpi {
                program_id_hash: nullifier_prog_hash,
                max_count: 1,
                allowed_receiver_hash: None,
                allowed_mint_hash: None,
            },
        ],
        forbidden_program_hashes: vec![],
        effect_hash: sha256_domain(b"dark_null_v1_cpi_effect", &[&plan.expected_ritual_hash]),
        max_total_cpi_depth: 2,
    };

    let mh = manifest_hash(&manifest);
    let bound = bind_manifest_to_ritual(&mh, &plan.expected_ritual_hash);

    let policy = CpiPolicy::AllowedOnly(vec![
        AllowedCpi {
            program_id_hash: system_prog_hash,
            max_count: 1,
            allowed_receiver_hash: None,
            allowed_mint_hash: None,
        },
        AllowedCpi {
            program_id_hash: nullifier_prog_hash,
            max_count: 1,
            allowed_receiver_hash: None,
            allowed_mint_hash: None,
        },
    ]);
    let violations = match validate_cpi_manifest(&manifest, &policy) {
        Ok(_) => 0u32,
        Err(_) => 1u32,
    };

    // ── 3. Account lock alchemy ────────────────────────────────────────────────
    let account_a = sha256_domain(b"dark_null_v1_acct_a", &[]);
    let account_b = sha256_domain(b"dark_null_v1_acct_b", &[]);
    let decoy_c = sha256_domain(b"dark_null_v1_decoy_c", &[]);

    let mut lock_plan = AccountLockPlan {
        writable_set: vec![account_a, account_b],
        readonly_set: vec![system_prog_hash],
        decoy_readonly: vec![decoy_c],
        plan_hash: [0u8; 32],
    };
    lock_plan.plan_hash = compute_plan_hash(&lock_plan);

    let heats = vec![
        WritableHeat {
            account_hash: account_a,
            recent_writes: 3,
            heat_score: 0.15,
        },
        WritableHeat {
            account_hash: account_b,
            recent_writes: 1,
            heat_score: 0.05,
        },
    ];

    let shape_privacy = ShapePrivacyScore {
        shape_hash: plan.expected_shape_hash,
        k_shape: 5,
        uniqueness_ratio: 0.1,
    };

    let lock_score = score_lock_plan(&lock_plan, &heats, &shape_privacy);

    // ── 4. Rent delta proof ────────────────────────────────────────────────────
    let chaff_pda_hash = sha256_domain(b"dark_null_v1_chaff_pda", &[]);
    let receipt_pda_hash = sha256_domain(b"dark_null_v1_receipt_pda", &[]);

    let rent_actions = vec![
        RentAction::CreateAccount {
            account_hash: receipt_pda_hash,
            lamports: 2_000,
        },
        RentAction::CloseAccount {
            account_hash: chaff_pda_hash,
            lamports: 5_000,
        },
    ];
    let rent_proof = compute_rent_delta(&rent_actions);
    let rent_summary = summarize_rent_delta(&rent_proof, true);

    // ── 5. Shape market ────────────────────────────────────────────────────────
    let step_names: Vec<&str> = grammar_steps.iter().map(|s| s.as_str()).collect();
    let class_hash = compute_class_hash("AgentSpendNoCustodyV1", &step_names);

    let mut market = ShapeMarket::new();
    // Observe 5 times to achieve k=5 (Safe)
    for slot in 0u64..5u64 {
        market.observe(ShapeObservation {
            shape_hash: class_hash,
            timestamp_slot: 99_000 + slot,
            observer_id_hash: sha256_domain(b"dark_null_v1_observer", &[&slot.to_le_bytes()]),
        });
    }
    let k_report = market.report(&class_hash);
    let risk_str = match &k_report.risk_level {
        ShapeRiskLevel::Safe => "Safe",
        ShapeRiskLevel::LowAnonymity => "LowAnonymity",
        ShapeRiskLevel::Doxxed => "Doxxed",
    };

    // ── 6. Assemble output ────────────────────────────────────────────────────
    RitualVmDemo {
        network:          "solana-devnet".to_string(),
        mainnet_ready:    false,
        production_claim: false,

        ritual: RitualSection {
            ritual_type:   "AgentSpendNoCustodyV1".to_string(),
            grammar_steps,
            shape_hash:    hex_encode(&plan.expected_shape_hash),
            ritual_hash:   hex_encode(&plan.expected_ritual_hash),
            verdict:       redacted.verdict.clone(),
            capsule_hash:  hex_encode(&ch),
            encoded_bytes: encoded.len(),
            public_summary: plan.public_summary.clone(),
        },

        cpi_firewall: CpiFirewallSection {
            manifest_hash:    hex_encode(&mh),
            bound_to_ritual:  hex_encode(&bound),
            policy:           "AllowedOnly".to_string(),
            violations,
        },

        lock_alchemy: LockAlchemySection {
            overall_score:         lock_score.overall,
            recommendation:        lock_score.recommendation.clone(),
            plan_hash:             hex_encode(&lock_plan.plan_hash),
            fee_heat_score:        lock_score.fee_heat_score,
            fingerprint_uniqueness: lock_score.fingerprint_uniqueness,
            parallelism_score:     lock_score.parallelism_score,
            shape_pool_score:      lock_score.shape_pool_score,
        },

        rent_delta: RentDeltaSection {
            rent_locked:    rent_proof.rent_locked,
            rent_reclaimed: rent_proof.rent_reclaimed,
            net_rent_cost:  rent_proof.net_rent_cost,
            chaff_reward:   rent_proof.chaff_reward,
            net_label:      rent_summary.net_label.clone(),
            summary_hash:   hex_encode(&rent_summary.summary_hash),
        },

        shape_market: ShapeMarketSection {
            k_shape:    k_report.k_shape,
            risk_level: risk_str.to_string(),
            class_hash: hex_encode(&class_hash),
        },

        devnet_ritual: DevnetRitualSection {
            message:     "ROGUE".to_string(),
            shard_path:  vec![82, 79, 71, 85, 69],
            note:        "ritual grammar verified; shard_path spell-checks ROGUE via onchain-puzzle-compiler".to_string(),
            solscan_links: vec![
                "https://solscan.io/tx/67jsL2KmhYfg2z1TvkGfzhDoA7YEi8Gojn3gcQkUL3zgMbXSnwjocvj1ZX3AX7ne11J1VUXnG6hnyV2f8DzczeCZ?cluster=devnet".to_string(),
                "https://solscan.io/tx/4UDnJctmmvhmctQhJfLZuKNXgxnVqXrarDHFisozu5UMzxJ32cCXcFzEQo8UdiVmfdp1SG49P7UUoa8Ggb2br4hb?cluster=devnet".to_string(),
                "https://solscan.io/tx/5BCtkPKLxjELu1Sg4UGHm5ja5G1RNyFkufpy62ho4RmXHjEtEMyxcNwTQwDGnCCE491j89WMVzJ8BzQhxJGJCF1a?cluster=devnet".to_string(),
                "https://solscan.io/tx/63LQ8uUZN5f9uxo9PgYF2tgXu4oA6nH8UZH1L93seEazmhaR9zcnkbdSMFWhXaXx4GepHEb3XMQW6Y11Tge9xqZE?cluster=devnet".to_string(),
                "https://solscan.io/tx/5Dd58QcyJSvGtx61EUjGiFexbx9fzYtEsuYNKXMFzoksBbA8dfYPqL3B8ihpgwo79PGccQGN41m6ex7rdiNpuzaQ?cluster=devnet".to_string(),
            ],
        },
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_ritual_vm_demo_succeeds() {
        let demo = build_ritual_vm_demo();
        assert_eq!(demo.ritual.ritual_type, "AgentSpendNoCustodyV1");
        assert_eq!(demo.ritual.verdict, "Accepted");
        assert!(!demo.mainnet_ready);
        assert!(!demo.production_claim);
    }

    #[test]
    fn test_ritual_hash_deterministic() {
        let d1 = build_ritual_vm_demo();
        let d2 = build_ritual_vm_demo();
        assert_eq!(d1.ritual.ritual_hash, d2.ritual.ritual_hash);
        assert_eq!(d1.ritual.shape_hash, d2.ritual.shape_hash);
        assert_eq!(d1.ritual.capsule_hash, d2.ritual.capsule_hash);
    }

    #[test]
    fn test_grammar_has_seven_steps() {
        let demo = build_ritual_vm_demo();
        assert_eq!(demo.ritual.grammar_steps.len(), 7);
        assert!(demo
            .ritual
            .grammar_steps
            .contains(&"PermissionProof".to_string()));
        assert!(demo
            .ritual
            .grammar_steps
            .contains(&"SpendShadow".to_string()));
        assert!(demo
            .ritual
            .grammar_steps
            .contains(&"NullifierInsert".to_string()));
    }

    #[test]
    fn test_cpi_firewall_zero_violations() {
        let demo = build_ritual_vm_demo();
        assert_eq!(demo.cpi_firewall.violations, 0);
        // bound_to_ritual must be a different hash from manifest_hash alone
        assert_ne!(
            demo.cpi_firewall.manifest_hash,
            demo.cpi_firewall.bound_to_ritual
        );
    }

    #[test]
    fn test_lock_alchemy_safe() {
        let demo = build_ritual_vm_demo();
        assert_eq!(demo.lock_alchemy.recommendation, "safe");
        assert!(demo.lock_alchemy.overall_score > 0.5);
    }

    #[test]
    fn test_rent_delta_profitable() {
        let demo = build_ritual_vm_demo();
        // 2000 locked, 5000 reclaimed → net = -3000 → profitable with chaff_reward = 2000
        assert_eq!(demo.rent_delta.rent_locked, 2_000);
        assert_eq!(demo.rent_delta.rent_reclaimed, 5_000);
        assert_eq!(demo.rent_delta.net_rent_cost, -3_000);
        assert_eq!(demo.rent_delta.chaff_reward, 2_000);
        assert_eq!(demo.rent_delta.net_label, "profitable");
    }

    #[test]
    fn test_shape_market_safe() {
        let demo = build_ritual_vm_demo();
        assert_eq!(demo.shape_market.k_shape, 5);
        assert_eq!(demo.shape_market.risk_level, "Safe");
        assert_eq!(demo.shape_market.class_hash.len(), 64);
    }

    #[test]
    fn test_devnet_shard_path_spells_rogue() {
        let demo = build_ritual_vm_demo();
        assert_eq!(demo.devnet_ritual.message, "ROGUE");
        assert_eq!(demo.devnet_ritual.shard_path, vec![82u8, 79, 71, 85, 69]);
        assert_eq!(demo.devnet_ritual.solscan_links.len(), 5);
    }
}
