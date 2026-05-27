use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCaveats {
    pub max_total_amount_lamports: u64,
    pub max_single_spend_lamports: u64,
    pub allowed_scope_hashes: Vec<[u8; 32]>,
    pub denied_scope_hashes: Vec<[u8; 32]>,
    pub expires_at_slot: u64,
    pub not_before_slot: u64,
    pub max_cu_price_micro_lamports: u64,
    pub max_priority_fee_lamports: u64,
    pub no_withdraw: bool,
    pub no_external_transfer: bool,
    pub only_receipt_spend: bool,
    pub daily_loss_limit_lamports: u64,
}

#[derive(Clone, Debug)]
pub struct SpendContext {
    pub amount_lamports: u64,
    pub scope_hash: [u8; 32],
    pub current_slot: u64,
    pub cu_price_micro_lamports: u64,
    pub priority_fee_lamports: u64,
    pub is_withdraw: bool,
    pub is_external_transfer: bool,
    pub is_receipt_spend: bool,
    pub session_total_spent: u64,
    pub session_daily_loss: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CaveatError {
    Expired,
    NotYetValid,
    OverMaxSingleSpend,
    OverMaxTotalSpend,
    ScopeNotAllowed,
    ScopeDenied,
    WithdrawForbidden,
    ExternalTransferForbidden,
    MustBeReceiptSpend,
    CuPriceExceeded,
    PriorityFeeExceeded,
    DailyLossLimitExceeded,
}

pub fn check_caveats(caveats: &AgentCaveats, ctx: &SpendContext) -> Result<(), CaveatError> {
    if ctx.current_slot >= caveats.expires_at_slot {
        return Err(CaveatError::Expired);
    }
    if ctx.current_slot < caveats.not_before_slot {
        return Err(CaveatError::NotYetValid);
    }
    if ctx.amount_lamports > caveats.max_single_spend_lamports {
        return Err(CaveatError::OverMaxSingleSpend);
    }
    if ctx.session_total_spent + ctx.amount_lamports > caveats.max_total_amount_lamports {
        return Err(CaveatError::OverMaxTotalSpend);
    }
    // denied scope wins over allowed
    if caveats.denied_scope_hashes.contains(&ctx.scope_hash) {
        return Err(CaveatError::ScopeDenied);
    }
    if !caveats.allowed_scope_hashes.is_empty()
        && !caveats.allowed_scope_hashes.contains(&ctx.scope_hash)
    {
        return Err(CaveatError::ScopeNotAllowed);
    }
    if caveats.no_withdraw && ctx.is_withdraw {
        return Err(CaveatError::WithdrawForbidden);
    }
    if caveats.no_external_transfer && ctx.is_external_transfer {
        return Err(CaveatError::ExternalTransferForbidden);
    }
    if caveats.only_receipt_spend && !ctx.is_receipt_spend {
        return Err(CaveatError::MustBeReceiptSpend);
    }
    if ctx.cu_price_micro_lamports > caveats.max_cu_price_micro_lamports {
        return Err(CaveatError::CuPriceExceeded);
    }
    if ctx.priority_fee_lamports > caveats.max_priority_fee_lamports {
        return Err(CaveatError::PriorityFeeExceeded);
    }
    if ctx.session_daily_loss + ctx.amount_lamports > caveats.daily_loss_limit_lamports {
        return Err(CaveatError::DailyLossLimitExceeded);
    }
    Ok(())
}

/// Caveat fingerprint — changes if any caveat field changes.
pub fn caveat_fingerprint(caveats: &AgentCaveats) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(caveats.max_total_amount_lamports.to_le_bytes());
    h.update(caveats.max_single_spend_lamports.to_le_bytes());
    for s in &caveats.allowed_scope_hashes {
        h.update(s);
    }
    for s in &caveats.denied_scope_hashes {
        h.update(s);
    }
    h.update(caveats.expires_at_slot.to_le_bytes());
    h.update(caveats.not_before_slot.to_le_bytes());
    h.update(caveats.max_cu_price_micro_lamports.to_le_bytes());
    h.update(caveats.max_priority_fee_lamports.to_le_bytes());
    h.update([
        caveats.no_withdraw as u8,
        caveats.no_external_transfer as u8,
        caveats.only_receipt_spend as u8,
    ]);
    h.update(caveats.daily_loss_limit_lamports.to_le_bytes());
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_caveats() -> AgentCaveats {
        AgentCaveats {
            max_total_amount_lamports: 1_000_000,
            max_single_spend_lamports: 100_000,
            allowed_scope_hashes: vec![[0xAA; 32]],
            denied_scope_hashes: vec![],
            expires_at_slot: 10_000,
            not_before_slot: 100,
            max_cu_price_micro_lamports: 1_000,
            max_priority_fee_lamports: 5_000,
            no_withdraw: false,
            no_external_transfer: false,
            only_receipt_spend: false,
            daily_loss_limit_lamports: 500_000,
        }
    }

    fn base_ctx() -> SpendContext {
        SpendContext {
            amount_lamports: 50_000,
            scope_hash: [0xAA; 32],
            current_slot: 500,
            cu_price_micro_lamports: 500,
            priority_fee_lamports: 1_000,
            is_withdraw: false,
            is_external_transfer: false,
            is_receipt_spend: true,
            session_total_spent: 0,
            session_daily_loss: 0,
        }
    }

    #[test]
    fn test_expired() {
        let c = base_caveats();
        let mut ctx = base_ctx();
        ctx.current_slot = 10_000; // equals expires_at_slot -> expired
        assert_eq!(check_caveats(&c, &ctx), Err(CaveatError::Expired));
    }

    #[test]
    fn test_not_before() {
        let c = base_caveats();
        let mut ctx = base_ctx();
        ctx.current_slot = 50; // below not_before_slot=100
        assert_eq!(check_caveats(&c, &ctx), Err(CaveatError::NotYetValid));
    }

    #[test]
    fn test_over_single_spend() {
        let c = base_caveats();
        let mut ctx = base_ctx();
        ctx.amount_lamports = 200_000; // > max_single_spend=100_000
        assert_eq!(
            check_caveats(&c, &ctx),
            Err(CaveatError::OverMaxSingleSpend)
        );
    }

    #[test]
    fn test_over_total_spend() {
        let c = base_caveats();
        let mut ctx = base_ctx();
        ctx.session_total_spent = 990_000; // 990_000+50_000 > 1_000_000
        assert_eq!(check_caveats(&c, &ctx), Err(CaveatError::OverMaxTotalSpend));
    }

    #[test]
    fn test_scope_not_allowed() {
        let c = base_caveats();
        let mut ctx = base_ctx();
        ctx.scope_hash = [0xBB; 32]; // not in allowed list
        assert_eq!(check_caveats(&c, &ctx), Err(CaveatError::ScopeNotAllowed));
    }

    #[test]
    fn test_denied_scope_wins() {
        let mut c = base_caveats();
        // Put the scope in both allowed and denied — denied wins
        c.denied_scope_hashes = vec![[0xAA; 32]];
        let ctx = base_ctx();
        assert_eq!(check_caveats(&c, &ctx), Err(CaveatError::ScopeDenied));
    }

    #[test]
    fn test_withdraw_forbidden() {
        let mut c = base_caveats();
        c.no_withdraw = true;
        let mut ctx = base_ctx();
        ctx.is_withdraw = true;
        assert_eq!(check_caveats(&c, &ctx), Err(CaveatError::WithdrawForbidden));
    }

    #[test]
    fn test_external_transfer_forbidden() {
        let mut c = base_caveats();
        c.no_external_transfer = true;
        let mut ctx = base_ctx();
        ctx.is_external_transfer = true;
        assert_eq!(
            check_caveats(&c, &ctx),
            Err(CaveatError::ExternalTransferForbidden)
        );
    }

    #[test]
    fn test_must_be_receipt_spend() {
        let mut c = base_caveats();
        c.only_receipt_spend = true;
        let mut ctx = base_ctx();
        ctx.is_receipt_spend = false;
        assert_eq!(
            check_caveats(&c, &ctx),
            Err(CaveatError::MustBeReceiptSpend)
        );
    }

    #[test]
    fn test_cu_price_exceeded() {
        let c = base_caveats();
        let mut ctx = base_ctx();
        ctx.cu_price_micro_lamports = 2_000; // > max=1_000
        assert_eq!(check_caveats(&c, &ctx), Err(CaveatError::CuPriceExceeded));
    }

    #[test]
    fn test_caveat_fingerprint_changes_on_any_field() {
        let c1 = base_caveats();
        let fp1 = caveat_fingerprint(&c1);

        let mut c2 = c1.clone();
        c2.max_total_amount_lamports += 1;
        assert_ne!(fp1, caveat_fingerprint(&c2));

        let mut c3 = c1.clone();
        c3.expires_at_slot += 1;
        assert_ne!(fp1, caveat_fingerprint(&c3));

        let mut c4 = c1.clone();
        c4.no_withdraw = true;
        assert_ne!(fp1, caveat_fingerprint(&c4));

        let mut c5 = c1.clone();
        c5.daily_loss_limit_lamports = 1;
        assert_ne!(fp1, caveat_fingerprint(&c5));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_priority_fee_exceeded() {
        let c = base_caveats(); // max_priority_fee_lamports = 5_000
        let mut ctx = base_ctx();
        ctx.priority_fee_lamports = 6_000; // > 5_000
        assert_eq!(
            check_caveats(&c, &ctx),
            Err(CaveatError::PriorityFeeExceeded)
        );
    }

    #[test]
    fn test_daily_loss_limit_exceeded() {
        let c = base_caveats(); // daily_loss_limit = 500_000
        let mut ctx = base_ctx();
        ctx.session_daily_loss = 490_000;
        ctx.amount_lamports = 50_000; // 490_000 + 50_000 = 540_000 > 500_000
        assert_eq!(
            check_caveats(&c, &ctx),
            Err(CaveatError::DailyLossLimitExceeded)
        );
    }

    #[test]
    fn test_exactly_at_not_before_ok() {
        // not_before_slot = 100; check is current_slot < not_before_slot → at 100 is ok
        let c = base_caveats();
        let mut ctx = base_ctx();
        ctx.current_slot = 100; // == not_before_slot
        assert!(check_caveats(&c, &ctx).is_ok());
    }

    #[test]
    fn test_caveat_fingerprint_nonzero() {
        let c = base_caveats();
        let fp = caveat_fingerprint(&c);
        assert_ne!(fp, [0u8; 32]);
    }

    #[test]
    fn test_valid_base_case_passes() {
        let c = base_caveats();
        let ctx = base_ctx();
        assert!(check_caveats(&c, &ctx).is_ok());
    }
}
