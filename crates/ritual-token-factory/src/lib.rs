//! Ritual Token Factory — typed configuration plan for a ritual-bound Token-2022 mint.
//! Pure Rust, no network. Plans the extensions and instructions needed to create the mint.

use serde::{Deserialize, Serialize};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualMintConfig {
    pub hook_program_id: [u8; 32],
    pub ritual_gate_program_id: [u8; 32],
    pub decimals: u8,
    pub enable_memo_transfer: bool,
    pub enable_cpi_guard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualMintSetupPlan {
    pub config: RitualMintConfig,
    pub extensions: Vec<String>, // ["TransferHook", "MemoTransfer", "CpiGuard"]
    pub instructions_needed: Vec<String>, // ordered instruction names for mint creation
    pub estimated_account_size_bytes: usize,
    pub mainnet_ready: bool,
    pub production_claim: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualTokenEvidence {
    pub network: String,
    pub mint_address: String, // "pending_devnet" if not yet created
    pub hook_program: String,
    pub ritual_gate_program: String,
    pub source_token_account: String,      // "pending_devnet"
    pub destination_token_account: String, // "pending_devnet"
    pub extensions_enabled: Vec<String>,
    pub mainnet_ready: bool,
    pub production_claim: bool,
}

// ── Core functions ────────────────────────────────────────────────────────────

/// Return a plan for creating the ritual-bound mint.
pub fn plan_ritual_mint(config: &RitualMintConfig) -> RitualMintSetupPlan {
    let mut extensions = vec!["TransferHook".to_string()];
    if config.enable_memo_transfer {
        extensions.push("MemoTransfer".to_string());
    }
    if config.enable_cpi_guard {
        extensions.push("CpiGuard".to_string());
    }

    let mut instructions_needed = vec![
        "CreateAccount".to_string(),
        "InitializeTransferHookMint".to_string(),
    ];
    if config.enable_memo_transfer {
        instructions_needed.push("InitializeMemoTransfer".to_string());
    }
    if config.enable_cpi_guard {
        instructions_needed.push("InitializeCpiGuard".to_string());
    }
    instructions_needed.push("InitializeMint2".to_string());

    let estimated_account_size_bytes = estimate_mint_account_size(config);

    RitualMintSetupPlan {
        config: config.clone(),
        extensions,
        instructions_needed,
        estimated_account_size_bytes,
        mainnet_ready: false,
        production_claim: false,
    }
}

/// Default config using the dark_ritual_gate.
pub fn default_ritual_config(
    hook_program_id: [u8; 32],
    ritual_gate_program_id: [u8; 32],
) -> RitualMintConfig {
    RitualMintConfig {
        hook_program_id,
        ritual_gate_program_id,
        decimals: 6,
        enable_memo_transfer: true,
        enable_cpi_guard: true,
    }
}

/// Estimate the mint account size in bytes.
/// Base mint: 82 bytes
/// TransferHook extension: ~72 bytes + 8 TLV overhead
/// MemoTransfer extension: ~18 bytes + 8 TLV overhead
/// CpiGuard extension: ~18 bytes + 8 TLV overhead
pub fn estimate_mint_account_size(config: &RitualMintConfig) -> usize {
    let base = 82usize;
    // TransferHook is always required
    let mut size = base + 72 + 8;
    if config.enable_memo_transfer {
        size += 18 + 8;
    }
    if config.enable_cpi_guard {
        size += 18 + 8;
    }
    size
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn hook_id() -> [u8; 32] {
        [0xaau8; 32]
    }

    fn gate_id() -> [u8; 32] {
        [0xbbu8; 32]
    }

    fn full_config() -> RitualMintConfig {
        RitualMintConfig {
            hook_program_id: hook_id(),
            ritual_gate_program_id: gate_id(),
            decimals: 6,
            enable_memo_transfer: true,
            enable_cpi_guard: true,
        }
    }

    #[test]
    fn test_plan_always_includes_transfer_hook() {
        let config = full_config();
        let plan = plan_ritual_mint(&config);
        assert!(plan.extensions.contains(&"TransferHook".to_string()));
        assert!(plan
            .instructions_needed
            .contains(&"InitializeTransferHookMint".to_string()));
    }

    #[test]
    fn test_memo_transfer_optional() {
        let mut config = full_config();
        config.enable_memo_transfer = false;
        let plan = plan_ritual_mint(&config);
        assert!(!plan.extensions.contains(&"MemoTransfer".to_string()));
        assert!(!plan
            .instructions_needed
            .contains(&"InitializeMemoTransfer".to_string()));

        config.enable_memo_transfer = true;
        let plan2 = plan_ritual_mint(&config);
        assert!(plan2.extensions.contains(&"MemoTransfer".to_string()));
        assert!(plan2
            .instructions_needed
            .contains(&"InitializeMemoTransfer".to_string()));
    }

    #[test]
    fn test_cpi_guard_optional() {
        let mut config = full_config();
        config.enable_cpi_guard = false;
        let plan = plan_ritual_mint(&config);
        assert!(!plan.extensions.contains(&"CpiGuard".to_string()));
        assert!(!plan
            .instructions_needed
            .contains(&"InitializeCpiGuard".to_string()));

        config.enable_cpi_guard = true;
        let plan2 = plan_ritual_mint(&config);
        assert!(plan2.extensions.contains(&"CpiGuard".to_string()));
        assert!(plan2
            .instructions_needed
            .contains(&"InitializeCpiGuard".to_string()));
    }

    #[test]
    fn test_both_extensions_enabled() {
        let config = full_config();
        let plan = plan_ritual_mint(&config);
        assert!(plan.extensions.contains(&"TransferHook".to_string()));
        assert!(plan.extensions.contains(&"MemoTransfer".to_string()));
        assert!(plan.extensions.contains(&"CpiGuard".to_string()));
        assert_eq!(plan.extensions.len(), 3);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let plan = plan_ritual_mint(&full_config());
        assert!(!plan.mainnet_ready);
    }

    #[test]
    fn test_production_claim_false() {
        let plan = plan_ritual_mint(&full_config());
        assert!(!plan.production_claim);
    }

    #[test]
    fn test_account_size_at_least_82_bytes() {
        let config = RitualMintConfig {
            hook_program_id: hook_id(),
            ritual_gate_program_id: gate_id(),
            decimals: 6,
            enable_memo_transfer: false,
            enable_cpi_guard: false,
        };
        let size = estimate_mint_account_size(&config);
        assert!(
            size >= 82,
            "mint account must be at least 82 bytes, got {}",
            size
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_account_size_both_extensions() {
        // base=82, hook=80, memo=26, cpi=26 → 214
        let config = full_config();
        assert_eq!(estimate_mint_account_size(&config), 214);
    }

    #[test]
    fn test_account_size_hook_only() {
        // base=82, hook=80 → 162
        let config = RitualMintConfig {
            hook_program_id: hook_id(),
            ritual_gate_program_id: gate_id(),
            decimals: 6,
            enable_memo_transfer: false,
            enable_cpi_guard: false,
        };
        assert_eq!(estimate_mint_account_size(&config), 162);
    }

    #[test]
    fn test_instructions_end_with_initialize_mint2() {
        let plan = plan_ritual_mint(&full_config());
        assert_eq!(
            plan.instructions_needed.last().unwrap(),
            "InitializeMint2",
            "last instruction must always be InitializeMint2"
        );
    }

    #[test]
    fn test_instructions_start_with_create_account() {
        let plan = plan_ritual_mint(&full_config());
        assert_eq!(
            plan.instructions_needed.first().unwrap(),
            "CreateAccount",
            "first instruction must always be CreateAccount"
        );
    }

    #[test]
    fn test_default_config_decimals_six() {
        let cfg = default_ritual_config(hook_id(), gate_id());
        assert_eq!(cfg.decimals, 6);
    }

    #[test]
    fn test_default_config_extensions_enabled() {
        let cfg = default_ritual_config(hook_id(), gate_id());
        assert!(cfg.enable_memo_transfer);
        assert!(cfg.enable_cpi_guard);
    }

    #[test]
    fn test_plan_config_preserved() {
        let config = full_config();
        let plan = plan_ritual_mint(&config);
        assert_eq!(plan.config.decimals, config.decimals);
        assert_eq!(plan.config.hook_program_id, config.hook_program_id);
        assert_eq!(
            plan.config.enable_memo_transfer,
            config.enable_memo_transfer
        );
        assert_eq!(plan.config.enable_cpi_guard, config.enable_cpi_guard);
    }

    #[test]
    fn test_hook_only_one_extension() {
        let config = RitualMintConfig {
            hook_program_id: hook_id(),
            ritual_gate_program_id: gate_id(),
            decimals: 6,
            enable_memo_transfer: false,
            enable_cpi_guard: false,
        };
        let plan = plan_ritual_mint(&config);
        assert_eq!(plan.extensions.len(), 1);
        assert_eq!(plan.extensions[0], "TransferHook");
    }

    #[test]
    fn test_hook_only_three_instructions() {
        // CreateAccount, InitializeTransferHookMint, InitializeMint2
        let config = RitualMintConfig {
            hook_program_id: hook_id(),
            ritual_gate_program_id: gate_id(),
            decimals: 6,
            enable_memo_transfer: false,
            enable_cpi_guard: false,
        };
        let plan = plan_ritual_mint(&config);
        assert_eq!(plan.instructions_needed.len(), 3);
    }
}
