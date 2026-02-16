import React, { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NullFaucetClient } from '../client/faucet_client';

interface NullFaucetProps {
  connection: Connection;
  programId: PublicKey;
  nullMint: PublicKey;
}

export const NullFaucet: React.FC<NullFaucetProps> = ({
  connection,
  programId,
  nullMint
}) => {
  const { publicKey, signTransaction } = useWallet();
  const [canClaim, setCanClaim] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastClaim, setLastClaim] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const faucetClient = new NullFaucetClient(connection, programId, nullMint);

  useEffect(() => {
    if (publicKey) {
      checkClaimStatus();
    }
  }, [publicKey]);

  const checkClaimStatus = async () => {
    if (!publicKey) return;

    try {
      const claimable = await faucetClient.canClaim(publicKey);
      setCanClaim(claimable);

      // Get claim record to show last claim time
      const claimRecordPDA = faucetClient.getClaimRecordPDA(publicKey);
      const accountInfo = await connection.getAccountInfo(claimRecordPDA);

      if (accountInfo && accountInfo.data.length >= 8) {
        const lastClaimDay = Number(accountInfo.data.readBigUInt64LE(0));
        setLastClaim(lastClaimDay * 86400 * 1000); // Convert to milliseconds
      }
    } catch (err) {
      console.error('Error checking claim status:', err);
    }
  };

  const handleClaim = async () => {
    if (!publicKey || !signTransaction) {
      setError('Wallet not connected');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Get SOL balance for gas
      const balance = await connection.getBalance(publicKey);
      if (balance < 0.001 * LAMPORTS_PER_SOL) {
        setError('Insufficient SOL for transaction fees. Get devnet SOL first.');
        return;
      }

      // Claim tokens
      const signature = await faucetClient.claimTokens({
        publicKey,
        signTransaction: async (tx) => {
          const signed = await signTransaction(tx);
          return signed;
        }
      } as any); // Type workaround for wallet adapter

      setSuccess(`Successfully claimed 20 $NULL tokens! TX: ${signature}`);
      setCanClaim(false);
      await checkClaimStatus(); // Refresh status

    } catch (err: any) {
      console.error('Claim failed:', err);
      setError(err.message || 'Claim failed. Try again later.');
    } finally {
      setIsLoading(false);
    }
  };

  const formatLastClaim = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString() + ' ' +
           new Date(timestamp).toLocaleTimeString();
  };

  const getNextClaimTime = () => {
    if (!lastClaim) return 'Never claimed';
    const nextClaim = lastClaim + (24 * 60 * 60 * 1000); // 24 hours later
    const now = Date.now();
    if (now >= nextClaim) return 'Now available!';
    const hoursLeft = Math.ceil((nextClaim - now) / (60 * 60 * 1000));
    return `Available in ${hoursLeft} hours`;
  };

  if (!publicKey) {
    return (
      <div className="bg-gray-800 rounded-lg p-6 text-center">
        <h3 className="text-xl font-bold text-white mb-4">$NULL Faucet</h3>
        <p className="text-gray-400">Connect your wallet to claim $NULL tokens</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h3 className="text-xl font-bold text-white mb-4">$NULL Faucet</h3>
      <p className="text-gray-300 mb-4">
        Claim <span className="text-green-400 font-bold">20 $NULL</span> tokens per day
        to test PDX privacy transfers.
      </p>

      {error && (
        <div className="bg-red-900/50 border border-red-500 rounded p-3 mb-4">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {success && (
        <div className="bg-green-900/50 border border-green-500 rounded p-3 mb-4">
          <p className="text-green-400 text-sm">{success}</p>
        </div>
      )}

      <div className="space-y-3 mb-4">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Last Claim:</span>
          <span className="text-white">
            {lastClaim ? formatLastClaim(lastClaim) : 'Never'}
          </span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Next Claim:</span>
          <span className="text-white">{getNextClaimTime()}</span>
        </div>
      </div>

      <button
        onClick={handleClaim}
        disabled={!canClaim || isLoading}
        className={`w-full py-3 px-4 rounded-lg font-bold transition-colors ${
          canClaim && !isLoading
            ? 'bg-green-600 hover:bg-green-700 text-white'
            : 'bg-gray-600 text-gray-400 cursor-not-allowed'
        }`}
      >
        {isLoading ? 'Claiming...' :
         canClaim ? 'Claim 20 $NULL' :
         'Already claimed today'}
      </button>

      <div className="mt-4 text-xs text-gray-500 text-center">
        <p>⚠️ Devnet only - Test tokens have no value</p>
        <p>🔄 Refreshes daily at UTC midnight</p>
      </div>
    </div>
  );
};
