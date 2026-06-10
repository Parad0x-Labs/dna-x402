//! KVAC × x402 integration (DEVNET, unaudited).
//!
//! Today's x402 proof ([`dark_x402_core::X402PaymentProof`]) carries
//! `payer_pubkey` in the clear — the gateway learns exactly which wallet paid on
//! every call. This crate replaces that identity leak with a KVAC presentation:
//! the agent proves it holds a valid access credential (tier, spend-cap) **without
//! revealing who it is**, and the per-context nullifier becomes the anonymous
//! replay / rate-limit key.
//!
//! ## The binding
//! The KVAC presentation is bound to the x402 resource it is paying for by deriving
//! the credential **context** from the payment requirement's scope hash plus an
//! epoch:
//! ```text
//!   context = SHA256( X402_CTX_DOMAIN ‖ req.scope_hash() ‖ epoch_le )
//! ```
//! So the nullifier `n = ms·H_ctx` is unique per **(agent, resource, epoch)**.
//! Recording `n` single-use on-chain (via `dark_nullifier_record`) yields
//! **one anonymous access per agent per resource per epoch** — a rate limit that
//! never learns the agent's identity. Different resource or different epoch ⇒
//! different `n` ⇒ allowed; the same one twice ⇒ `AlreadyRecorded`.
//!
//! The KVAC verifier runs here, in the gateway, with the issuer secret key
//! (keyed-verification); only the nullifier touches the chain.

use dark_kvac::keys::{IssuerParams, IssuerSecretKey};
use dark_kvac::params::Generators;
use dark_kvac::present::Presentation;
use dark_x402_core::X402PaymentRequirement;
use sha2::{Digest, Sha256};

/// Domain separator binding a KVAC context to an x402 resource scope.
pub const X402_CTX_DOMAIN: &[u8] = b"DNAx402/KVAC/x402-ctx/v1";

/// Derive the KVAC context tag from an x402 payment requirement and an epoch.
/// `context = SHA256(domain ‖ req.scope_hash() ‖ epoch_le)` — 32 bytes, the fixed
/// context KVAC expects. Binds the credential show to *this resource, this epoch*.
pub fn x402_context(req: &X402PaymentRequirement, epoch: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(X402_CTX_DOMAIN);
    h.update(req.scope_hash());
    h.update(epoch.to_le_bytes());
    h.finalize().into()
}

/// The gateway's access decision for a presented credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessDecision {
    /// The credential verified. `nullifier` (32 bytes = compressed `n`) must be
    /// recorded single-use on-chain; if it is already recorded the access is a
    /// replay and must be refused (anonymous rate-limit hit).
    Granted { nullifier: [u8; 32] },
    /// The presented bytes failed to parse as a canonical presentation.
    DeniedMalformed,
    /// The presentation parsed but the proof did not verify (forged / wrong
    /// credential / wrong resource-epoch context).
    DeniedInvalidProof,
}

/// A keyed-verification gateway: holds the issuer secret key and verifies
/// presentations bound to x402 requirements. Mirrors the off-chain-verifier
/// deployment (the gateway already holds `sk`; only the nullifier goes on-chain).
pub struct KvacGate {
    gens: Generators,
    sk: IssuerSecretKey,
}

impl KvacGate {
    pub fn new(sk: IssuerSecretKey) -> Self {
        KvacGate {
            gens: Generators::new(),
            sk,
        }
    }

    pub fn generators(&self) -> &Generators {
        &self.gens
    }

    pub fn secret_key(&self) -> &IssuerSecretKey {
        &self.sk
    }

    /// Published issuer params, pinned for clients.
    pub fn iparams(&self) -> IssuerParams {
        self.sk.iparams(&self.gens)
    }

    /// Verify a presented credential for a paid x402 call. `pres_bytes` is the
    /// 448-byte canonical wire encoding the agent sends; `req` is the x402 payment
    /// requirement (which resource); `epoch` is the current rate-limit epoch;
    /// `revealed_attrs` is the predicate blob (empty when all attributes hidden).
    ///
    /// On `Granted`, the caller records the returned `nullifier` single-use
    /// on-chain; an `AlreadyRecorded` from that record is the anonymous rate-limit.
    pub fn verify_access(
        &self,
        pres_bytes: &[u8],
        req: &X402PaymentRequirement,
        epoch: u64,
        revealed_attrs: &[u8],
    ) -> AccessDecision {
        let pres = match Presentation::from_bytes(pres_bytes) {
            Some(p) => p,
            None => return AccessDecision::DeniedMalformed,
        };
        let context = x402_context(req, epoch);
        let iparams = self.iparams();
        if dark_kvac::verify(&pres, &self.sk, &self.gens, &iparams, &context, revealed_attrs) {
            AccessDecision::Granted {
                nullifier: pres.n.compress().to_bytes(),
            }
        } else {
            AccessDecision::DeniedInvalidProof
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dark_kvac::present::PresentRandomness;
    use dark_kvac::util::{random_scalar, random_scalars};
    use dark_kvac::{attr_scalars, commit_ms, fresh_u, issue, present};
    use curve25519_dalek::scalar::Scalar;

    fn make_req(resource: &str) -> X402PaymentRequirement {
        X402PaymentRequirement {
            scheme: "exact".into(),
            network: "solana-devnet".into(),
            asset: "SOL".into(),
            amount_lamports: 1_000_000,
            pay_to: [0xAA; 32],
            resource: resource.into(),
            expires_at_slot: u64::MAX,
            nonce: [1, 2, 3, 4, 5, 6, 7, 8],
            facilitator_url: None,
        }
    }

    #[test]
    fn context_is_resource_and_epoch_specific() {
        let r1 = make_req("https://gw/infer");
        let r2 = make_req("https://gw/train");
        assert_ne!(x402_context(&r1, 1), x402_context(&r2, 1), "resource binds");
        assert_ne!(x402_context(&r1, 1), x402_context(&r1, 2), "epoch binds");
        assert_eq!(x402_context(&r1, 1), x402_context(&r1, 1), "deterministic");
    }

    #[test]
    fn gate_grants_valid_and_rate_limit_nullifier_is_stable() {
        let gate = KvacGate::new(IssuerSecretKey::random());
        let gens = gate.generators().clone();
        let iparams = gate.iparams();

        // issue a credential
        let ms = random_scalar();
        let (m3, _pok) = commit_ms(&gens, &ms, random_scalar());
        let (cred, _ip) = issue(
            gate.secret_key(),
            &gens,
            &iparams,
            Scalar::from(2u64),
            Scalar::from(1_000_000u64),
            m3,
            random_scalar(),
            fresh_u(b"u"),
            random_scalars::<7>(),
        );
        let attrs = attr_scalars(2, 1_000_000, ms);

        let req = make_req("https://gw/infer");
        let ctx = x402_context(&req, 7);

        // two independent shows for the SAME (resource, epoch)
        let p1 = present(&cred, &attrs, &gens, &iparams, &ctx, &[], &PresentRandomness::random());
        let p2 = present(&cred, &attrs, &gens, &iparams, &ctx, &[], &PresentRandomness::random());

        let d1 = gate.verify_access(&p1.to_bytes(), &req, 7, &[]);
        let d2 = gate.verify_access(&p2.to_bytes(), &req, 7, &[]);

        // wire bytes differ (unlinkable) ...
        assert_ne!(p1.to_bytes(), p2.to_bytes());
        // ... but both grant the SAME nullifier ⇒ the rate-limit catches the second.
        match (d1, d2) {
            (AccessDecision::Granted { nullifier: n1 }, AccessDecision::Granted { nullifier: n2 }) => {
                assert_eq!(n1, n2, "same (agent,resource,epoch) ⇒ same nullifier");
            }
            other => panic!("expected two grants, got {:?}", other),
        }

        // new epoch ⇒ different nullifier ⇒ allowed
        let p3 = present(&cred, &attrs, &gens, &iparams, &x402_context(&req, 8), &[], &PresentRandomness::random());
        if let AccessDecision::Granted { nullifier: n3 } = gate.verify_access(&p3.to_bytes(), &req, 8, &[]) {
            let n1 = match gate.verify_access(&p1.to_bytes(), &req, 7, &[]) {
                AccessDecision::Granted { nullifier } => nullifier,
                _ => unreachable!(),
            };
            assert_ne!(n1, n3);
        } else {
            panic!("new epoch must grant");
        }
    }

    #[test]
    fn gate_denies_malformed_and_forged() {
        let gate = KvacGate::new(IssuerSecretKey::random());
        let req = make_req("https://gw/infer");
        // malformed
        assert_eq!(gate.verify_access(&[0u8; 10], &req, 1, &[]), AccessDecision::DeniedMalformed);

        // forged: a syntactically valid but bogus presentation (wrong issuer)
        let gens = gate.generators().clone();
        let other = IssuerSecretKey::random();
        let oip = other.iparams(&gens);
        let ms = random_scalar();
        let (m3, _) = commit_ms(&gens, &ms, random_scalar());
        let (cred, _) = issue(&other, &gens, &oip, Scalar::from(2u64), Scalar::from(9u64), m3, random_scalar(), fresh_u(b"u"), random_scalars::<7>());
        let attrs = attr_scalars(2, 9, ms);
        let ctx = x402_context(&req, 1);
        let p = present(&cred, &attrs, &gens, &oip, &ctx, &[], &PresentRandomness::random());
        // verified by THIS gate (different sk) ⇒ invalid
        assert_eq!(gate.verify_access(&p.to_bytes(), &req, 1, &[]), AccessDecision::DeniedInvalidProof);
    }
}
