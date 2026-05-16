import React from 'react';
import { useLocation } from 'react-router-dom';

export const Header: React.FC = () => {
  const location = useLocation();
  const isPolymarket = location.pathname.startsWith('/polymarket');
  const isProgrammable = location.pathname.startsWith('/programmable-payments') || location.pathname.startsWith('/marketplace');

  const eyebrow = isPolymarket
    ? 'DNA x402 / Polymarket Agent'
    : isProgrammable
      ? 'DNA x402 / Programmable Payments'
      : 'Dark Null Control Surface';
  const title = isPolymarket
    ? 'Prediction Agent Desk'
    : isProgrammable
      ? 'Universal Agent Commerce Rail'
      : 'Live Agent Commerce Control Room';
  const copy = isPolymarket
    ? 'Phantom-funded agents with pUSD accounting, local signing, risk limits, alpha profiles, and copy controls.'
    : isProgrammable
      ? 'Create, discover, quote, pay, fulfill, and verify services across humans, agents, APIs, compute, auctions, streams, and bundles.'
      : 'Monitor and execute real 402 - pay - retry flows with wallet signatures, receipt verification, and anchoring telemetry.';

  return (
    <header className="hero">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{copy}</p>
    </header>
  );
};
