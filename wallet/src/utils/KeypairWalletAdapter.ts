import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { clusterApiUrl, Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { BaseWalletAdapter, WalletName } from '@solana/wallet-adapter-base';

export const KEYPAIR_WALLET_NAME = 'PDX Keypair Wallet' as WalletName<'PDX Keypair Wallet'>;

export class KeypairWalletAdapter extends BaseWalletAdapter {
    name = KEYPAIR_WALLET_NAME;
    url = 'https://github.com/solana-labs/wallet-adapter';
    icon = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTIwIDIwSDRhMiAyIDAgMCAxIDAtNFY0YTIgMiAwIDAgMSAyLTJoMTZhMiAyIDAgMCAxIDIgMnYxNmEyIDIgMCAwIDEtMiAyWiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8L3N2Zz4K';

    private _connecting: boolean;
    private _publicKey: PublicKey | null;
    private _keypair: Keypair | null;
    private _network: WalletAdapterNetwork;

    constructor(network: WalletAdapterNetwork = WalletAdapterNetwork.Devnet) {
        super();
        this._connecting = false;
        this._publicKey = null;
        this._keypair = null;
        this._network = network;
    }

    get connecting() {
        return this._connecting;
    }

    get connected() {
        return !!this._publicKey;
    }

    get publicKey() {
        return this._publicKey;
    }

    get network() {
        return this._network;
    }

    set network(network: WalletAdapterNetwork) {
        this._network = network;
        if (this._keypair) {
            // Reconnect if we have a keypair
            this.connect();
        }
    }

    async connect(): Promise<void> {
        try {
            this._connecting = true;
            this.emit('connecting');

            // Try to load from localStorage first
            const storedKeypair = this._loadFromStorage();
            if (storedKeypair) {
                this._keypair = storedKeypair;
                this._publicKey = storedKeypair.publicKey;
            } else {
                // Prompt user for private key
                const privateKey = prompt('Enter your Solana private key (64-byte array as comma-separated numbers or base58 string):');
                if (!privateKey) {
                    throw new Error('No private key provided');
                }

                this._keypair = this._parsePrivateKey(privateKey);
                this._publicKey = this._keypair.publicKey;

                // Store for session persistence
                this._saveToStorage(this._keypair);
            }

            this.emit('connect', this._publicKey);
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        } finally {
            this._connecting = false;
        }
    }

    async disconnect(): Promise<void> {
        this._publicKey = null;
        this._keypair = null;
        this._clearStorage();
        this.emit('disconnect');
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
        if (!this._keypair) {
            throw new Error('Wallet not connected');
        }

        // For VersionedTransaction, we need different handling
        if ('version' in transaction) {
            // This is a VersionedTransaction
            transaction.sign([this._keypair]);
        } else {
            // This is a legacy Transaction
            transaction.sign([this._keypair]);
        }

        return transaction;
    }

    async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
        if (!this._keypair) {
            throw new Error('Wallet not connected');
        }

        return transactions.map(tx => {
            if ('version' in tx) {
                tx.sign([this._keypair!]);
            } else {
                tx.sign([this._keypair!]);
            }
            return tx;
        });
    }

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
        if (!this._keypair) {
            throw new Error('Wallet not connected');
        }

        // Sign the message using the keypair
        const signature = this._keypair.sign(message);
        return signature;
    }

    private _parsePrivateKey(input: string): Keypair {
        try {
            // Try parsing as base58 string first
            if (input.includes(',')) {
                // Parse as comma-separated numbers
                const numbers = input.split(',').map(s => parseInt(s.trim(), 10));
                if (numbers.length !== 64) {
                    throw new Error('Private key must be 64 bytes');
                }
                const secretKey = new Uint8Array(numbers);
                return Keypair.fromSecretKey(secretKey);
            } else {
                // Try as base58 string
                const secretKey = new Uint8Array(Array.from(atob(input), c => c.charCodeAt(0)));
                if (secretKey.length !== 64) {
                    throw new Error('Invalid private key format');
                }
                return Keypair.fromSecretKey(secretKey);
            }
        } catch (error) {
            throw new Error(`Invalid private key format: ${error}`);
        }
    }

    private _loadFromStorage(): Keypair | null {
        try {
            const stored = localStorage.getItem('pdx_keypair_wallet');
            if (stored) {
                const data = JSON.parse(stored);
                const secretKey = new Uint8Array(data.secretKey);
                return Keypair.fromSecretKey(secretKey);
            }
        } catch (error) {
            console.warn('Failed to load keypair from storage:', error);
        }
        return null;
    }

    private _saveToStorage(keypair: Keypair): void {
        try {
            const data = {
                secretKey: Array.from(keypair.secretKey),
                publicKey: keypair.publicKey.toBase58()
            };
            localStorage.setItem('pdx_keypair_wallet', JSON.stringify(data));
        } catch (error) {
            console.warn('Failed to save keypair to storage:', error);
        }
    }

    private _clearStorage(): void {
        try {
            localStorage.removeItem('pdx_keypair_wallet');
        } catch (error) {
            console.warn('Failed to clear storage:', error);
        }
    }
}
