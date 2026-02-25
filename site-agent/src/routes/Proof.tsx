import React from 'react';
import { ProofBlock } from '../components/ProofBlock';
import proof from '../data/proof.json';
import { AgentApiClient } from '../lib/api';
import { usePolling } from '../lib/polling';
import { loadRuntimeConfig } from '../lib/runtimeConfig';

export const Proof: React.FC = () => {
  const config = loadRuntimeConfig();
  const api = new AgentApiClient(config.x402BaseUrl);
  const health = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.health(),
  });

  return (
    <section className="panel">
      <h2>/agent/proof</h2>
      <p className="lead">Engineering claim page: footprint, compute, verification semantics, and live chain metadata.</p>
      <div className="proof-grid">
        <ProofBlock label="Single tx bytes" value={String(proof.txBytesSingle)} detail="AnchorV1 settlement path" />
        <ProofBlock label="Instruction bytes" value={String(proof.ixBytes)} detail="Packed anchor payload" />
        <ProofBlock label="Batch 32 tx bytes" value={String(proof.batch32TxBytes)} detail="Under 1232-byte cap" />
        <ProofBlock label="Single CU" value={String(proof.cuSingle)} detail="Successful simulation" />
        <ProofBlock label="Batch 32 CU" value={String(proof.cuBatch32)} detail="Successful simulation" />
        <ProofBlock label="Verified semantics" value={String(proof.verifiedDefinition)} detail="Anchored + fulfilled + signed receipt" />
      </div>

      <div className="proof-grid two-col">
        <ProofBlock label="Last audit timestamp" value={health.lastUpdatedAt ?? "n/a"} />
        <ProofBlock label="Build commit" value={health.data?.build?.commit ?? "no-commit"} />
        <ProofBlock label="Payment program" value={health.data?.programs?.paymentProgramId ?? "n/a"} />
        <ProofBlock label="Receipt anchor program" value={health.data?.programs?.receiptAnchorProgramId ?? health.data?.anchoring?.programId ?? "n/a"} />
      </div>

      <div className="links">
        <a href="/docs/FOOTPRINT.md" target="_blank" rel="noreferrer">FOOTPRINT.md</a>
        <a href="/docs/PROGRAMMABILITY_READINESS_REPORT.md" target="_blank" rel="noreferrer">Programmability Report</a>
        <a href="/docs/PROOF.md" target="_blank" rel="noreferrer">Proof bundle notes</a>
        <a href={`${config.x402BaseUrl}/health`} target="_blank" rel="noreferrer">Live /health</a>
      </div>
    </section>
  );
};
