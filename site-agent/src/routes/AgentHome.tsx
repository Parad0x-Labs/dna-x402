import React from 'react';
import { Link } from 'react-router-dom';

export const AgentHome: React.FC = () => (
  <section className="panel">
    <h2>/agent</h2>
    <p className="lead">
      Interactive control room for wallet-native x402 commerce: live 402 pay flow, receipt verification, and anchoring telemetry.
    </p>
    <div className="split-grid">
      <div>
        <h3>What runs here</h3>
        <ul>
          <li>Read-only mode: live health, market, anchoring, latency, error rate.</li>
          <li>Wallet mode: real 402 - pay - retry with tx signatures and receipt checks.</li>
          <li>Proof lane: footprint metrics + audit links + program metadata.</li>
        </ul>
      </div>
      <div>
        <h3>Launch paths</h3>
        <div className="links">
          <Link to="/control-room">Open Control Room</Link>
          <Link to="/proof">Proof Claims</Link>
          <a href="http://localhost:5173" target="_blank" rel="noreferrer">Open Wallet App</a>
        </div>
      </div>
    </div>
  </section>
);
