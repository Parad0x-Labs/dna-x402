"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";
import { useCluster } from "./ClusterProvider";
import { shortAddr } from "@/lib/null-sdk";
import type { Cluster } from "@/lib/cluster";

function ConnectButton() {
  const { address, connecting, connect, disconnect, phantomAvailable } = useWallet();

  if (address) {
    return (
      <button
        onClick={disconnect}
        title={address}
        className="shrink-0 whitespace-nowrap rounded-full border-[1.5px] border-line bg-bg2/60 px-3.5 py-2 font-mono text-xs text-ink transition hover:border-mint sm:text-sm"
      >
        <span className="mr-2 inline-block h-[7px] w-[7px] align-middle rounded-full bg-mint" />
        {shortAddr(address)}
        <span className="ml-2 text-faint">disconnect</span>
      </button>
    );
  }

  const base =
    "shrink-0 inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-paper px-4 py-2.5 font-sans text-sm font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-violet hover:text-paper";

  if (!phantomAvailable) {
    return (
      <a href="https://phantom.app/" target="_blank" rel="noreferrer" className={base}>
        get phantom →
      </a>
    );
  }
  return (
    <button onClick={connect} disabled={connecting} className={`${base} disabled:opacity-60`}>
      {connecting ? "connecting…" : "connect phantom"}
    </button>
  );
}

function ClusterPill() {
  const { cluster, setCluster, ready } = useCluster();
  const next: Cluster = cluster === "mainnet" ? "devnet" : "mainnet";
  return (
    <button
      onClick={() => setCluster(next)}
      title={`active cluster: ${cluster} — click to switch to ${next}`}
      className="shrink-0 inline-flex items-center gap-2 rounded-full border-[1.5px] border-mint/40 bg-mint/[0.06] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.06em] text-mint transition hover:border-mint/70"
    >
      <span className={`inline-block h-[7px] w-[7px] rounded-full ${cluster === "mainnet" ? "bg-mint animate-pulsering" : "bg-steel"}`} />
      {ready ? cluster : "…"}
    </button>
  );
}

export function Header() {
  const pathname = usePathname();
  const link = (href: string, label: string) => (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 font-mono text-[13px] transition ${
        pathname === href ? "bg-lime text-ink0" : "text-dim hover:bg-lime hover:text-ink0"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <header className="sticky top-3 z-30 mt-3">
      <nav className="flex items-center justify-between gap-3 rounded-full border-[1.5px] border-line bg-bg2/50 px-3 py-2.5 pl-5 backdrop-blur-md">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="inline-block h-[13px] w-[13px] animate-pulsering rounded-full bg-mint" />
          <span className="font-sans text-[19px] font-bold tracking-tight">
            web0<span className="text-mint">.null</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {link("/", "search")}
          {link("/browse", "browse")}
          {link("/sell", "sell")}
          {link("/pay", "pay")}
          {link("/receive", "receive")}
          {link("/my-names", "my names")}
        </nav>
        <div className="flex items-center gap-2.5">
          <ClusterPill />
          <ConnectButton />
        </div>
      </nav>
    </header>
  );
}
