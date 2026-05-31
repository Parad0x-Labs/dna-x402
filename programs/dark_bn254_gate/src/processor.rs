use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, msg, pubkey::Pubkey};

use dark_groth16_core::{
    g1_from_bytes, g2_from_bytes, groth16_verify,
    null_proof_vk::{null_proof_vk, NR_PUBLIC_INPUTS},
    Groth16Proof,
};

use crate::error::GateError;

/// Instruction data layout — NullProofV2 circuit, 8 public inputs:
///   proof[256]              — BN254 Groth16 proof (A:64 B:128 C:64)
///   commitment[32]          — Poseidon(secret, leaf_index)      [see note below]
///   nullifier[32]           — Poseidon(secret, pool_key_field)  [see note below]
///
/// HASH SCHEME NOTE — MiMC k=0 cross-function collision vulnerability (blocks deployment):
///
///   This file previously described commitment and nullifier as MiMCSponge(…).
///   The actual on-chain circuit (circuits/shielded_withdraw.circom) uses Poseidon(2)
///   for BOTH functions. This comment corrects that mismatch.
///
///   IF MiMCSponge with k=0 were used for both roles, a critical collision would
///   exist: MiMCSponge(x, y, k=0) is a single parameterisation. When the same
///   function and domain key (k=0) compute both commitment and nullifier, an attacker
///   who knows the input to the commitment can trivially construct a nullifier that
///   hashes to the same value. That means:
///     - The nullifier for note A can equal the commitment for note B if the inputs align.
///     - A single ZK proof could be replayed to spend two different notes.
///     - Double-spend via nullifier reuse becomes possible without knowledge of the secret.
///
///   The Poseidon(2) circuit avoids this by using structurally different input orderings
///   (leaf_index vs pool_key_field as the second input), but the two hashes still share
///   the same Poseidon function with no domain separator. This is marginal safety —
///   the correct fix (circuit update required, off-chain Circom change) is to add an
///   explicit domain tag as a third input:
///     commitment = Poseidon(1, secret, leaf_index)     // domain=1
///     nullifier  = Poseidon(2, secret, pool_key_field) // domain=2
///
///   This change CANNOT be made in Rust alone. It requires updating
///   circuits/shielded_withdraw.circom, re-running the trusted setup, and
///   regenerating the verifying key. It blocks VK_FINAL from flipping to true.
///   root[32]                — Merkle root of the commitment tree
///   amount[32]              — u64 le, zero-padded (payment amount)
///   receiver_token_part0[32] — first half of receiver token address (field element)
///   receiver_token_part1[32] — second half of receiver token address
///   mint_part0[32]          — first half of mint address (field element)
///   mint_part1[32]          — second half of mint address
///
/// Total: 256 + 8×32 = 512 bytes.
///
/// Public inputs are the 8 field elements after the proof, in the order above.
/// Each is a 32-byte big-endian BN254 Fr scalar — matching the circuit's `main { public [...] }`.
pub const INSTRUCTION_DATA_LEN: usize = 512;

/// Public input byte offsets within the instruction data.
pub const OFF_PROOF:              usize = 0;
pub const OFF_COMMITMENT:         usize = 256;
pub const OFF_NULLIFIER:          usize = 288;
pub const OFF_ROOT:               usize = 320;
pub const OFF_AMOUNT:             usize = 352;
pub const OFF_RECEIVER_TOKEN_0:   usize = 384;
pub const OFF_RECEIVER_TOKEN_1:   usize = 416;
pub const OFF_MINT_0:             usize = 448;
pub const OFF_MINT_1:             usize = 480;

/// Format a [u8;32] as hex for msg! logging (no alloc).
fn hex32(bytes: &[u8; 32]) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2]     = HEX[(b >> 4) as usize];
        out[i * 2 + 1] = HEX[(b & 0x0f) as usize];
    }
    out
}

fn parse32(data: &[u8], off: usize) -> Result<[u8; 32], GateError> {
    data[off..off + 32].try_into().map_err(|_| GateError::InvalidInstructionLength)
}

/// Main program entrypoint.
pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts:   &[AccountInfo],
    data:        &[u8],
) -> ProgramResult {
    // ── 1. Length check ───────────────────────────────────────────────────────
    if data.len() != INSTRUCTION_DATA_LEN {
        return Err(GateError::InvalidInstructionLength.into());
    }

    // ── 2. Parse proof + 8 public inputs ─────────────────────────────────────
    let proof_bytes: &[u8; 256] = data[OFF_PROOF..OFF_PROOF + 256]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;

    let commitment        = parse32(data, OFF_COMMITMENT)?;
    let nullifier         = parse32(data, OFF_NULLIFIER)?;
    let root              = parse32(data, OFF_ROOT)?;
    let amount_bytes      = parse32(data, OFF_AMOUNT)?;
    let receiver_token_0  = parse32(data, OFF_RECEIVER_TOKEN_0)?;
    let receiver_token_1  = parse32(data, OFF_RECEIVER_TOKEN_1)?;
    let mint_0            = parse32(data, OFF_MINT_0)?;
    let mint_1            = parse32(data, OFF_MINT_1)?;

    let amount = u64::from_le_bytes(
        amount_bytes[0..8]
            .try_into()
            .map_err(|_| GateError::InvalidAmountEncoding)?,
    );

    // Public inputs in circuit order (matches NullProofV2 public signal order):
    //   commitment, nullifier, root, amount, receiver_token_part_0/1, mint_part_0/1
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
        commitment,
        nullifier,
        root,
        amount_bytes,
        receiver_token_0,
        receiver_token_1,
        mint_0,
        mint_1,
    ];

    // ── 3. Load real VK (null_proof_final.zkey — single-party ceremony) ───────
    let vk = null_proof_vk();

    // Fail closed if somehow called with a non-mainnet_ready VK.
    if !vk.mainnet_ready {
        return Err(GateError::ProofVerificationFailed.into());
    }

    // ── 4. Verify Groth16 proof ───────────────────────────────────────────────
    // groth16_verify: e(A,B)·e(−α,β)·e(−vk_x,γ)·e(−C,δ) = 1
    // where vk_x = IC[0] + Σᵢ(public_inputs[i] · IC[i+1])
    // Uses alt_bn128_pairing syscall (~150–200k CU).
    // Parse proof — groth16_verify handles negation internally
    let proof_a_bytes: [u8; 64]  = proof_bytes[0..64].try_into().unwrap_or([0u8; 64]);
    let proof_b_bytes: [u8; 128] = proof_bytes[64..192].try_into().unwrap_or([0u8; 128]);
    let proof_c_bytes: [u8; 64]  = proof_bytes[192..256].try_into().unwrap_or([0u8; 64]);

    let proof = Groth16Proof {
        a: g1_from_bytes(&proof_a_bytes),
        b: g2_from_bytes(&proof_b_bytes),
        c: g1_from_bytes(&proof_c_bytes),
    };

    let verified = groth16_verify(&vk, &proof, &public_inputs)
        .map_err(|_| GateError::ProofVerificationFailed)?;

    if !verified {
        return Err(GateError::ProofVerificationFailed.into());
    }

    // ── 5. Log success ────────────────────────────────────────────────────────
    let root_hex  = hex32(&root);
    let null_hex  = hex32(&nullifier);
    let root_str  = core::str::from_utf8(&root_hex).unwrap_or("?");
    let null_str  = core::str::from_utf8(&null_hex).unwrap_or("?");
    msg!(
        "dark_bn254_gate: groth16-bn254 proof verified root={} nullifier={} amount={}",
        root_str,
        null_str,
        amount
    );

    Ok(())
}
