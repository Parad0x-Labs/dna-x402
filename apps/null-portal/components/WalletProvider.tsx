"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  connectPhantom,
  disconnectPhantom,
  getPhantom,
  normalizeWalletAddress,
} from "@/lib/wallet";

interface WalletState {
  address: string | null;
  connecting: boolean;
  error: string | null;
  phantomAvailable: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phantomAvailable, setPhantomAvailable] = useState(false);

  // Detect Phantom + try a silent (trusted) reconnect on mount.
  useEffect(() => {
    const phantom = getPhantom();
    setPhantomAvailable(!!phantom);
    if (!phantom) return;

    // Silent reconnect — only if the user previously trusted this site.
    connectPhantom({ onlyIfTrusted: true })
      .then((addr) => setAddress(addr))
      .catch(() => {
        /* not previously connected — that's fine */
      });

    // Track account switches / disconnects coming from the extension.
    const onAccountChanged = (pk: unknown) => {
      const next = normalizeWalletAddress(pk as { toBase58?: () => string } | null);
      setAddress(next || null);
    };
    const onDisconnect = () => setAddress(null);
    phantom.on?.("accountChanged", onAccountChanged);
    phantom.on?.("disconnect", onDisconnect);
    return () => {
      phantom.removeListener?.("accountChanged", onAccountChanged);
      phantom.removeListener?.("disconnect", onDisconnect);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const addr = await connectPhantom();
      setAddress(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await disconnectPhantom();
    setAddress(null);
    setError(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({ address, connecting, error, phantomAvailable, connect, disconnect }),
    [address, connecting, error, phantomAvailable, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
}
