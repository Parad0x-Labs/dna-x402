import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Buffer } from "buffer/";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

globalThis.Buffer = globalThis.Buffer ?? Buffer;

interface InjectedWalletProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: PublicKey | string | null;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: PublicKey | string | null } | void>;
  disconnect?: () => Promise<void>;
  signAndSendTransaction?: (
    transaction: Transaction,
    options?: { skipPreflight?: boolean; preflightCommitment?: string },
  ) => Promise<string | { signature: string }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
}

declare global {
  interface Window {
    solana?: InjectedWalletProvider;
    solflare?: InjectedWalletProvider;
  }
}

export interface BrowserWalletState {
  connected: boolean;
  connecting: boolean;
  walletName: string | null;
  publicKey: PublicKey | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendTransaction: (
    transaction: Transaction,
    connection: Connection,
    options?: { skipPreflight?: boolean; preflightCommitment?: string },
  ) => Promise<string>;
}

const WalletContext = createContext<BrowserWalletState | null>(null);

function normalizePublicKey(value: PublicKey | string | null | undefined): PublicKey | null {
  if (!value) {
    return null;
  }
  return value instanceof PublicKey ? value : new PublicKey(value);
}

function detectProvider(): { name: string; provider: InjectedWalletProvider } | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (window.solana?.isPhantom) {
    return { name: "Phantom", provider: window.solana };
  }
  if (window.solflare?.isSolflare) {
    return { name: "Solflare", provider: window.solflare };
  }
  return null;
}

export const BrowserWalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [providerInfo, setProviderInfo] = useState(() => detectProvider());
  const [publicKey, setPublicKey] = useState<PublicKey | null>(() => normalizePublicKey(providerInfo?.provider.publicKey));
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    const detected = providerInfo ?? detectProvider();
    if (!detected) {
      throw new Error("Install Phantom or Solflare to run wallet-signed payments.");
    }
    setConnecting(true);
    try {
      const result = await detected.provider.connect();
      setProviderInfo(detected);
      setPublicKey(normalizePublicKey(result?.publicKey ?? detected.provider.publicKey));
    } finally {
      setConnecting(false);
    }
  }, [providerInfo]);

  const disconnect = useCallback(async () => {
    if (providerInfo?.provider.disconnect) {
      await providerInfo.provider.disconnect();
    }
    setPublicKey(null);
  }, [providerInfo]);

  const sendTransaction = useCallback<BrowserWalletState["sendTransaction"]>(async (transaction, connection, options) => {
    const detected = providerInfo ?? detectProvider();
    if (!detected) {
      throw new Error("Install Phantom or Solflare to run wallet-signed payments.");
    }
    if (detected.provider.signAndSendTransaction) {
      const result = await detected.provider.signAndSendTransaction(transaction, options);
      return typeof result === "string" ? result : result.signature;
    }
    if (detected.provider.signTransaction) {
      const signed = await detected.provider.signTransaction(transaction);
      return connection.sendRawTransaction(signed.serialize(), options);
    }
    throw new Error(`${detected.name} does not expose a transaction signing API.`);
  }, [providerInfo]);

  const value = useMemo<BrowserWalletState>(() => ({
    connected: Boolean(publicKey),
    connecting,
    walletName: providerInfo?.name ?? null,
    publicKey,
    connect,
    disconnect,
    sendTransaction,
  }), [connect, connecting, disconnect, providerInfo?.name, publicKey, sendTransaction]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

export function useWallet(): BrowserWalletState {
  const wallet = useContext(WalletContext);
  if (!wallet) {
    throw new Error("useWallet must be used inside BrowserWalletProvider.");
  }
  return wallet;
}

function shortAddress(publicKey: PublicKey): string {
  const address = publicKey.toBase58();
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export const WalletMultiButton: React.FC = () => {
  const wallet = useWallet();
  if (wallet.connected && wallet.publicKey) {
    return (
      <button type="button" className="wallet-adapter-button" onClick={() => void wallet.disconnect()}>
        {wallet.walletName ?? "Wallet"} {shortAddress(wallet.publicKey)}
      </button>
    );
  }
  return (
    <button type="button" className="wallet-adapter-button" onClick={() => void wallet.connect()} disabled={wallet.connecting}>
      {wallet.connecting ? "Connecting..." : "Connect Wallet"}
    </button>
  );
};
