import React, { useState, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { StandardWallet } from './StandardWallet';
import { PrivacyWallet } from './PrivacyWallet';
import { SafetyBanner } from './SafetyBanner';
import { PDXDarkClient } from '../lib/pdx-dark';
import { SessionManager } from '../utils/sessionManager';
import './PDXWallet.css';

// $NULL token mint address (update after deployment)
const NULL_MINT_ADDRESS = new PublicKey('11111111111111111111111111111112'); // Placeholder

export const PDXWallet: React.FC = () => {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number>(0);
  const [nullBalance, setNullBalance] = useState<number>(0);
  const [mode, setMode] = useState<'standard' | 'privacy'>('standard');
  const [loading, setLoading] = useState(false);
  const [showWalletGenerator, setShowWalletGenerator] = useState(false);
  const [generatedWallets, setGeneratedWallets] = useState<Array<{keypair: Keypair, name: string, balance: number}>>([]);
  const [newWalletName, setNewWalletName] = useState('');

  // Update balances when wallet connects
  useEffect(() => {
    if (connected && publicKey) {
      updateBalances();
    }
  }, [connected, publicKey, connection]);

  // Wallet Generation Functions
  const generateNewWallet = () => {
    const keypair = Keypair.generate();
    const name = newWalletName.trim() || `Wallet ${generatedWallets.length + 1}`;
    setGeneratedWallets(prev => [...prev, { keypair, name, balance: 0 }]);
    setNewWalletName('');

    // Auto-export to JSON file
    exportWalletToFile(keypair, name);
  };

  const exportWalletToFile = (keypair: Keypair, name: string) => {
    const walletData = {
      name,
      publicKey: keypair.publicKey.toBase58(),
      secretKey: Array.from(keypair.secretKey),
      created: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(walletData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-zA-Z0-9]/g, '_')}_wallet.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const updateWalletBalances = async () => {
    const updatedWallets = await Promise.all(
      generatedWallets.map(async (wallet) => {
        try {
          const balance = await connection.getBalance(wallet.keypair.publicKey);
          return { ...wallet, balance: balance / LAMPORTS_PER_SOL };
        } catch (error) {
          return { ...wallet, balance: 0 };
        }
      })
    );
    setGeneratedWallets(updatedWallets);
  };

  const updateBalances = async () => {
    if (!publicKey) return;

    try {
      // Get SOL balance
      const solBalance = await connection.getBalance(publicKey);
      setBalance(solBalance / LAMPORTS_PER_SOL);

      // Get $NULL balance
      const ata = await getAssociatedTokenAddress(NULL_MINT_ADDRESS, publicKey);
      try {
        const account = await getAccount(connection, ata);
        setNullBalance(Number(account.amount) / Math.pow(10, 9)); // Assuming 9 decimals
      } catch (error) {
        // No $NULL balance yet
        setNullBalance(0);
      }
    } catch (error) {
      console.error('Error updating balances:', error);
    }
  };

  if (!connected) {
    return (
      <div className="wallet-container">
        <div className="connect-prompt">
          <h2>🔗 Connect Your Wallet</h2>
          <p>Connect Phantom, Solflare, or any Solana wallet to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wallet-container">
      {/* Safety Banner */}
      <SafetyBanner mode={mode} />

      {/* Balance Display */}
      <div className="balance-display">
        <div className="balance-item">
          <span className="balance-label">💰 SOL Balance:</span>
          <span className="balance-value">{balance.toFixed(4)} SOL</span>
        </div>
        <div className="balance-item">
          <span className="balance-label">🔒 $NULL Balance:</span>
          <span className="balance-value">{nullBalance.toFixed(2)} $NULL</span>
        </div>
        {nullBalance < 1 && (
          <div className="warning">
            ⚠️ You need at least 1 $NULL for privacy transactions
          </div>
        )}
      </div>

      {/* Mode Toggle */}
      <div className="mode-toggle">
        <button
          className={mode === 'standard' ? 'active' : ''}
          onClick={() => setMode('standard')}
        >
          📤 Standard Mode
        </button>
        <button
          className={mode === 'privacy' ? 'active' : ''}
          onClick={() => setMode('privacy')}
        >
          🛡️ Privacy Mode
        </button>
        <button
          className={showWalletGenerator ? 'active' : ''}
          onClick={() => setShowWalletGenerator(!showWalletGenerator)}
        >
          🔑 Wallet Manager
        </button>
      </div>

      {/* Wallet Generator */}
      {showWalletGenerator && (
        <div className="wallet-generator">
          <h3>🆕 Generate New Wallet</h3>
          <div className="wallet-input-group">
            <input
              type="text"
              placeholder="Wallet name (optional)"
              value={newWalletName}
              onChange={(e) => setNewWalletName(e.target.value)}
              className="wallet-name-input"
            />
            <button onClick={generateNewWallet} className="generate-btn">
              🎲 Generate New Address
            </button>
          </div>

          {generatedWallets.length > 0 && (
            <div className="generated-wallets">
              <h4>Your Generated Wallets</h4>
              <button onClick={updateWalletBalances} className="refresh-balances-btn">
                🔄 Refresh Balances
              </button>
              {generatedWallets.map((wallet, index) => (
                <div key={index} className="wallet-item">
                  <div className="wallet-info">
                    <strong>{wallet.name}</strong>
                    <div className="wallet-address">
                      {wallet.keypair.publicKey.toBase58()}
                    </div>
                    <div className="wallet-balance">
                      Balance: {wallet.balance.toFixed(4)} SOL
                    </div>
                  </div>
                  <div className="wallet-actions">
                    <button
                      onClick={() => exportWalletToFile(wallet.keypair, wallet.name)}
                      className="export-btn"
                    >
                      💾 Export
                    </button>
                    <button
                      onClick={() => navigator.clipboard.writeText(wallet.keypair.publicKey.toBase58())}
                      className="copy-btn"
                    >
                      📋 Copy Address
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="wallet-import-section">
            <h4>🔑 Import Existing Wallet</h4>
            <p>Use the wallet connection button above to import via:</p>
            <ul>
              <li>• Private Key (64-byte array or base58)</li>
              <li>• BIP39 Seed Phrase (12/24 words)</li>
              <li>• Browser Extensions (Phantom, Solflare)</li>
            </ul>
          </div>
        </div>
      )}

      {/* Privacy Mode Info */}
      {mode === 'privacy' && (
        <div className="privacy-info">
          <h3>🛡️ PDX Dark Protocol - Privacy Mode</h3>
          <div className="privacy-features">
            <div className="feature">
              <span className="feature-icon">🗜️</span>
              <span>Nebula Compression: 49x metadata reduction</span>
            </div>
            <div className="feature">
              <span className="feature-icon">🔐</span>
              <span>ZK Privacy: Zero-knowledge proofs</span>
            </div>
            <div className="feature">
              <span className="feature-icon">🔥</span>
              <span>$NULL Fee: {nullBalance >= 1 ? '1.0 $NULL per transaction' : 'Insufficient $NULL'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Wallet Interface */}
      {mode === 'standard' ? (
        <StandardWallet onBalanceUpdate={updateBalances} />
      ) : (
        <PrivacyWallet
          nullBalance={nullBalance}
          onBalanceUpdate={updateBalances}
          disabled={nullBalance < 1}
        />
      )}

      {/* Loading Overlay */}
      {loading && (
        <div className="loading-overlay">
          <div className="loading-spinner">⏳ Processing...</div>
        </div>
      )}
    </div>
  );
};
