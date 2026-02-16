import React, { useState } from 'react';
import './TermsModal.css';

interface TermsModalProps {
  onAccept: () => void;
  onDecline: () => void;
}

export const TermsModal: React.FC<TermsModalProps> = ({ onAccept, onDecline }) => {
  const [accepted, setAccepted] = useState(false);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    // Check if user scrolled to within 50px of bottom
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      setScrolledToBottom(true);
    }
  };

  const handleAccept = () => {
    if (accepted && scrolledToBottom) {
      localStorage.setItem('pdx_terms_accepted', 'true');
      localStorage.setItem('pdx_terms_timestamp', Date.now().toString());
      onAccept();
    }
  };

  return (
    <div className="terms-modal-overlay">
      <div className="terms-modal">
        <div className="terms-header">
          <h1>🛡️ PDX PRIVACY RELAY - TERMS OF USE</h1>
          <div className="warning-banner">
            ⚠️ CRITICAL: Read ALL terms before proceeding
          </div>
        </div>

        <div className="terms-content" onScroll={handleScroll}>
          <div className="terms-section">
            <h2>🚫 WHAT THIS IS NOT</h2>
            <p><strong>This is NOT a full wallet.</strong></p>
            <p><strong>This is NOT for storing funds.</strong></p>
            <p><strong>This is NOT production-ready.</strong></p>
            <p><strong>This is NOT independently audited.</strong></p>
          </div>

          <div className="terms-section">
            <h2>✅ WHAT THIS IS</h2>
            <p><strong>This is an EXPERIMENTAL privacy transfer tool.</strong></p>
            <p><strong>Use ONLY for one-time private transfers of SOL, USDC, or tokens.</strong></p>
            <p><strong>Connect your existing wallet → Toggle privacy → Send → Disconnect.</strong></p>
          </div>

          <div className="terms-section danger">
            <h2>⚠️ CRITICAL WARNINGS</h2>
            <ul>
              <li>❌ <strong>DO NOT keep funds here longer than needed for one transfer</strong></li>
              <li>❌ <strong>DO NOT use this as your main wallet</strong></li>
              <li>❌ <strong>DO NOT store meaningful amounts</strong></li>
              <li>❌ <strong>Complete your transfer and immediately disconnect</strong></li>
              <li>❌ <strong>No recovery if you lose access to this tool</strong></li>
              <li>❌ <strong>Privacy is provided via ZK proofs - operational security is on you</strong></li>
            </ul>
          </div>

          <div className="terms-section">
            <h2>🔒 TECHNICAL LIMITATIONS</h2>
            <ul>
              <li>• Experimental zero-knowledge proof system</li>
              <li>• Nebula compression (49x ratio claimed, unverified)</li>
              <li>• $NULL token burning mechanism</li>
              <li>• Merkle tree privacy system</li>
              <li>• Netting engine for batch processing</li>
            </ul>
            <p><strong>All systems are experimental and unaudited.</strong></p>
          </div>

          <div className="terms-section">
            <h2>💰 COSTS & FEES</h2>
            <ul>
              <li>• Privacy transfers require burning 1 $NULL token</li>
              <li>• Standard Solana network fees apply</li>
              <li>• No additional fees charged by this tool</li>
              <li>• $NULL tokens are permanently burned (deflationary)</li>
            </ul>
          </div>

          <div className="terms-section">
            <h2>🚨 LEGAL & RESPONSIBILITY</h2>
            <ul>
              <li>• You accept FULL responsibility for any loss</li>
              <li>• No warranties, express or implied</li>
              <li>• Use at your own risk</li>
              <li>• You are responsible for compliance with local laws</li>
              <li>• Privacy features do not anonymize IP addresses or network activity</li>
            </ul>
          </div>

          <div className="terms-section">
            <h2>🔄 SESSION MANAGEMENT</h2>
            <p><strong>After each transaction, you will be automatically prompted to disconnect.</strong></p>
            <p>This tool is designed for single-use transfers only.</p>
          </div>

          <div className="terms-acceptance">
            <h2>📝 ACCEPTANCE REQUIRED</h2>
            <p>By checking the box below and proceeding, you acknowledge that you have read, understood, and agree to all terms above.</p>

            <div className="checkbox-container">
              <input
                type="checkbox"
                id="terms-accept"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <label htmlFor="terms-accept">
                I have read and understood all terms. I accept full responsibility for using this experimental tool.
              </label>
            </div>

            {!scrolledToBottom && (
              <div className="scroll-warning">
                ⚠️ Please scroll to the bottom to read all terms
              </div>
            )}
          </div>
        </div>

        <div className="terms-actions">
          <button
            className="decline-button"
            onClick={onDecline}
          >
            ❌ Decline - Exit Tool
          </button>
          <button
            className="accept-button"
            onClick={handleAccept}
            disabled={!accepted || !scrolledToBottom}
          >
            ✅ Accept - Continue to Privacy Relay
          </button>
        </div>
      </div>
    </div>
  );
};
