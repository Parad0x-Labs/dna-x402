use sha2::{Digest, Sha256};

pub const DOMAIN_COUPON: u8 = 0x30;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteClass {
    Direct,
    Jito,
    StakeWeightedQos,
    Custom(u8),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CouponSpec {
    pub coupon_id: [u8; 32],
    pub payer_hash: [u8; 32],
    pub route_class: RouteClass,
    pub max_cu_limit: u32,
    pub max_cu_price_micro_lamports: u64,
    pub max_total_priority_fee_lamports: u64,
    pub writable_account_class_hash: [u8; 32],
    pub expires_at_slot: u64,
    pub receipt_hash: [u8; 32],
}

impl CouponSpec {
    pub fn commitment(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_COUPON]);
        h.update(&self.coupon_id);
        h.update(&self.payer_hash);
        h.update(self.max_cu_limit.to_le_bytes());
        h.update(self.max_cu_price_micro_lamports.to_le_bytes());
        h.update(self.max_total_priority_fee_lamports.to_le_bytes());
        h.update(&self.writable_account_class_hash);
        h.update(self.expires_at_slot.to_le_bytes());
        h.update(&self.receipt_hash);
        let route_byte: u8 = match &self.route_class {
            RouteClass::Direct => 0,
            RouteClass::Jito => 1,
            RouteClass::StakeWeightedQos => 2,
            RouteClass::Custom(b) => *b,
        };
        h.update([route_byte]);
        h.finalize().into()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CouponError {
    Expired,
    CuPriceExceeded,
    WrongReceipt,
    WrongRoute,
    WrongWritableClass,
    AlreadyRedeemed,
    TotalFeeExceeded,
}

pub struct CouponMarket {
    redeemed: std::collections::HashSet<[u8; 32]>,
}

impl CouponMarket {
    pub fn new() -> Self {
        Self {
            redeemed: Default::default(),
        }
    }

    pub fn redeem(
        &mut self,
        spec: &CouponSpec,
        current_slot: u64,
        actual_cu_price: u64,
        actual_route: &RouteClass,
        actual_receipt: &[u8; 32],
        actual_writable_class: &[u8; 32],
        actual_priority_fee: u64,
    ) -> Result<[u8; 32], CouponError> {
        let commitment = spec.commitment();
        if self.redeemed.contains(&commitment) {
            return Err(CouponError::AlreadyRedeemed);
        }
        if current_slot >= spec.expires_at_slot {
            return Err(CouponError::Expired);
        }
        if actual_cu_price > spec.max_cu_price_micro_lamports {
            return Err(CouponError::CuPriceExceeded);
        }
        if actual_priority_fee > spec.max_total_priority_fee_lamports {
            return Err(CouponError::TotalFeeExceeded);
        }
        if actual_receipt != &spec.receipt_hash {
            return Err(CouponError::WrongReceipt);
        }
        if actual_route != &spec.route_class {
            return Err(CouponError::WrongRoute);
        }
        if actual_writable_class != &spec.writable_account_class_hash {
            return Err(CouponError::WrongWritableClass);
        }
        self.redeemed.insert(commitment);
        Ok(commitment)
    }
}

impl Default for CouponMarket {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bytes(b: u8) -> [u8; 32] {
        let mut arr = [0u8; 32];
        arr[0] = b;
        arr
    }

    fn base_spec() -> CouponSpec {
        CouponSpec {
            coupon_id: make_bytes(1),
            payer_hash: make_bytes(2),
            route_class: RouteClass::Direct,
            max_cu_limit: 200_000,
            max_cu_price_micro_lamports: 1_000,
            max_total_priority_fee_lamports: 5_000,
            writable_account_class_hash: make_bytes(10),
            expires_at_slot: 1000,
            receipt_hash: make_bytes(20),
        }
    }

    #[test]
    fn test_redeem_ok() {
        let mut market = CouponMarket::new();
        let spec = base_spec();
        let result = market.redeem(
            &spec,
            500,
            1_000,
            &RouteClass::Direct,
            &make_bytes(20),
            &make_bytes(10),
            5_000,
        );
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), spec.commitment());
    }

    #[test]
    fn test_expired() {
        let mut market = CouponMarket::new();
        let spec = base_spec();
        // current_slot == expires_at_slot => expired
        let result = market.redeem(
            &spec,
            1000,
            500,
            &RouteClass::Direct,
            &make_bytes(20),
            &make_bytes(10),
            500,
        );
        assert_eq!(result, Err(CouponError::Expired));
    }

    #[test]
    fn test_cu_price_exceeded() {
        let mut market = CouponMarket::new();
        let spec = base_spec();
        let result = market.redeem(
            &spec,
            500,
            1_001, // exceeds max 1_000
            &RouteClass::Direct,
            &make_bytes(20),
            &make_bytes(10),
            500,
        );
        assert_eq!(result, Err(CouponError::CuPriceExceeded));
    }

    #[test]
    fn test_wrong_receipt() {
        let mut market = CouponMarket::new();
        let spec = base_spec();
        let result = market.redeem(
            &spec,
            500,
            500,
            &RouteClass::Direct,
            &make_bytes(99), // wrong receipt
            &make_bytes(10),
            500,
        );
        assert_eq!(result, Err(CouponError::WrongReceipt));
    }

    #[test]
    fn test_wrong_route() {
        let mut market = CouponMarket::new();
        let spec = base_spec();
        let result = market.redeem(
            &spec,
            500,
            500,
            &RouteClass::Jito, // wrong route (spec is Direct)
            &make_bytes(20),
            &make_bytes(10),
            500,
        );
        assert_eq!(result, Err(CouponError::WrongRoute));
    }

    #[test]
    fn test_already_redeemed() {
        let mut market = CouponMarket::new();
        let spec = base_spec();
        // First redemption succeeds
        market
            .redeem(
                &spec,
                500,
                500,
                &RouteClass::Direct,
                &make_bytes(20),
                &make_bytes(10),
                500,
            )
            .unwrap();
        // Second redemption fails
        let result = market.redeem(
            &spec,
            500,
            500,
            &RouteClass::Direct,
            &make_bytes(20),
            &make_bytes(10),
            500,
        );
        assert_eq!(result, Err(CouponError::AlreadyRedeemed));
    }

    #[test]
    fn test_writable_class_matters() {
        let mut market = CouponMarket::new();
        let spec = base_spec();
        let result = market.redeem(
            &spec,
            500,
            500,
            &RouteClass::Direct,
            &make_bytes(20),
            &make_bytes(99), // wrong writable class
            500,
        );
        assert_eq!(result, Err(CouponError::WrongWritableClass));
    }
}
