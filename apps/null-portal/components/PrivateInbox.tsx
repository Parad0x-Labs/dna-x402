"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import { useCluster } from "./ClusterProvider";
import { getConnectionForCluster, getOwnedNames, resolveStealthMeta, type OwnedName } from "@/lib/chain";
import { auctionRegistrarFor, ixSetStealthMeta, shortAddr } from "@/lib/null-sdk";
import { keysFromWalletSignature, NULLPAY_KEY_MESSAGE, type StealthKeys } from "@/lib/nullpay";
import { scanInbox, buildSweepTxs, sweepResidualSol, fmtSol, fmtUsdc, type IncomingPayment } from "@/lib/stealth";
import { signAndSendInstructions } from "@/lib/wallet";
import { explorerAddr, explorerTx } from "@/lib/cluster";

type NameMeta = "loading" | "yours" | "other" | "none";

function bytesEq(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function PrivateInbox() {
  const { cluster, config } = useCluster();
  const { address, connect, connecting, signMessage } = useWallet();

  const [keys, setKeys] = useState<StealthKeys | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [names, setNames] = useState<OwnedName[]>([]);
  const [metaOf, setMetaOf] = useState<Record<string, NameMeta>>({});
  const [busyName, setBusyName] = useState<string | null>(null);

  const [inbox, setInbox] = useState<Record<string, IncomingPayment[]>>({});
  const [scanning, setScanning] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Re-lock if the wallet changes.
  useEffect(() => {
    setKeys(null);
    setNames([]);
    setMetaOf({});
    setInbox({});
  }, [address, cluster]);

  const unlock = useCallback(async () => {
    setErr(null);
    setUnlocking(true);
    try {
      if (!address) await connect();
      const sig = await signMessage(NULLPAY_KEY_MESSAGE);
      setKeys(keysFromWalletSignature(sig));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlocking(false);
    }
  }, [address, connect, signMessage]);

  // Load owned names (on the sha256 stealth registrar) + classify each one's meta.
  useEffect(() => {
    if (!keys || !address) return;
    let live = true;
    (async () => {
      try {
        const owner = new PublicKey(address);
        const owned = await getOwnedNames(cluster, owner, auctionRegistrarFor(cluster));
        if (!live) return;
        setNames(owned);
        setMetaOf(Object.fromEntries(owned.map((n) => [n.name, "loading" as NameMeta])));
        const conn = getConnectionForCluster(cluster);
        for (const n of owned) {
          const r = await resolveStealthMeta(conn, cluster, n.name);
          if (!live) return;
          const status: NameMeta =
            r.status !== "found" ? "none" : bytesEq(r.meta, keys.meta) ? "yours" : "other";
          setMetaOf((m) => ({ ...m, [n.name]: status }));
        }
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [keys, address, cluster]);

  const enable = useCallback(
    async (name: string) => {
      if (!keys || !address) return;
      setBusyName(name);
      setErr(null);
      try {
        const conn = getConnectionForCluster(cluster);
        const ix = await ixSetStealthMeta(cluster, new PublicKey(address), name, keys.meta);
        await signAndSendInstructions({ connection: conn, owner: address, instructions: [ix], computeUnits: 60_000 });
        setMetaOf((m) => ({ ...m, [name]: "yours" }));
        setNote(`${name}.null can now receive private payments.`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyName(null);
      }
    },
    [keys, address, cluster],
  );

  const refreshInbox = useCallback(
    async (name: string) => {
      if (!keys) return;
      setScanning(name);
      setErr(null);
      try {
        const items = await scanInbox({ cluster, keys, name });
        setInbox((b) => ({ ...b, [name]: items }));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setScanning(null);
      }
    },
    [keys, cluster],
  );

  const sweep = useCallback(
    async (name: string, item: IncomingPayment) => {
      if (!address) return;
      setSweeping(item.stealthPub);
      setErr(null);
      try {
        const conn = getConnectionForCluster(cluster);
        const dest = new PublicKey(address);
        const txs = await buildSweepTxs({ cluster, incoming: item, destination: dest });
        for (const raw of txs) {
          const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
          await conn.confirmTransaction(sig, "confirmed");
        }
        // USDC payments leave residual SOL dust — sweep it too so nothing is left.
        if (item.usdcAtomic > 0n) {
          const residual = await sweepResidualSol({ cluster, incoming: item, destination: dest });
          if (residual) {
            const sig = await conn.sendRawTransaction(residual, { skipPreflight: false });
            await conn.confirmTransaction(sig, "confirmed");
          }
        }
        setNote(`Swept to ${shortAddr(address)} — your wallet.`);
        await refreshInbox(name);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSweeping(null);
      }
    },
    [address, cluster, refreshInbox],
  );

  const enabledNames = useMemo(() => names.filter((n) => metaOf[n.name] === "yours"), [names, metaOf]);

  return (
    <section className="pt-12 sm:pt-16 pb-10">
      <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
        <span className="h-[9px] w-[9px] animate-pulsering rounded-full bg-mint" />
        private inbox · nullpay
        <span className="hidden text-cyan sm:inline">· solana {config.label}</span>
      </span>

      <h1 className="mt-5 max-w-[16ch] font-display text-[clamp(40px,8vw,96px)] font-black leading-[0.85] tracking-[-0.035em] lowercase">
        receive <span className="text-mint">privately.</span>
      </h1>
      <p className="mt-5 max-w-[62ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
        Turn on private pay for your <b className="text-paper">.null</b> names. Money sent to them lands at a
        fresh one-time address only you can find and spend — your main wallet never appears.{" "}
        <span className="text-lime">Your keys come from your wallet signature, so there is nothing to back up or lose.</span>
      </p>

      {/* UNLOCK */}
      {!keys ? (
        <div className="mt-9 rounded-web0 border-[1.5px] border-line bg-bg2/65 p-6 backdrop-blur-md">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">step 1 · unlock</div>
          <p className="mb-4 max-w-[58ch] text-sm text-dim">
            Sign one message to derive your private-pay keys. The signature never leaves your device and moves no
            funds. The same wallet always reproduces the same keys.
          </p>
          <button
            onClick={unlock}
            disabled={unlocking || connecting}
            className="rounded-xl bg-mint px-6 py-3.5 font-sans text-[16px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-lime disabled:opacity-60"
          >
            {unlocking ? "sign in phantom…" : !address ? "connect + unlock" : "unlock private inbox"}
          </button>
        </div>
      ) : (
        <>
          {/* YOUR NAMES — enable private pay */}
          <div className="mt-9">
            <div className="mb-3 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">step 2 · your names</div>
            {names.length === 0 ? (
              <div className="rounded-web0 border-[1.5px] border-line bg-black/30 px-5 py-4 text-sm text-dim">
                No .null names on this wallet ({config.label}). Register one first, then enable private pay here.
              </div>
            ) : (
              <div className="grid gap-2.5">
                {names.map((n) => {
                  const status = metaOf[n.name];
                  return (
                    <div
                      key={n.pda}
                      className="flex flex-wrap items-center gap-3 rounded-xl border-[1.5px] border-line bg-bg2/50 px-4 py-3"
                    >
                      <span className="font-display text-lg font-black tracking-tight lowercase">
                        {n.name}
                        <span className="text-mint">.null</span>
                      </span>
                      <span className="ml-auto flex items-center gap-2 font-mono text-[11px]">
                        {status === "loading" && <span className="text-faint">checking…</span>}
                        {status === "yours" && (
                          <span className="rounded-full bg-mint/15 px-2.5 py-1 text-mint">private pay ON</span>
                        )}
                        {status === "other" && (
                          <span className="rounded-full bg-magenta/15 px-2.5 py-1 text-magenta">
                            meta set by another key
                          </span>
                        )}
                        {status === "none" && (
                          <button
                            onClick={() => enable(n.name)}
                            disabled={busyName === n.name}
                            className="rounded-lg bg-mint px-3.5 py-1.5 font-bold text-ink0 transition hover:bg-lime disabled:opacity-60"
                          >
                            {busyName === n.name ? "sign in phantom…" : "enable private pay"}
                          </button>
                        )}
                      </span>
                      {status === "yours" && (
                        <button
                          onClick={() => refreshInbox(n.name)}
                          disabled={scanning === n.name}
                          className="rounded-lg border-[1.5px] border-line px-3.5 py-1.5 font-mono text-[11px] font-semibold transition hover:border-mint disabled:opacity-60"
                        >
                          {scanning === n.name ? "scanning…" : "check inbox"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* INBOX */}
          {enabledNames.length > 0 && (
            <div className="mt-9">
              <div className="mb-3 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">step 3 · inbox</div>
              <div className="grid gap-4">
                {enabledNames.map((n) => {
                  const items = inbox[n.name];
                  return (
                    <div key={n.pda} className="rounded-web0 border-[1.5px] border-line bg-bg2/50 p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-display text-base font-black lowercase">
                          {n.name}<span className="text-mint">.null</span>
                        </span>
                        <button
                          onClick={() => refreshInbox(n.name)}
                          disabled={scanning === n.name}
                          className="font-mono text-[11px] text-cyan underline decoration-line hover:text-mint disabled:opacity-60"
                        >
                          {scanning === n.name ? "scanning…" : "refresh"}
                        </button>
                      </div>
                      {!items ? (
                        <div className="font-mono text-[12px] text-faint">Tap “check inbox” to scan for private payments.</div>
                      ) : items.length === 0 ? (
                        <div className="font-mono text-[12px] text-faint">No unswept private payments found.</div>
                      ) : (
                        <div className="grid gap-2">
                          {items.map((it) => (
                            <div key={it.stealthPub} className="flex flex-wrap items-center gap-3 rounded-lg border-[1.5px] border-mint/40 bg-mint/[0.05] px-3.5 py-2.5">
                              <div className="font-mono text-[12px]">
                                {it.usdcAtomic > 0n && <span className="font-bold text-lime">{fmtUsdc(it.usdcAtomic)} USDC</span>}
                                {it.usdcAtomic > 0n && it.solLamports > 5000 && <span className="text-faint"> · </span>}
                                {it.solLamports > 5000 && it.usdcAtomic === 0n && <span className="font-bold text-lime">{fmtSol(it.solLamports)} SOL</span>}
                                <a
                                  className="ml-2 text-cyan underline decoration-line hover:text-mint"
                                  href={explorerAddr(cluster, it.stealthPub)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {shortAddr(it.stealthPub)} ↗
                                </a>
                              </div>
                              <button
                                onClick={() => sweep(n.name, it)}
                                disabled={sweeping === it.stealthPub}
                                className="ml-auto rounded-lg bg-mint px-3.5 py-1.5 font-mono text-[11px] font-bold text-ink0 transition hover:bg-lime disabled:opacity-60"
                              >
                                {sweeping === it.stealthPub ? "sweeping…" : "sweep to my wallet"}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {note && <div className="mt-5 rounded-lg border-[1.5px] border-mint/40 bg-mint/[0.06] px-4 py-2.5 font-mono text-[12px] text-mint">{note}</div>}
      {err && <div className="mt-5 break-words rounded-lg border-[1.5px] border-magenta/40 bg-magenta/[0.06] px-4 py-2.5 font-mono text-[12px] text-danger">{err}</div>}

      <p className="mt-8 max-w-[62ch] font-mono text-[11px] leading-relaxed text-faint">
        Recipient-private: your main wallet stays hidden. The sender’s wallet is still visible on-chain. Unaudited public beta.
      </p>
    </section>
  );
}
