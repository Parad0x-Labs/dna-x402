import React from 'react';
import './SafetyBanner.css';

interface SafetyBannerProps {
  mode?: 'standard' | 'privacy';
  className?: string;
}

export const SafetyBanner: React.FC<SafetyBannerProps> = ({
  mode = 'standard',
  className = ''
}) => {
  if (mode === 'privacy') {
    return (
      <div className={`safety-banner privacy-mode ${className}`}>
        <div className="banner-icon">🛡️</div>
        <div className="banner-content">
          <div className="banner-title">PRIVACY TRANSFER MODE ACTIVE</div>
          <div className="banner-subtitle">
            This tool is for one-time private sends only.
            Do not store funds here. Transfer and disconnect.
          </div>
          <div className="banner-tags">
            <span className="tag experimental">Experimental</span>
            <span className="tag unaudited">Not Audited</span>
            <span className="tag risk">Use at Own Risk</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`safety-banner standard-mode ${className}`}>
      <div className="banner-icon">⚠️</div>
      <div className="banner-content">
        <div className="banner-title">PDX PRIVACY RELAY</div>
        <div className="banner-subtitle">
          Experimental privacy transfer tool. Not a full wallet.
          Use only for single transfers, then disconnect.
        </div>
        <div className="banner-tags">
          <span className="tag transfer-only">Transfer Tool Only</span>
          <span className="tag experimental">Experimental</span>
        </div>
      </div>
    </div>
  );
};
