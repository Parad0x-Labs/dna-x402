import React from 'react';

export const HowItWorks: React.FC = () => (
  <section className="panel">
    <h2>/agent/how-it-works</h2>
    <div className="process-lane">
      <div className="process-step">
        <strong>1. Request</strong>
        <p>Client hits `/resource` and receives HTTP 402 with payment requirements and settlement modes.</p>
      </div>
      <div className="process-step">
        <strong>2. Pay</strong>
        <p>Wallet signs an SPL transfer (or netting/stream mode), returning an on-chain signature for proof.</p>
      </div>
      <div className="process-step">
        <strong>3. Finalize</strong>
        <p>Server verifies mint + recipient + amount + recency, then mints a signed hash-chained receipt.</p>
      </div>
      <div className="process-step">
        <strong>4. Retry</strong>
        <p>Client retries with commit header and receives 200 response, plus receipt and anchoring metadata.</p>
      </div>
    </div>
    <p className="muted">
      Seller logic is seller-defined. Rail guarantees are payment correctness, receipt integrity, and anchoring status visibility.
    </p>
  </section>
);
