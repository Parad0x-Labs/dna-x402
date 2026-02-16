import React, { useMemo } from 'react';
import {
  aggregateByCapability,
  aggregateBySeller,
  projectedDailySpendAtomic,
  spendLedgerToCsv,
  SpendLedgerEntry,
} from '../lib/ledger';

interface SpendLedgerProps {
  entries: SpendLedgerEntry[];
  dailyBudgetAtomic?: string;
}

const USDC_DECIMALS = 6;

function atomicToUi(amountAtomic: string, decimals = USDC_DECIMALS): number {
  return Number(amountAtomic) / 10 ** decimals;
}

function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    return 0n;
  }
  return BigInt(value);
}

function short(value: string): string {
  if (!value) {
    return '-';
  }
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function downloadCsv(csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `dnp-spend-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const SpendLedger: React.FC<SpendLedgerProps> = ({ entries, dailyBudgetAtomic }) => {
  const byCapability = useMemo(() => aggregateByCapability(entries).slice(0, 8), [entries]);
  const bySeller = useMemo(() => aggregateBySeller(entries).slice(0, 8), [entries]);
  const projectedAtomic = useMemo(() => projectedDailySpendAtomic(entries), [entries]);
  const projected = parseAtomic(projectedAtomic);
  const dailyBudget = parseAtomic(dailyBudgetAtomic ?? '0');
  const isOverBudget = dailyBudget > 0n && projected > dailyBudget;
  const recent = useMemo(() => [...entries].reverse().slice(0, 100), [entries]);

  return (
    <div className="spend-ledger">
      <div className="button-row">
        <button className="panel-button secondary" onClick={() => downloadCsv(spendLedgerToCsv(entries))}>
          Export CSV
        </button>
      </div>

      <div className="metric-row">
        <span>Projected 24h spend</span>
        <strong>{atomicToUi(projectedAtomic).toFixed(6)} USDC</strong>
      </div>
      {dailyBudget > 0n ? (
        <div className="metric-row">
          <span>Daily budget</span>
          <strong>{atomicToUi(dailyBudget.toString(10)).toFixed(6)} USDC</strong>
        </div>
      ) : null}
      {isOverBudget ? (
        <div className="panel-error">
          Projected spend exceeds daily cap. Consider lower max price, stream mode, or limit orders.
        </div>
      ) : null}

      <div className="market-grid">
        <div className="market-card">
          <h4>Spend By Capability</h4>
          {byCapability.map((row) => (
            <div className="metric-row" key={`cap-${row.key}`}>
              <span>{row.key}</span>
              <strong>{atomicToUi(row.totalAtomic).toFixed(6)} USDC ({row.count})</strong>
            </div>
          ))}
          {byCapability.length === 0 ? <p className="panel-note">No spend rows yet.</p> : null}
        </div>

        <div className="market-card">
          <h4>Spend By Seller</h4>
          {bySeller.map((row) => (
            <div className="metric-row" key={`seller-${row.key}`}>
              <span>{row.key}</span>
              <strong>{atomicToUi(row.totalAtomic).toFixed(6)} USDC ({row.count})</strong>
            </div>
          ))}
          {bySeller.length === 0 ? <p className="panel-note">No spend rows yet.</p> : null}
        </div>
      </div>

      <div className="quote-list">
        <h4>Last 100 Receipts</h4>
        {recent.map((row, idx) => (
          <div className="quote-row" key={`${row.ts}-${row.receiptId ?? idx}`}>
            <div>
              <strong>{row.shopId}</strong>
              <div className="panel-note">{row.endpointId} · {row.capability}</div>
            </div>
            <div className="quote-metrics">
              <span>{atomicToUi(row.amountAtomic).toFixed(6)} USDC</span>
              <span>{row.mode}</span>
              <span>{new Date(row.ts).toLocaleString()}</span>
            </div>
            <code>{short(row.receiptId ?? '-')}</code>
          </div>
        ))}
        {recent.length === 0 ? <p className="panel-note">No receipts logged yet.</p> : null}
      </div>
    </div>
  );
};

