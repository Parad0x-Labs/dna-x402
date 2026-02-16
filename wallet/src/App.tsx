import React, { useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider, useConnection } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { KeypairWalletAdapter } from './utils/KeypairWalletAdapter';
import { SeedPhraseWalletAdapter } from './utils/SeedPhraseWalletAdapter';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { PDXWallet } from './components/PDXWallet';
import { TermsModal } from './components/TermsModal';
import { SafetyBanner } from './components/SafetyBanner';
import { AutonomousStatus } from './components/AutonomousStatus';
import { ProtocolCanary } from './components/ProtocolCanary';
import { SessionManager } from './utils/sessionManager';
import './App.css';

require('@solana/wallet-adapter-react-ui/styles.css');

// Inner App Component (with wallet context)
const AppContent: React.FC = () => {
  const { connection } = useConnection();
  const [showTerms, setShowTerms] = useState(false);

  useEffect(() => {
    // Check if terms were previously accepted
    const accepted = SessionManager.checkTermsAccepted();
    if (accepted) {
      SessionManager.startSession();
    } else {
      setShowTerms(true);
    }

    // Check for forced disconnection every 30 seconds
    const checkInterval = setInterval(() => {
      if (SessionManager.shouldForceDisconnect()) {
        SessionManager.forceDisconnect();
      }
    }, 30000);

    return () => clearInterval(checkInterval);
  }, []);

  const handleTermsAccept = () => {
    setShowTerms(false);
    SessionManager.startSession();
  };

  const handleTermsDecline = () => {
    // Close the entire application
    window.close();
    // Fallback for browsers that don't support window.close()
    window.location.href = 'about:blank';
  };

  if (showTerms) {
    return <TermsModal onAccept={handleTermsAccept} onDecline={handleTermsDecline} />;
  }

  return (
    <div className="App">
      {/* Security Banner - Always Visible */}
      <SafetyBanner mode="standard" />

      <header className="App-header">
        <div className="header-content">
          <div className="title-section">
            <h1>🔀 PDX Privacy Relay</h1>
            <p>Experimental Privacy Transfer Tool - Not a Full Wallet</p>
          </div>

          {/* AUTONOMY STATUS - Always Visible */}
          <div className="autonomy-section">
            <AutonomousStatus connection={connection} />
          </div>
        </div>

              <div className="wallet-button-container">
                <WalletMultiButton />
                <div className="wallet-options">
                  <div className="wallet-notice">
                    🦊 Browser wallets: Phantom, Solflare
                  </div>
                  <div className="wallet-notice">
                    🔑 Import options: Private key or Seed phrase
                  </div>
                  <div className="wallet-notice">
                    Compatible with all standard Solana wallets
                  </div>
                </div>
              </div>
      </header>

      <main>
        <PDXWallet />
      </main>

      {/* Footer Safety Notice */}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-warning">
            ⚠️ <strong>Experimental Tool:</strong> Use only for single transfers. Complete your transaction and disconnect immediately.
          </div>
          <div className="footer-links">
            <a href="#terms" onClick={() => setShowTerms(true)}>Terms of Use</a>
            <span>•</span>
            <a href="#security">Security Notice</a>
            <span>•</span>
            <a href="#disclaimer">Not a Wallet</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Main App Component with Canary System
function App() {
  const network = WalletAdapterNetwork.Devnet; // Change to Mainnet for production
  const endpoint = clusterApiUrl(network);

  const wallets = [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new KeypairWalletAdapter(network),
    new SeedPhraseWalletAdapter(network),
  ];

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ProtocolCanary>
            <AppContent />
          </ProtocolCanary>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;
