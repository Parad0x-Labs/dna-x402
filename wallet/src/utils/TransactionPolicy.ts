import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * FINAL "NO SPECTRE SPACE" POLICY ENFORCER
 *
 * Transaction-level strictness for PDX Dark Protocol
 * Eliminates attack surface through exact specification compliance
 */

type TxPolicy = {
  pdxProgramId: PublicKey;
  allowComputeBudget: boolean;
  maxCuLimit: number; // 1_400_000
  maxCuPriceMicroLamports: number; // 50_000
  expectedPdxAccounts: number; // 5
};

// --- ComputeBudget decoders (minimal but strict) ---
function decodeComputeBudgetIx(ix: TransactionInstruction):
  | { kind: "SetComputeUnitLimit"; units: number }
  | { kind: "SetComputeUnitPrice"; microLamports: bigint }
  | { kind: "Other" } {

  const data = ix.data;
  if (data.length === 0) return { kind: "Other" };

  // Current ComputeBudget tags:
  // 0x02: SetComputeUnitLimit(u32)
  // 0x03: SetComputeUnitPrice(u64)
  const tag = data[0];

  if (tag === 0x02 && data.length === 1 + 4) {
    const units = data.readUInt32LE(1);
    return { kind: "SetComputeUnitLimit", units };
  }
  if (tag === 0x03 && data.length === 1 + 8) {
    const microLamports = data.readBigUInt64LE(1);
    return { kind: "SetComputeUnitPrice", microLamports };
  }
  return { kind: "Other" };
}

export function enforceNoSpectreSpace(tx: Transaction, policy: TxPolicy) {
  const allowedPrograms = new Set<string>([
    policy.pdxProgramId.toBase58(),
    SystemProgram.programId.toBase58(),
  ]);
  if (policy.allowComputeBudget) {
    allowedPrograms.add(ComputeBudgetProgram.programId.toBase58());
  }

  // 1) Disallow unknown programs
  for (const ix of tx.instructions) {
    if (!allowedPrograms.has(ix.programId.toBase58())) {
      throw new Error(`Policy reject: disallowed program ${ix.programId.toBase58()}`);
    }
  }

  // 2) Enforce instruction sequence: [0-2 compute] + [1 pdx] only
  const computeIxs = tx.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId));
  const pdxIxs = tx.instructions.filter(ix => ix.programId.equals(policy.pdxProgramId));

  if (!policy.allowComputeBudget && computeIxs.length > 0) {
    throw new Error("Policy reject: ComputeBudget not allowed");
  }
  if (computeIxs.length > 2) {
    throw new Error(`Policy reject: too many ComputeBudget instructions (${computeIxs.length})`);
  }
  if (pdxIxs.length !== 1) {
    throw new Error(`Policy reject: expected exactly 1 PDX instruction, got ${pdxIxs.length}`);
  }
  // Only compute + PDX allowed
  for (const ix of tx.instructions) {
    const ok = ix.programId.equals(policy.pdxProgramId) || ix.programId.equals(ComputeBudgetProgram.programId);
    if (!ok) throw new Error("Policy reject: extra instruction found");
  }
  // PDX must be last
  if (!tx.instructions[tx.instructions.length - 1].programId.equals(policy.pdxProgramId)) {
    throw new Error("Policy reject: PDX instruction must be last");
  }

  // MAX SIMPLICITY: Reject address lookup tables (optional but recommended)
  // This prevents txs that look "clean" but hide complexity in ALT resolution
  if (tx.addressTableLookups && tx.addressTableLookups.length > 0) {
    throw new Error("Policy reject: Address lookup tables not allowed");
  }

  // 3) Clamp/validate compute budget instructions
  for (const ix of computeIxs) {
    const decoded = decodeComputeBudgetIx(ix);
    if (decoded.kind === "Other") {
      throw new Error("Policy reject: unsupported ComputeBudget instruction");
    }
    if (decoded.kind === "SetComputeUnitLimit" && decoded.units > policy.maxCuLimit) {
      throw new Error(`Policy reject: CU limit too high (${decoded.units})`);
    }
    if (decoded.kind === "SetComputeUnitPrice" && decoded.microLamports > BigInt(policy.maxCuPriceMicroLamports)) {
      throw new Error(`Policy reject: CU price too high (${decoded.microLamports.toString()})`);
    }
  }

  // 4) Validate PDX account metas strictly
  const pdxIx = pdxIxs[0];
  if (pdxIx.keys.length !== policy.expectedPdxAccounts) {
    throw new Error(`Policy reject: PDX keys length ${pdxIx.keys.length} != ${policy.expectedPdxAccounts}`);
  }

  const [payer, nullA, nullF, vault, system] = pdxIx.keys;

  if (!payer.isSigner || !payer.isWritable) throw new Error("Policy reject: payer meta invalid");
  if (nullA.isSigner || !nullA.isWritable) throw new Error("Policy reject: nullifier_asset meta invalid");
  if (nullF.isSigner || !nullF.isWritable) throw new Error("Policy reject: nullifier_fee meta invalid");
  if (vault.isSigner || !vault.isWritable) throw new Error("Policy reject: vault meta invalid");
  if (!system.pubkey.equals(SystemProgram.programId) || system.isSigner || system.isWritable) {
    throw new Error("Policy reject: system meta invalid");
  }

  return true;
}

// =============================================================================
// FINAL CONFIGURATION - NO SPECTRE SPACE POLICY
// =============================================================================
// Root registry: DISABLED (accounts = 5, not 6)
// ComputeBudget: ALLOWED with strict clamping (max CU 1.4M, price 50k µ-lamports)
// ABI: Exact 5-account layout for Transfer instruction
// Security: Massive attack surface reduction, whole classes of bugs eliminated
// =============================================================================

export const STRICT_POLICY = {
  pdxProgramId: new PublicKey("11111111111111111111111111111112"), // Replace with your program ID
  allowComputeBudget: true,
  maxCuLimit: 1_400_000,
  maxCuPriceMicroLamports: 50_000,
  expectedPdxAccounts: 5,
};