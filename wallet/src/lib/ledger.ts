export type LedgerSettlementMode = 'transfer' | 'stream' | 'netting';

export interface SpendLedgerEntry {
  ts: string;
  shopId: string;
  endpointId: string;
  capability: string;
  amountAtomic: string;
  mode: LedgerSettlementMode;
  receiptId?: string;
}

export interface SpendAggregateRow {
  key: string;
  totalAtomic: string;
  count: number;
}

const STORAGE_KEY = 'dnp_spend_ledger_v1';
const MAX_ENTRIES = 5000;

function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid atomic amount: ${value}`);
  }
  return BigInt(value);
}

function tryParseAtomic(value: string): bigint {
  try {
    return parseAtomic(value);
  } catch {
    return 0n;
  }
}

export function readSpendLedger(): SpendLedgerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as SpendLedgerEntry[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry) => entry && typeof entry === 'object')
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function appendSpendLedger(entry: Omit<SpendLedgerEntry, 'ts'> & { ts?: string }): SpendLedgerEntry[] {
  const next: SpendLedgerEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    shopId: entry.shopId,
    endpointId: entry.endpointId,
    capability: entry.capability,
    amountAtomic: entry.amountAtomic,
    mode: entry.mode,
    receiptId: entry.receiptId,
  };

  const updated = [...readSpendLedger(), next].slice(-MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

export function aggregateByCapability(entries: SpendLedgerEntry[]): SpendAggregateRow[] {
  const map = new Map<string, { total: bigint; count: number }>();
  for (const entry of entries) {
    const key = entry.capability || entry.endpointId || 'unknown';
    const prev = map.get(key) ?? { total: 0n, count: 0 };
    map.set(key, {
      total: prev.total + tryParseAtomic(entry.amountAtomic),
      count: prev.count + 1,
    });
  }
  return Array.from(map.entries())
    .map(([key, stats]) => ({
      key,
      totalAtomic: stats.total.toString(10),
      count: stats.count,
    }))
    .sort((a, b) => Number(tryParseAtomic(b.totalAtomic) - tryParseAtomic(a.totalAtomic)));
}

export function aggregateBySeller(entries: SpendLedgerEntry[]): SpendAggregateRow[] {
  const map = new Map<string, { total: bigint; count: number }>();
  for (const entry of entries) {
    const key = entry.shopId || 'unknown';
    const prev = map.get(key) ?? { total: 0n, count: 0 };
    map.set(key, {
      total: prev.total + tryParseAtomic(entry.amountAtomic),
      count: prev.count + 1,
    });
  }
  return Array.from(map.entries())
    .map(([key, stats]) => ({
      key,
      totalAtomic: stats.total.toString(10),
      count: stats.count,
    }))
    .sort((a, b) => Number(tryParseAtomic(b.totalAtomic) - tryParseAtomic(a.totalAtomic)));
}

export function projectedDailySpendAtomic(entries: SpendLedgerEntry[], nowMs = Date.now()): string {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const total = entries
    .filter((entry) => new Date(entry.ts).getTime() >= nowMs - oneDayMs)
    .reduce((sum, entry) => sum + tryParseAtomic(entry.amountAtomic), 0n);
  return total.toString(10);
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function spendLedgerToCsv(entries: SpendLedgerEntry[]): string {
  const header = ['ts', 'shopId', 'endpointId', 'capability', 'amountAtomic', 'mode', 'receiptId'];
  const lines = entries.map((entry) => [
    entry.ts,
    entry.shopId,
    entry.endpointId,
    entry.capability,
    entry.amountAtomic,
    entry.mode,
    entry.receiptId ?? '',
  ].map(csvEscape).join(','));
  return [header.join(','), ...lines].join('\n');
}

