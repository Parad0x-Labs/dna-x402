import React from 'react';

interface ProofBlockProps {
  label: string;
  value: string;
  detail?: string;
}

export const ProofBlock: React.FC<ProofBlockProps> = ({ label, value, detail }) => (
  <div className="proof-block">
    <span>{label}</span>
    <strong>{value}</strong>
    {detail ? <small>{detail}</small> : null}
  </div>
);
