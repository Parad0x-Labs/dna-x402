import { Transaction, VersionedTransaction } from "@solana/web3.js";

export interface TxMetrics {
  version: "legacy" | "v0";
  serializedTxBytes: number;
  signaturesCount: number;
  accountsCount: number;
  instructionDataBytes: number;
  usesAlt: boolean;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

export function measureLegacyTransaction(tx: Transaction): TxMetrics {
  const serializedTxBytes = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).byteLength;

  const message = tx.compileMessage();

  return {
    version: "legacy",
    serializedTxBytes,
    signaturesCount: message.header.numRequiredSignatures,
    accountsCount: message.accountKeys.length,
    instructionDataBytes: sum(tx.instructions.map((ix) => ix.data.byteLength)),
    usesAlt: false,
  };
}

export function measureV0Transaction(tx: VersionedTransaction): TxMetrics {
  const serializedTxBytes = tx.serialize().byteLength;
  const lookupCount = tx.message.addressTableLookups.reduce(
    (acc, lookup) => acc + lookup.readonlyIndexes.length + lookup.writableIndexes.length,
    0,
  );

  return {
    version: "v0",
    serializedTxBytes,
    signaturesCount: tx.signatures.length,
    accountsCount: tx.message.staticAccountKeys.length + lookupCount,
    instructionDataBytes: sum(tx.message.compiledInstructions.map((ix) => ix.data.length)),
    usesAlt: tx.message.addressTableLookups.length > 0,
  };
}
