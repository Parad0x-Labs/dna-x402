"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";
import { shortAddr } from "@/lib/null-sdk";

function ConnectButton() {
  const { address, connecting, connect, disconnect, phantomAvailable } = useWallet();

  if (address) {
    return (
      <button
        onClick={disconnect}
        title={address}
        className="shrink-0 whitespace-nowrap font-mono text-xs sm:text-sm rounded-lg border border-line2 bg-surf px-3 py-2 text-ink hover:border-acc-d transition-colors"
      >
        <span className="inline-block w-[7px] h-[7px] rounded-full bg-acc mr-2 align-middle" />
        {shortAddr(address)}
        <span className="text-faint ml-2">disconnect</span>
      </button>
    );
  }

  if (!phantomAvailable) {
    return (
      <a
        href="https://phantom.app/"
        target="_blank"
        rel="noreferrer"
        className="shrink-0 whitespace-nowrap font-mono text-xs sm:text-sm rounded-lg bg-acc px-3 sm:px-4 py-2 font-bold text-[#062018] hover:brightness-110 transition"
      >
        Get Phantom →
      </a>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={connecting}
      className="shrink-0 whitespace-nowrap font-mono text-xs sm:text-sm rounded-lg bg-acc px-3 sm:px-4 py-2 font-bold text-[#062018] hover:brightness-110 transition disabled:opacity-60"
    >
      {connecting ? "connecting…" : <><span className="sm:hidden">Connect</span><span className="hidden sm:inline">Connect Phantom</span></>}
    </button>
  );
}

export function Header() {
  const pathname = usePathname();
  const link = (href: string, label: string) => (
    <Link
      href={href}
      className={`font-mono text-xs sm:text-sm transition-colors ${
        pathname === href ? "text-acc" : "text-dim hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg">
      <div className="mx-auto max-w-[1060px] px-5 sm:px-7 py-4 flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-3 sm:gap-6 min-w-0">
          <Link href="/" className="flex items-center gap-2 shrink-0 group">
            <span className="inline-block w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
            <span className="font-mono text-sm font-bold tracking-wider">
              .null<span className="hidden sm:inline text-faint group-hover:text-dim transition-colors">/register</span>
            </span>
          </Link>
          <nav className="flex items-center gap-3 sm:gap-4">
            {link("/", "search")}
            {link("/my-names", "my names")}
          </nav>
        </div>
        <ConnectButton />
      </div>
    </header>
  );
}
