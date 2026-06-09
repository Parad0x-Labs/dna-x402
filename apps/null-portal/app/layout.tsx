import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: ".null Register — claim a name on Solana mainnet",
  description:
    "Connect your Phantom wallet and register a .null name on Solana mainnet. A name owned by your keypair — no server, no DNS, no host. This is Web0.",
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
        <WalletProvider>
          <Header />
          <main className="mx-auto max-w-[1060px] px-5 sm:px-7">{children}</main>
          <footer className="mx-auto max-w-[1060px] px-5 sm:px-7 border-t border-line mt-16 py-8">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-dim">
                Web0 · names owned on Solana mainnet ·{" "}
                <a
                  className="text-acc font-semibold"
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
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
