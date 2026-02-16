import React, { useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createTransferInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { TransactionGuard } from '../utils/TransactionGuard';
import { SolanaAddressValidator } from '../utils/SolanaAddressValidator';
import { useAutonomyCheck } from '../hooks/useAutonomyCheck';
import { AutonomyDashboard } from './AutonomyDashboard';
import { PDX_PROGRAM_ID, NULL_TOKEN_MINT } from '../constants/protocol';
import './StandardWallet.css';

interface StandardWalletProps {
  onBalanceUpdate: () => void;
}

export const StandardWallet: React.FC<StandardWalletProps> = ({ onBalanceUpdate }) => {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const autonomyStatus = useAutonomyCheck(connection, PDX_PROGRAM_ID, NULL_TOKEN_MINT);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [tokenType, setTokenType] = useState<'SOL' | 'USDC'>('SOL');
  const [loading, setLoading] = useState(false);
  const [recipientValidation, setRecipientValidation] = useState<any>(null);
  const [isValidatingAddress, setIsValidatingAddress] = useState(false);

  // USDC mint address (Devnet)
  const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

  const handleRecipientChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setRecipient(newVal);

    if (!newVal.trim()) {
      setRecipientValidation(null);
      return;
    }

    setIsValidatingAddress(true);
    try {
      // Run comprehensive validation (includes on-chain check)
      const check = await SolanaAddressValidator.validateComprehensive(newVal, connection);
      setRecipientValidation(check);
    } catch (error) {
      console.warn("Address validation failed:", error);
      // Fall back to local validation
      const localCheck = SolanaAddressValidator.validateLocal(newVal);
      setRecipientValidation(localCheck);
    } finally {
      setIsValidatingAddress(false);
    }
  };

  const handleSend = async (e: React.MouseEvent) => {
    if (!publicKey || !recipient || !amount) return;

    // FIRST LINE OF DEFENSE: Transaction Guard
    setLoading(true);
    try {
      let transaction = new Transaction();

      if (tokenType === 'SOL') {
        // SOL transfer
        const recipientPubkey = new PublicKey(recipient);
        const lamports = parseFloat(amount) * 1_000_000_000; // Convert to lamports

        transaction.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: recipientPubkey,
            lamports,
          })
        );
      } else {
        // USDC transfer
        const recipientPubkey = new PublicKey(recipient);
        const transferAmount = parseFloat(amount) * 1_000_000; // Assuming 6 decimals for USDC

        const fromAta = await getAssociatedTokenAddress(USDC_MINT, publicKey);
        const toAta = await getAssociatedTokenAddress(USDC_MINT, recipientPubkey);

        transaction.add(
          createTransferInstruction(
            fromAta,
            toAta,
            publicKey,
            transferAmount
          )
        );
      }

      // SECOND LINE OF DEFENSE: Security Check
      const securityCheck = await TransactionGuard.fullSecurityCheck(e, transaction);

      if (!securityCheck.safe) {
        alert(securityCheck.error);
        return; // HARD STOP
      }

      if (securityCheck.warnings && securityCheck.warnings.length > 0) {
        // Show warnings but allow user to proceed
        const proceed = confirm(
          `Security Warnings Detected:\n${securityCheck.warnings.join('\n')}\n\nDo you want to proceed anyway? (Not Recommended)`
        );
        if (!proceed) return; // HARD STOP
      }

      // THIRD LINE: Send to Wallet
      const signature = await sendTransaction(transaction, connection);
      await connection.confirmTransaction(signature, 'confirmed');

      alert(`Transaction successful! ${signature}`);
      onBalanceUpdate();
      setRecipient('');
      setAmount('');

    } catch (error) {
      console.error('Transaction failed:', error);
      alert(`Transaction failed: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="standard-wallet">
      <h2>📤 Standard Transaction</h2>

      {/* AUTONOMY STATUS - COMPACT */}
      <div className="autonomy-status-bar">
        <AutonomyDashboard
          autonomyStatus={autonomyStatus}
          protocolStatus={{ safe: true }}
          compact={true}
        />
        <span className="protocol-note">
          PDX Protocol: {autonomyStatus.safe ? 'Autonomous' : 'Not Autonomous'}
        </span>
      </div>

      <div className="form-group">
        <label>Token Type:</label>
        <select
          value={tokenType}
          onChange={(e) => setTokenType(e.target.value as 'SOL' | 'USDC')}
        >
          <option value="SOL">SOL</option>
          <option value="USDC">USDC</option>
        </select>
      </div>

      <div className="form-group">
        <label>Recipient Address:</label>
        <input
          type="text"
          placeholder="Enter Solana address..."
          value={recipient}
          onChange={handleRecipientChange}
          autoComplete="off"
          data-form-type="other"
          spellCheck="false"
          className={`security-input ${recipientValidation ? (recipientValidation.isValid ? 'valid-address' : 'invalid-address') : ''}`}
        />
        {recipient && recipientValidation && (
          <div className={`address-validation ${recipientValidation.isValid ? 'valid' : 'invalid'}`}>
            {recipientValidation.isValid ? (
              <div className="address-details">
                <div className="address-status">
                  ✅ Valid {recipientValidation.type === 'WALLET' ? 'Wallet' : 'Program'} Address
                  {recipientValidation.exists !== undefined && (
                    <span className={`account-status ${recipientValidation.exists ? 'exists' : 'fresh'}`}>
                      {recipientValidation.exists ? ' (Account exists)' : ' (Fresh account)'}
                    </span>
                  )}
                </div>

                {recipientValidation.type === 'PDA' && (
                  <small className="pda-warning">
                    ⚠️ Program Derived Address (PDA) - Can receive funds but cannot sign transactions
                  </small>
                )}

                {recipientValidation.balance !== undefined && recipientValidation.exists && (
                  <small className="balance-info">
                    💰 Current balance: {recipientValidation.balance.toFixed(4)} SOL
                  </small>
                )}

                {!recipientValidation.exists && (
                  <small className="fresh-account-info">
                    📝 Fresh account - Will be created automatically when receiving funds
                  </small>
                )}
              </div>
            ) : (
              <>❌ {recipientValidation.error}</>
            )}
          </div>
        )}

        {isValidatingAddress && (
          <div className="address-validating">
            🔍 Validating address...
          </div>
        )}
      </div>

      <div className="form-group">
        <label>Amount ({tokenType}):</label>
        <input
          type="number"
          step="0.000001"
          placeholder={`Enter ${tokenType} amount...`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      <button
        className="send-button"
        onClick={handleSend}
        disabled={loading || !recipient || !amount || (recipientValidation && !recipientValidation.isValid)}
      >
        {loading ? '⏳ Sending...' : `📤 Send ${tokenType}`}
      </button>

      <div className="transaction-info">
        <h3>Transaction Details</h3>
        <p>✅ Public transaction on Solana blockchain</p>
        <p>✅ Standard fees apply</p>
        <p>❌ No privacy protection</p>
      </div>
    </div>
  );
};
