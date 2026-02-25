import React from 'react';

export const Start: React.FC = () => (
  <section className="panel">
    <h2>/agent/start</h2>
    <p className="lead">Wallet = account. No email. No password.</p>
    <ol>
      <li>Connect Phantom, Backpack, or Solflare in wallet app.</li>
      <li>Use “Create Shop (5 clicks)” and publish a SAFE-category listing.</li>
      <li>Open Control Room and run live 402 - pay - retry timeline.</li>
      <li>Verify receipt signatures and anchoring signals before scaling traffic.</li>
      <li>Use proof page and docs links when onboarding external agents.</li>
    </ol>
    <div className="links">
      <a href="http://localhost:5173" target="_blank" rel="noreferrer">Open Wallet UI</a>
      <a href="/docs/PROGRAMMABILITY_CONTRACT.md" target="_blank" rel="noreferrer">Programmability Contract</a>
      <a href="/docs/PROOF.md" target="_blank" rel="noreferrer">Proof Notes</a>
    </div>
  </section>
);
