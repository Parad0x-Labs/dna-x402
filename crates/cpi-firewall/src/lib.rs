use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single allowed CPI target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedCpi {
    pub program_id_hash: [u8; 32],
    pub max_count: u8,
    pub allowed_receiver_hash: Option<[u8; 32]>,
    pub allowed_mint_hash: Option<[u8; 32]>,
}

/// A program's CPI manifest: what CPIs it declares it will make.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpiManifest {
    pub declaring_program_hash: [u8; 32],
    pub allowed_cpis: Vec<AllowedCpi>,
    pub forbidden_program_hashes: Vec<[u8; 32]>,
    pub effect_hash: [u8; 32],
    pub max_total_cpi_depth: u8,
}

/// Policy applied to a program's CPI manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CpiPolicy {
    NoCpiAllowed,
    AllowedOnly(Vec<AllowedCpi>),
    AllowedWithManifest { manifest_hash: [u8; 32] },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CpiViolation {
    ForbiddenProgram { program_id_hash: [u8; 32] },
    MissingManifest,
    ManifestHashMismatch { expected: [u8; 32], found: [u8; 32] },
    CpiNotAllowed,
    ForbiddenTokenTransfer { receiver_hash: [u8; 32] },
    UnauthorizedCpiTarget { program_id_hash: [u8; 32] },
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// SHA256("dark_null_v1_cpi_manifest" || declaring_program_hash || effect_hash ||
///         max_total_cpi_depth_byte || forbidden_hash_0 || ... || allowed_hash_0 || ...)
pub fn manifest_hash(manifest: &CpiManifest) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark_null_v1_cpi_manifest");
    h.update(&manifest.declaring_program_hash);
    h.update(&manifest.effect_hash);
    h.update(&[manifest.max_total_cpi_depth]);
    for fh in &manifest.forbidden_program_hashes {
        h.update(fh);
    }
    for cpi in &manifest.allowed_cpis {
        h.update(&cpi.program_id_hash);
    }
    h.finalize().into()
}

/// Validate a manifest against a policy.
pub fn validate_cpi_manifest(
    manifest: &CpiManifest,
    policy: &CpiPolicy,
) -> Result<(), CpiViolation> {
    // In all cases: check that no forbidden program appears in allowed_cpis
    for forbidden in &manifest.forbidden_program_hashes {
        for cpi in &manifest.allowed_cpis {
            if cpi.program_id_hash == *forbidden {
                return Err(CpiViolation::ForbiddenProgram {
                    program_id_hash: *forbidden,
                });
            }
        }
    }

    match policy {
        CpiPolicy::NoCpiAllowed => {
            if !manifest.allowed_cpis.is_empty() || manifest.max_total_cpi_depth > 0 {
                return Err(CpiViolation::CpiNotAllowed);
            }
        }
        CpiPolicy::AllowedOnly(allowed) => {
            for cpi in &manifest.allowed_cpis {
                let found = allowed
                    .iter()
                    .any(|a| a.program_id_hash == cpi.program_id_hash);
                if !found {
                    return Err(CpiViolation::UnauthorizedCpiTarget {
                        program_id_hash: cpi.program_id_hash,
                    });
                }
            }
        }
        CpiPolicy::AllowedWithManifest {
            manifest_hash: expected_hash,
        } => {
            let found_hash = manifest_hash(manifest);
            if found_hash != *expected_hash {
                return Err(CpiViolation::ManifestHashMismatch {
                    expected: *expected_hash,
                    found: found_hash,
                });
            }
        }
    }

    Ok(())
}

/// Bind a manifest hash to a ritual hash.
/// SHA256("dark_null_v1_cpi_bind" || manifest_hash_bytes || ritual_hash_bytes)
pub fn bind_manifest_to_ritual(manifest_hash: &[u8; 32], ritual_hash: &[u8; 32]) -> [u8; 32] {
    sha256_domain(b"dark_null_v1_cpi_bind", &[manifest_hash, ritual_hash])
}

/// Validate that a token transfer CPI targets the correct receiver and mint.
pub fn validate_token_transfer(
    manifest: &CpiManifest,
    actual_receiver_hash: &[u8; 32],
    actual_mint_hash: &[u8; 32],
) -> Result<(), CpiViolation> {
    for cpi in &manifest.allowed_cpis {
        if cpi.allowed_receiver_hash.is_some() || cpi.allowed_mint_hash.is_some() {
            if let Some(ref expected_receiver) = cpi.allowed_receiver_hash {
                if actual_receiver_hash != expected_receiver {
                    return Err(CpiViolation::ForbiddenTokenTransfer {
                        receiver_hash: *actual_receiver_hash,
                    });
                }
            }
            if let Some(ref expected_mint) = cpi.allowed_mint_hash {
                if actual_mint_hash != expected_mint {
                    return Err(CpiViolation::ForbiddenTokenTransfer {
                        receiver_hash: *actual_receiver_hash,
                    });
                }
            }
            return Ok(());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_hash(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    #[test]
    fn test_forbidden_cpi_program_rejected() {
        let program_hash_x = make_hash(0xAB);

        let manifest = CpiManifest {
            declaring_program_hash: make_hash(0x01),
            allowed_cpis: vec![AllowedCpi {
                program_id_hash: program_hash_x,
                max_count: 1,
                allowed_receiver_hash: None,
                allowed_mint_hash: None,
            }],
            forbidden_program_hashes: vec![program_hash_x],
            effect_hash: make_hash(0x02),
            max_total_cpi_depth: 1,
        };

        let policy = CpiPolicy::AllowedOnly(vec![AllowedCpi {
            program_id_hash: program_hash_x,
            max_count: 1,
            allowed_receiver_hash: None,
            allowed_mint_hash: None,
        }]);

        let result = validate_cpi_manifest(&manifest, &policy);
        assert_eq!(
            result,
            Err(CpiViolation::ForbiddenProgram {
                program_id_hash: program_hash_x
            })
        );
    }

    #[test]
    fn test_no_cpi_policy_blocks_cpis() {
        let manifest = CpiManifest {
            declaring_program_hash: make_hash(0x01),
            allowed_cpis: vec![AllowedCpi {
                program_id_hash: make_hash(0x10),
                max_count: 1,
                allowed_receiver_hash: None,
                allowed_mint_hash: None,
            }],
            forbidden_program_hashes: vec![],
            effect_hash: make_hash(0x02),
            max_total_cpi_depth: 1,
        };

        let result = validate_cpi_manifest(&manifest, &CpiPolicy::NoCpiAllowed);
        assert_eq!(result, Err(CpiViolation::CpiNotAllowed));
    }

    #[test]
    fn test_manifest_hash_binds_ritual() {
        let m1 = CpiManifest {
            declaring_program_hash: make_hash(0x01),
            allowed_cpis: vec![],
            forbidden_program_hashes: vec![],
            effect_hash: make_hash(0x10),
            max_total_cpi_depth: 0,
        };
        let m2 = CpiManifest {
            declaring_program_hash: make_hash(0x01),
            allowed_cpis: vec![],
            forbidden_program_hashes: vec![],
            effect_hash: make_hash(0x20), // different effect_hash
            max_total_cpi_depth: 0,
        };

        let h1 = manifest_hash(&m1);
        let h2 = manifest_hash(&m2);
        assert_ne!(h1, h2);

        let ritual_hash_a = make_hash(0xAA);
        let ritual_hash_b = make_hash(0xBB);

        // Deterministic
        assert_eq!(
            bind_manifest_to_ritual(&h1, &ritual_hash_a),
            bind_manifest_to_ritual(&h1, &ritual_hash_a)
        );

        // Differs when ritual_hash differs
        assert_ne!(
            bind_manifest_to_ritual(&h1, &ritual_hash_a),
            bind_manifest_to_ritual(&h1, &ritual_hash_b)
        );
    }

    #[test]
    fn test_token_transfer_wrong_receiver_rejected() {
        let manifest = CpiManifest {
            declaring_program_hash: make_hash(0x01),
            allowed_cpis: vec![AllowedCpi {
                program_id_hash: make_hash(0x10),
                max_count: 1,
                allowed_receiver_hash: Some([0x01u8; 32]),
                allowed_mint_hash: Some([0x02u8; 32]),
            }],
            forbidden_program_hashes: vec![],
            effect_hash: make_hash(0x02),
            max_total_cpi_depth: 1,
        };

        let actual_receiver = [0xFFu8; 32];
        let actual_mint = [0x02u8; 32];

        let result = validate_token_transfer(&manifest, &actual_receiver, &actual_mint);
        assert_eq!(
            result,
            Err(CpiViolation::ForbiddenTokenTransfer {
                receiver_hash: [0xFFu8; 32]
            })
        );
    }
}
