import fs from "node:fs";
import path from "node:path";
import { DnaGuardLedger, DnaGuardLedgerOptions, DnaGuardLedgerSnapshot } from "./engine.js";

export interface DnaGuardFileStoreOptions extends DnaGuardLedgerOptions {
  snapshotPath?: string;
  now?: () => Date;
}

export function loadDnaGuardSnapshot(snapshotPath: string): DnaGuardLedgerSnapshot | undefined {
  if (!fs.existsSync(snapshotPath)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as DnaGuardLedgerSnapshot;
    if (parsed && parsed.version === 1) {
      return parsed;
    }
  } catch {
    // Ignore malformed snapshots to keep boot resilient.
  }
  return undefined;
}

export function persistDnaGuardSnapshot(snapshotPath: string, snapshot: DnaGuardLedgerSnapshot): void {
  const dir = path.dirname(snapshotPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
}

export function createFileBackedDnaGuardLedger(options: DnaGuardFileStoreOptions = {}): DnaGuardLedger {
  const now = options.now ?? (() => new Date());
  const snapshot = options.snapshotPath ? loadDnaGuardSnapshot(options.snapshotPath) : undefined;
  const ledger = new DnaGuardLedger({
    windowMs: snapshot?.windowMs ?? options.windowMs,
    onChange: options.snapshotPath
      ? (nextSnapshot) => persistDnaGuardSnapshot(options.snapshotPath as string, nextSnapshot)
      : options.onChange,
  });
  if (snapshot) {
    ledger.restore(snapshot, now());
  }
  return ledger;
}
