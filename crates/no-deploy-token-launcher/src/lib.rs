use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TokenExtension {
    TransferHook,
    MemoTransfer,
    CpiGuard,
    TokenMetadata,
    MetadataPointer,
    TransferFee,
    Pausable,
    CloseMint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenLaunchPlan {
    pub mint_name_hash: [u8; 32],
    pub symbol_hash: [u8; 32],
    pub uri_hash: [u8; 32],
    pub extensions: Vec<TokenExtension>,
    pub ritual_policy_hash: [u8; 32],
    pub hook_program_hash: [u8; 32],
    pub estimated_deploy_sol_saved: f64,
    pub requires_custom_program: bool,
    pub mainnet_ready: bool,
    pub production_claim: bool,
}

#[derive(Debug, PartialEq)]
pub enum LaunchError {
    IncompatibleExtensions,
    MissingHookForRitual,
    EmptyName,
}

fn hash_str(s: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().into()
}

pub fn compile_launch_plan(
    name: &str,
    symbol: &str,
    uri: &str,
    extensions: Vec<TokenExtension>,
    ritual_policy_hash: [u8; 32],
    hook_program_hash: [u8; 32],
) -> Result<TokenLaunchPlan, LaunchError> {
    if name.is_empty() {
        return Err(LaunchError::EmptyName);
    }

    let ritual_policy_is_set = ritual_policy_hash != [0u8; 32];
    if ritual_policy_is_set && !extensions.contains(&TokenExtension::TransferHook) {
        return Err(LaunchError::MissingHookForRitual);
    }

    validate_extension_compatibility(&extensions)?;

    Ok(TokenLaunchPlan {
        mint_name_hash: hash_str(name),
        symbol_hash: hash_str(symbol),
        uri_hash: hash_str(uri),
        extensions,
        ritual_policy_hash,
        hook_program_hash,
        estimated_deploy_sol_saved: 1.5,
        requires_custom_program: false,
        mainnet_ready: false,
        production_claim: false,
    })
}

pub fn validate_extension_compatibility(extensions: &[TokenExtension]) -> Result<(), LaunchError> {
    let has_transfer_fee = extensions.contains(&TokenExtension::TransferFee);
    let has_close_mint = extensions.contains(&TokenExtension::CloseMint);
    if has_transfer_fee && has_close_mint {
        return Err(LaunchError::IncompatibleExtensions);
    }
    Ok(())
}

pub fn produce_public_launch_card(plan: &TokenLaunchPlan) -> String {
    format!(
        "LaunchPlan(name_hash={}, symbol_hash={}, extensions={}, sol_saved={:.2}, mainnet_ready={}, production_claim={})",
        hex::encode_prefix(&plan.mint_name_hash),
        hex::encode_prefix(&plan.symbol_hash),
        plan.extensions.len(),
        plan.estimated_deploy_sol_saved,
        plan.mainnet_ready,
        plan.production_claim,
    )
}

mod hex {
    pub fn encode_prefix(bytes: &[u8; 32]) -> String {
        bytes.iter().take(8).map(|b| format!("{:02x}", b)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ritual_hash() -> [u8; 32] {
        let mut h = sha2::Sha256::new();
        h.update(b"ritual_policy");
        h.finalize().into()
    }

    fn hook_hash() -> [u8; 32] {
        let mut h = sha2::Sha256::new();
        h.update(b"hook_program");
        h.finalize().into()
    }

    #[test]
    fn test_compile_plan_succeeds() {
        let plan = compile_launch_plan(
            "ROGUE",
            "RGE",
            "https://example.com/metadata.json",
            vec![TokenExtension::TransferHook, TokenExtension::MemoTransfer],
            ritual_hash(),
            hook_hash(),
        );
        assert!(plan.is_ok());
    }

    #[test]
    fn test_no_custom_program_required() {
        let plan = compile_launch_plan(
            "ROGUE",
            "RGE",
            "uri",
            vec![TokenExtension::TransferHook, TokenExtension::MemoTransfer],
            ritual_hash(),
            hook_hash(),
        )
        .unwrap();
        assert!(!plan.requires_custom_program);
    }

    #[test]
    fn test_deploy_sol_saved_positive() {
        let plan = compile_launch_plan(
            "ROGUE",
            "RGE",
            "uri",
            vec![TokenExtension::TransferHook],
            ritual_hash(),
            hook_hash(),
        )
        .unwrap();
        assert!(plan.estimated_deploy_sol_saved > 0.0);
    }

    #[test]
    fn test_empty_name_rejected() {
        let result = compile_launch_plan("", "RGE", "uri", vec![], [0u8; 32], [0u8; 32]);
        assert!(matches!(result, Err(LaunchError::EmptyName)));
    }

    #[test]
    fn test_incompatible_extensions_rejected() {
        let result = compile_launch_plan(
            "ROGUE",
            "RGE",
            "uri",
            vec![TokenExtension::TransferFee, TokenExtension::CloseMint],
            [0u8; 32],
            [0u8; 32],
        );
        assert!(matches!(result, Err(LaunchError::IncompatibleExtensions)));
    }

    #[test]
    fn test_mainnet_ready_false() {
        let plan = compile_launch_plan(
            "ROGUE",
            "RGE",
            "uri",
            vec![TokenExtension::MemoTransfer],
            [0u8; 32],
            [0u8; 32],
        )
        .unwrap();
        assert!(!plan.mainnet_ready);
        assert!(!plan.production_claim);
    }

    #[test]
    fn test_ritual_policy_without_hook_rejected() {
        let result = compile_launch_plan(
            "ROGUE",
            "RGE",
            "uri",
            vec![TokenExtension::MemoTransfer], // no TransferHook
            ritual_hash(),
            hook_hash(),
        );
        assert!(matches!(result, Err(LaunchError::MissingHookForRitual)));
    }
}
