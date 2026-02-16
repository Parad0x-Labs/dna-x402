import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { clusterApiUrl, Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { BaseWalletAdapter, WalletName } from '@solana/wallet-adapter-base';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';

export const SEEDPHRASE_WALLET_NAME = 'PDX Seed Phrase Wallet' as WalletName<'PDX Seed Phrase Wallet'>;

export class SeedPhraseWalletAdapter extends BaseWalletAdapter {
    name = SEEDPHRASE_WALLET_NAME;
    url = 'https://github.com/solana-labs/wallet-adapter';
    icon = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDMTMuMSAyIDI0IDMuOSA4IDI0SDZjLTEuMSAwLTEuOS0uOS0xLjktMS45VjE2YzAtLjYtLjQtMS4xLTEtMS4xczEtLjQgMS0xLjF2LTJjMC0xLjEuOS0yIDItMmgxNmMxLjEgMCAyIC45IDIgMnMxLS45IDItMnoiIGZpbGw9IiNmZmYiLz4KPHN2Zz4=';

    private _connecting: boolean;
    private _publicKey: PublicKey | null;
    private _keypair: Keypair | null;
    private _network: WalletAdapterNetwork;
    private _seedPhrase: string | null;
    private _accountIndex: number;

    constructor(network: WalletAdapterNetwork = WalletAdapterNetwork.Devnet, accountIndex: number = 0) {
        super();
        this._connecting = false;
        this._publicKey = null;
        this._keypair = null;
        this._network = network;
        this._seedPhrase = null;
        this._accountIndex = accountIndex;
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
        if (this._seedPhrase) {
            // Reconnect if we have a seed phrase
            this.connect();
        }
    }

    async connect(): Promise<void> {
        try {
            this._connecting = true;
            this.emit('connecting');

            // Try to load from localStorage first
            const storedData = this._loadFromStorage();
            if (storedData) {
                this._seedPhrase = storedData.seedPhrase;
                this._accountIndex = storedData.accountIndex;
                this._keypair = this._deriveKeypair(this._seedPhrase, this._accountIndex);
                this._publicKey = this._keypair.publicKey;
            } else {
                // Prompt user for seed phrase
                const seedPhrase = prompt('Enter your 12 or 24-word seed phrase:');
                if (!seedPhrase) {
                    throw new Error('No seed phrase provided');
                }

                // Validate seed phrase
                if (!this._validateSeedPhrase(seedPhrase)) {
                    throw new Error('Invalid seed phrase');
                }

                this._seedPhrase = seedPhrase.trim();

                // Ask for account index (for multiple accounts from same seed)
                const accountIndexStr = prompt('Enter account index (0 for default, 1 for second account, etc.):', '0');
                this._accountIndex = parseInt(accountIndexStr || '0', 10);

                this._keypair = this._deriveKeypair(this._seedPhrase, this._accountIndex);
                this._publicKey = this._keypair.publicKey;

                // Store for session persistence
                this._saveToStorage({
                    seedPhrase: this._seedPhrase,
                    accountIndex: this._accountIndex
                });
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
        this._seedPhrase = null;
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

    private _validateSeedPhrase(seedPhrase: string): boolean {
        try {
            const words = seedPhrase.trim().split(/\s+/);
            if (words.length !== 12 && words.length !== 24) {
                return false;
            }
            return bip39.validateMnemonic(seedPhrase.trim());
        } catch {
            return false;
        }
    }

    private _deriveKeypair(seedPhrase: string, accountIndex: number): Keypair {
        try {
            // Convert seed phrase to seed
            const seed = bip39.mnemonicToSeedSync(seedPhrase);

            // Derive path using Solana's derivation path
            // m/44'/501'/${accountIndex}'/0'
            const derivationPath = `m/44'/501'/${accountIndex}'/0'`;
            const derivedSeed = derivePath(derivationPath, seed.toString('hex')).key;

            // Generate keypair from derived seed
            const keypair = nacl.sign.keyPair.fromSeed(derivedSeed);

            // Convert to Solana Keypair format
            return Keypair.fromSecretKey(Uint8Array.from([...keypair.secretKey]));
        } catch (error) {
            throw new Error(`Failed to derive keypair: ${error}`);
        }
    }

    private _loadFromStorage(): { seedPhrase: string; accountIndex: number } | null {
        try {
            const stored = localStorage.getItem('pdx_seedphrase_wallet');
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (error) {
            console.warn('Failed to load seed phrase from storage:', error);
        }
        return null;
    }

    private _saveToStorage(data: { seedPhrase: string; accountIndex: number }): void {
        try {
            localStorage.setItem('pdx_seedphrase_wallet', JSON.stringify(data));
        } catch (error) {
            console.warn('Failed to save seed phrase to storage:', error);
        }
    }

    private _clearStorage(): void {
        try {
            localStorage.removeItem('pdx_seedphrase_wallet');
        } catch (error) {
            console.warn('Failed to clear storage:', error);
        }
    }
}
