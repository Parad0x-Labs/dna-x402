import React, { useEffect, useMemo, useState } from "react";
import { AgentApiClient } from "../lib/api";
import { loadRuntimeConfig } from "../lib/runtimeConfig";
import { TipAccount, TipConfigResponse, TipDepositIntentResponse, TipLedgerRecord } from "../lib/types";
import { WalletMultiButton, useWallet } from "../lib/wallet";

const SESSION_KEY_PREFIX = "dna-null-tip-session";

function short(value: string | null | undefined): string {
  if (!value) return "n/a";
  return value.length > 12 ? `${value.slice(0, 5)}...${value.slice(-5)}` : value;
}

function formatAtomic(value: string | undefined, decimals: number, symbol: string): string {
  const raw = BigInt(value ?? "0");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (decimals === 0) return `${whole.toString()} ${symbol}`;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}${fractionText ? `.${fractionText.slice(0, 6)}` : ""} ${symbol}`;
}

function sessionStorageKey(ownerWallet: string): string {
  return `${SESSION_KEY_PREFIX}:${ownerWallet}`;
}

export const NullTips: React.FC = () => {
  const config = useMemo(() => loadRuntimeConfig(), []);
  const api = useMemo(() => new AgentApiClient(config.x402BaseUrl), [config.x402BaseUrl]);
  const wallet = useWallet();

  const [tipConfig, setTipConfig] = useState<TipConfigResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [account, setAccount] = useState<TipAccount | null>(null);
  const [ledger, setLedger] = useState<TipLedgerRecord[]>([]);
  const [depositIntent, setDepositIntent] = useState<TipDepositIntentResponse | null>(null);
  const [depositAmount, setDepositAmount] = useState("1000000");
  const [depositTx, setDepositTx] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("100000");
  const [sendMemo, setSendMemo] = useState("");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("100000");
  const [status, setStatus] = useState<string>("Connect wallet, sign tip session, then use the vault.");
  const [busy, setBusy] = useState(false);

  const ownerWallet = wallet.publicKey?.toBase58() ?? null;
  const symbol = tipConfig?.tokenSymbol ?? "NULL";
  const decimals = tipConfig?.decimals ?? 6;

  useEffect(() => {
    void api.tipConfig()
      .then(setTipConfig)
      .catch((error) => setStatus(`Tip config failed: ${(error as Error).message}`));
  }, [api]);

  useEffect(() => {
    if (!ownerWallet) {
      setToken(null);
      setAccount(null);
      setLedger([]);
      return;
    }
    const saved = window.localStorage.getItem(sessionStorageKey(ownerWallet));
    if (saved) {
      setToken(saved);
    }
    setWithdrawTo(ownerWallet);
  }, [ownerWallet]);

  const refresh = async (sessionToken = token) => {
    if (!sessionToken) return;
    const [balance, events] = await Promise.all([
      api.tipBalance(sessionToken),
      api.tipLedger(sessionToken),
    ]);
    setAccount(balance.account);
    setLedger(events.ledger);
  };

  useEffect(() => {
    if (!token) return;
    void refresh(token).catch((error) => {
      setStatus(`Tip session refresh failed: ${(error as Error).message}`);
      if (ownerWallet) window.localStorage.removeItem(sessionStorageKey(ownerWallet));
      setToken(null);
    });
  }, [token]);

  const signIn = async () => {
    if (!ownerWallet) {
      await wallet.connect();
      return;
    }
    setBusy(true);
    try {
      const challenge = await api.tipChallenge(ownerWallet);
      const signature = await wallet.signMessage(challenge.challenge.message);
      const verified = await api.tipVerifySession({
        ownerWallet,
        challengeId: challenge.challenge.challengeId,
        signature,
      });
      window.localStorage.setItem(sessionStorageKey(ownerWallet), verified.token);
      setToken(verified.token);
      setStatus("Wallet session live. Sender is locked to your signed wallet.");
      await refresh(verified.token);
    } catch (error) {
      setStatus(`Wallet session failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const createDepositIntent = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const intent = await api.tipDepositIntent(token, depositAmount);
      setDepositIntent(intent);
      setStatus(intent.configured
        ? "Deposit intent created. Send NULL to the vault with the memo, then paste the transfer signature."
        : "Deposit intent created, but live vault config is missing on this server.");
      await refresh();
    } catch (error) {
      setStatus(`Deposit intent failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDeposit = async () => {
    if (!token || !depositIntent) return;
    setBusy(true);
    try {
      await api.tipConfirmDeposit(token, {
        depositIntentId: depositIntent.intent.intentId,
        txSignature: depositTx.trim(),
        amountAtomic: depositIntent.intent.amountAtomic ?? depositAmount,
      });
      setDepositTx("");
      setStatus("Deposit credited after proof verification.");
      await refresh();
    } catch (error) {
      setStatus(`Deposit proof failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendTip = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await api.tipSend(token, {
        toOwnerWallet: sendTo.trim(),
        amountAtomic: sendAmount,
        memo: sendMemo.trim() || undefined,
      });
      setStatus(`Tip sent: ${result.transferId}`);
      setSendMemo("");
      await refresh();
    } catch (error) {
      setStatus(`Tip send failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await api.tipWithdraw(token, {
        recipientWallet: withdrawTo.trim(),
        amountAtomic: withdrawAmount,
      });
      setStatus(`Withdrawal queued for manual review: ${result.withdrawalId}`);
      await refresh();
    } catch (error) {
      setStatus(`Withdrawal failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tips-page">
      <div className="tips-hero panel">
        <div>
          <p className="eyebrow">DNA x402 / NULL Tips</p>
          <h2>Fee-free in-app NULL tipping</h2>
          <p className="lead">
            Deposit NULL once, tip inside Parad0x through the internal ledger, withdraw later. On-chain fees stay at the edges.
          </p>
        </div>
        <div className="tips-wallet">
          <WalletMultiButton />
          <button type="button" className="btn-primary" onClick={signIn} disabled={busy || !wallet.connected}>
            {token ? "Refresh Session" : "Sign Tip Session"}
          </button>
        </div>
      </div>

      <div className="tips-grid">
        <article className="panel tips-balance-card">
          <h3>Balances</h3>
          <div className="tips-balance-row">
            <span>Agent wallet balance</span>
            <strong>On-chain wallet UI</strong>
            <small>Stays separate. This page never asks for private keys.</small>
          </div>
          <div className="tips-balance-row live">
            <span>Tip balance</span>
            <strong>{formatAtomic(account?.balanceAtomic, decimals, symbol)}</strong>
            <small>Internal ledger balance for instant in-app tips.</small>
          </div>
          <div className="tips-balance-row">
            <span>Pending withdrawals</span>
            <strong>{formatAtomic(account?.pendingWithdrawalAtomic, decimals, symbol)}</strong>
            <small>{tipConfig?.withdrawalsPaused ? "Withdrawals paused until vault reconciliation is green." : "Manual review queue."}</small>
          </div>
          <p className="guard-copy">
            Sender is derived from your signed wallet session. The browser cannot choose someone else as sender.
          </p>
        </article>

        <article className="panel">
          <h3>Top up tip balance</h3>
          <label className="field-stack">
            Raw NULL amount
            <input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="numeric" />
          </label>
          <button type="button" className="btn-primary" onClick={createDepositIntent} disabled={!token || busy}>
            Create Deposit Intent
          </button>
          {depositIntent && (
            <div className="tips-intent-box">
              <span>Vault</span>
              <strong>{short(depositIntent.instructions.vaultAddress)}</strong>
              <span>Mint</span>
              <strong>{short(depositIntent.instructions.tokenMint)}</strong>
              <span>Memo</span>
              <code>{depositIntent.instructions.memo}</code>
            </div>
          )}
          <label className="field-stack">
            Transfer signature
            <input value={depositTx} onChange={(event) => setDepositTx(event.target.value)} placeholder="paste Solana transfer signature" />
          </label>
          <button type="button" className="ghost-btn" onClick={confirmDeposit} disabled={!token || !depositIntent || !depositTx || busy}>
            Confirm Deposit Proof
          </button>
        </article>

        <article className="panel">
          <h3>Send tip</h3>
          <label className="field-stack">
            Recipient wallet
            <input value={sendTo} onChange={(event) => setSendTo(event.target.value)} placeholder="recipient Solana wallet" />
          </label>
          <label className="field-stack">
            Raw NULL amount
            <input value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} inputMode="numeric" />
          </label>
          <label className="field-stack">
            Note
            <input value={sendMemo} onChange={(event) => setSendMemo(event.target.value)} placeholder="optional" />
          </label>
          <button type="button" className="btn-primary" onClick={sendTip} disabled={!token || !sendTo || busy}>
            Send NULL Tip
          </button>
        </article>

        <article className="panel">
          <h3>Withdraw</h3>
          <label className="field-stack">
            Recipient wallet
            <input value={withdrawTo} onChange={(event) => setWithdrawTo(event.target.value)} placeholder="your Solana wallet" />
          </label>
          <label className="field-stack">
            Raw NULL amount
            <input value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} inputMode="numeric" />
          </label>
          <button type="button" className="ghost-btn" onClick={withdraw} disabled={!token || busy}>
            Queue Withdrawal
          </button>
          <p className="muted">Withdrawals are queued, not auto-swept. The vault must reconcile before payout.</p>
        </article>
      </div>

      <article className="panel tips-ledger">
        <div className="row space-between">
          <h3>Tip ledger</h3>
          <button type="button" className="ghost-btn" onClick={() => void refresh()} disabled={!token || busy}>
            Refresh
          </button>
        </div>
        <p className="muted">{status}</p>
        <div className="tips-ledger-table">
          {ledger.length === 0 ? (
            <p className="muted">No tip ledger events yet.</p>
          ) : ledger.map((event) => (
            <div key={event.id} className="tips-ledger-row">
              <span>{event.eventType}</span>
              <strong>{formatAtomic(event.amountAtomic, decimals, symbol)}</strong>
              <small>{event.status}</small>
              <small>{event.counterpartyWallet ? short(event.counterpartyWallet) : short(event.txSignature)}</small>
              <time>{new Date(event.createdAt).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
};

