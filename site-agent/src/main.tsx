import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { App } from './App';
import { clusterRpc, defaultRuntimeConfig } from './lib/runtimeConfig';
import './styles.css';
import '@solana/wallet-adapter-react-ui/styles.css';

const defaults = defaultRuntimeConfig();
const endpoint = clusterRpc(defaults.cluster);
const wallets = [new PhantomWalletAdapter(), new BackpackWalletAdapter(), new SolflareWalletAdapter()];

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter basename="/agent">
            <App />
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </React.StrictMode>,
);
