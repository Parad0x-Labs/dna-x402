import React from "react";
import { Link, useParams } from "react-router-dom";
import proof from "../data/polymarketProof.json";

function cleanSlug(value: string | undefined): string {
  return String(value ?? "prediction-alpha")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "prediction-alpha";
}

const statRows = [
  ["Win rate", proof.accountingModel.example.winRate],
  ["Average entry", proof.accountingModel.example.averageEntryPrice],
  ["Average exit", proof.accountingModel.example.averageExitPrice],
  ["24h PnL", proof.accountingModel.example.realizedPnl24h],
  ["7d PnL", proof.accountingModel.example.realizedPnl7d],
  ["30d PnL", proof.accountingModel.example.realizedPnl30d],
  ["All-time PnL", proof.accountingModel.example.realizedPnlAllTime],
  ["Closed lots", String(proof.accountingModel.example.closedLots)],
];

export const PolymarketAlphaProfile: React.FC = () => {
  const params = useParams();
  const slug = cleanSlug(params.slug);

  return (
    <section className="polymarket-workbench">
      <div className="panel workbench-hero">
        <div>
          <h2>/alpha/{slug}</h2>
          <p className="lead">Public alpha profile preview with proof-first PnL and copied-lot accounting.</p>
        </div>
        <Link className="link-btn" to="/polymarket">Agent Workbench</Link>
      </div>

      <div className="dashboard-grid">
        <article className="panel timeline-panel">
          <h3>Performance</h3>
          <div className="metric-grid">
            {statRows.map(([label, value]) => (
              <div className="proof-block" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <h3>Fee model</h3>
          <ul className="compact-list">
            <li>Alpha success fee: {proof.accountingModel.successFeeFormula}</li>
            <li>Builder fee: 0 bps at launch.</li>
            <li>DNA notional fee: off in V1.</li>
            <li>Manual non-copied trades do not pay alpha success fees.</li>
          </ul>
        </article>

        <article className="panel">
          <h3>Copy controls</h3>
          <div className="beta-controls">
            <button type="button" className="ghost-btn" disabled>Copy all categories requires live fanout gate</button>
            <button type="button" className="ghost-btn" disabled>Category filters require market sync gate</button>
            <button type="button" className="ghost-btn" disabled>Take-profit / stop-loss requires order submit gate</button>
          </div>
          <p className="muted">Copy trading remains active-session only. No hosted unattended signer exists in V1.</p>
        </article>
      </div>
    </section>
  );
};
