import type { Metadata } from "next";
import { Archivo, Space_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { ClusterProvider } from "@/components/ClusterProvider";
import { Header } from "@/components/Header";
import { FlowField } from "@/components/FlowField";

const display = Archivo({ subsets: ["latin"], weight: ["800", "900"], variable: "--font-display" });
const sans = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans" });
const mono = Space_Mono({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "web0.null — the web, without the rent",
  description:
    "web0.null is the Web0 flagship: register a .null name on Solana, point it at a site on Arweave, and send private payments by name — $0/month, no server, no DNS, no host, nobody can take it down. Owned by your wallet, online forever.",
  icons: {
    icon:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2307060A'/%3E%3Ccircle cx='16' cy='16' r='8' fill='%233DFFB0'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">
        <FlowField />
        <div className="v4-vignette" aria-hidden />
        <ClusterProvider>
          <WalletProvider>
            <div className="relative z-[2] mx-auto w-full max-w-[1240px] px-4 sm:px-6">
              <Header />
              <main>{children}</main>
              <footer className="mt-16 border-t border-line">
                <div className="flex flex-col gap-5 py-8">
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div className="flex items-center gap-2.5">
                      <span className="inline-block h-[11px] w-[11px] animate-pulsering rounded-full bg-mint" />
                      <span className="font-mono text-sm font-bold tracking-wider">
                        web0<span className="text-mint">.null</span>
                      </span>
                    </div>
                    <span className="font-display text-sm font-extrabold tracking-tight text-dim">
                      the road to <span className="text-lime">Web0</span>.
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 font-mono text-xs text-faint">
                    <span>
                      non-custodial · owned by your wallet · hosted on{" "}
                      <a
                        className="text-cyan transition hover:brightness-125"
                        href="https://parad0xlabs.com"
                        target="_blank"
                        rel="noreferrer"
                      >
                        arweave
                      </a>
                      , permanent
                    </span>
                    <span>registrar H4wbFJ… · public beta · capped · unaudited</span>
                  </div>
                </div>
              </footer>
            </div>
          </WalletProvider>
        </ClusterProvider>
        <div className="v4-scan" aria-hidden />
      </body>
    </html>
  );
}
