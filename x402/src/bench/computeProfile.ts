import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";

export interface ComputeProfileEntry {
  flowId: string;
  ok: boolean;
  unitsConsumed: number;
  error?: string;
  logs: string[];
}

function parseError(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export async function profileTransactionCompute(params: {
  connection: Connection;
  flowId: string;
  tx: Transaction | VersionedTransaction;
}): Promise<ComputeProfileEntry> {
  let simulation;
  if (params.tx instanceof VersionedTransaction) {
    simulation = await params.connection.simulateTransaction(params.tx);
  } else {
    simulation = await params.connection.simulateTransaction(params.tx);
  }

  const entry: ComputeProfileEntry = {
    flowId: params.flowId,
    ok: simulation.value.err === null,
    unitsConsumed: simulation.value.unitsConsumed ?? 0,
    error: parseError(simulation.value.err),
    logs: simulation.value.logs ?? [],
  };

  if (!entry.ok) {
    throw new Error(
      `compute_profile_failed flow=${params.flowId} error=${entry.error ?? "unknown"} logs=${entry.logs.join(" | ")}`,
    );
  }

  return entry;
}
