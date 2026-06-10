import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { ClusterProvider } from "@/components/ClusterProvider";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "web0.null — the web, without the rent",
  description:
    "web0.null is the Web0 flagship: register a .null name on Solana, point it at a site on Arweave, and send private payments by name — $0/month, no server, no DNS, no host, nobody can take it down. Owned by your wallet, online forever.",
  icons: {
    icon:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0E13'/%3E%3Ccircle cx='16' cy='16' r='8' fill='%232DD4A0'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <div className="web0-grid" aria-hidden />
        <ClusterProvider>
          <WalletProvider>
            <Header />
            <main className="mx-auto max-w-[1060px] px-5 sm:px-7">{children}</main>
          <footer className="mx-auto max-w-[1060px] px-5 sm:px-7 border-t border-line mt-20">
            <div className="py-8 flex flex-col gap-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
                  <span className="font-mono text-sm font-bold tracking-wider">
                    web0<span className="text-acc">.null</span>
                  </span>
                </div>
                <span className="font-extrabold tracking-[-0.5px] text-dim text-sm">
                  The road to <span className="text-acc">Web0</span>.
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs border-t border-line pt-6">
                <span className="text-dim">
                  web0.null · the Web0 flagship · names owned on Solana ·{" "}
                  <a
                    className="text-acc font-semibold hover:brightness-110 transition"
                    href="https://parad0xlabs.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    parad0xlabs.com
                  </a>
                </span>
                <span className="font-mono text-faint">
                  registrar H4wbFJ… · non-custodial · unaudited public beta
                </span>
              </div>
            </div>
          </footer>
          </WalletProvider>
        </ClusterProvider>
      </body>
    </html>
  );
}
