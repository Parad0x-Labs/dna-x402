use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub enum TokenExtension {
    TransferHook,
    TransferFee,
    MemoTransfer,
    CpiGuard,
    Metadata,
    NonTransferable,
    PermanentDelegate,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplateKind {
    MemeWithFee,
    HuntWithHook,
    SoulboundBadge,
    HintPass,
    RitualBound,
}

#[derive(Debug, Clone)]
pub struct LaunchEstimate {
    pub template: TemplateKind,
    pub template_hash: [u8; 32],
    pub extensions: Vec<TokenExtension>,
    pub estimated_rent_lamports: u64,
    pub deploy_cost_saved_lamports: u64,
    pub compatible: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CompatibilityError {
    IncompatibleExtensions(String),
}

pub fn check_compatibility(extensions: &[TokenExtension]) -> Result<(), CompatibilityError> {
    let has_non_transferable = extensions.contains(&TokenExtension::NonTransferable);
    let has_transfer_fee = extensions.contains(&TokenExtension::TransferFee);
    if has_non_transferable && has_transfer_fee {
        return Err(CompatibilityError::IncompatibleExtensions(
            "NonTransferable is incompatible with TransferFee: cannot charge fee on non-transferable token".to_string(),
        ));
    }
    Ok(())
}

pub fn extensions_for_template(template: &TemplateKind) -> Vec<TokenExtension> {
    match template {
        TemplateKind::MemeWithFee => vec![TokenExtension::TransferFee, TokenExtension::Metadata],
        TemplateKind::HuntWithHook => {
            vec![TokenExtension::TransferHook, TokenExtension::MemoTransfer]
        }
        TemplateKind::SoulboundBadge => {
            vec![TokenExtension::NonTransferable, TokenExtension::Metadata]
        }
        TemplateKind::HintPass => vec![TokenExtension::TransferHook, TokenExtension::TransferFee],
        TemplateKind::RitualBound => vec![
            TokenExtension::TransferHook,
            TokenExtension::MemoTransfer,
            TokenExtension::CpiGuard,
        ],
    }
}

pub fn template_hash(template: &TemplateKind) -> [u8; 32] {
    let label = match template {
        TemplateKind::MemeWithFee => "MemeWithFee",
        TemplateKind::HuntWithHook => "HuntWithHook",
        TemplateKind::SoulboundBadge => "SoulboundBadge",
        TemplateKind::HintPass => "HintPass",
        TemplateKind::RitualBound => "RitualBound",
    };
    let mut hasher = Sha256::new();
    hasher.update(b"template-hash-v1");
    hasher.update(label.as_bytes());
    hasher.finalize().into()
}

/// Base rent estimate per extension (approximate): 2_039_280 lamports per account
const BASE_MINT_RENT: u64 = 1_461_600;
const PER_EXTENSION_RENT: u64 = 300_000;
const CUSTOM_PROGRAM_COST: u64 = 3_000_000_000;

pub fn estimate_launch(template: TemplateKind) -> LaunchEstimate {
    let extensions = extensions_for_template(&template);
    let compatible = check_compatibility(&extensions).is_ok();
    let estimated_rent_lamports = BASE_MINT_RENT + PER_EXTENSION_RENT * extensions.len() as u64;
    let deploy_cost_saved_lamports = CUSTOM_PROGRAM_COST.saturating_sub(estimated_rent_lamports);
    let hash = template_hash(&template);

    LaunchEstimate {
        template,
        template_hash: hash,
        extensions,
        estimated_rent_lamports,
        deploy_cost_saved_lamports,
        compatible,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nontransferable_incompatible_with_fee() {
        let exts = vec![TokenExtension::NonTransferable, TokenExtension::TransferFee];
        let result = check_compatibility(&exts);
        assert!(result.is_err(), "expected incompatibility error");
    }

    #[test]
    fn test_ritual_bound_template_compatible() {
        let exts = extensions_for_template(&TemplateKind::RitualBound);
        assert!(check_compatibility(&exts).is_ok());
    }

    #[test]
    fn test_meme_with_fee_compatible() {
        let exts = extensions_for_template(&TemplateKind::MemeWithFee);
        assert!(check_compatibility(&exts).is_ok());
    }

    #[test]
    fn test_soulbound_compatible() {
        let exts = extensions_for_template(&TemplateKind::SoulboundBadge);
        assert!(check_compatibility(&exts).is_ok());
    }

    #[test]
    fn test_deploy_cost_saved_is_3sol_minus_rent() {
        let estimate = estimate_launch(TemplateKind::MemeWithFee);
        let expected = 3_000_000_000u64.saturating_sub(estimate.estimated_rent_lamports);
        assert_eq!(estimate.deploy_cost_saved_lamports, expected);
    }

    #[test]
    fn test_template_hash_deterministic() {
        let h1 = template_hash(&TemplateKind::RitualBound);
        let h2 = template_hash(&TemplateKind::RitualBound);
        assert_eq!(h1, h2);
        let h3 = template_hash(&TemplateKind::MemeWithFee);
        assert_ne!(h1, h3, "different templates should have different hashes");
    }

    #[test]
    fn test_all_templates_have_extensions() {
        let templates = [
            TemplateKind::MemeWithFee,
            TemplateKind::HuntWithHook,
            TemplateKind::SoulboundBadge,
            TemplateKind::HintPass,
            TemplateKind::RitualBound,
        ];
        for t in &templates {
            let exts = extensions_for_template(t);
            assert!(!exts.is_empty(), "{:?} has no extensions", t);
        }
    }
}
