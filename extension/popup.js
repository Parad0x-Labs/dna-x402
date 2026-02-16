// PDX Dark Protocol Browser Extension
// Privacy-preserving transfers on Solana

class PDXExtension {
    constructor() {
        this.wallet = null;
        this.programId = '3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz'; // PDX Dark Protocol
        this.nullMint = 'ADVjd6sSVsjc165FnisTrb4HvtoLNy4RHAp2rbG1oGNa'; // $NULL PARADOX Token

        this.init();
    }

    async init() {
        this.bindEvents();
        await this.checkWalletConnection();
        this.updateUI();
    }

    bindEvents() {
        document.getElementById('connectWallet').addEventListener('click', () => this.connectWallet());
        document.getElementById('depositNull').addEventListener('click', () => this.depositNull());
        document.getElementById('sendPrivate').addEventListener('click', () => this.showTransferForm());
        document.getElementById('claimFaucet').addEventListener('click', () => this.claimFaucet());
        document.getElementById('generateWallet').addEventListener('click', () => this.generateNewWallet());
        document.getElementById('executeTransfer').addEventListener('click', () => this.executeTransfer());
        document.getElementById('cancelTransfer').addEventListener('click', () => this.hideTransferForm());
    }

    async checkWalletConnection() {
        // Check if Phantom is available
        if (window.solana && window.solana.isPhantom) {
            try {
                // Check if already connected
                const response = await window.solana.connect({ onlyIfTrusted: true });
                this.wallet = window.solana;
                await this.updateBalance();
            } catch (error) {
                // Not connected, will show connect button
            }
        }
    }

    async connectWallet() {
        try {
            if (!window.solana || !window.solana.isPhantom) {
                alert('Phantom wallet not found. Please install Phantom wallet.');
                window.open('https://phantom.app/', '_blank');
                return;
            }

            const response = await window.solana.connect();
            this.wallet = window.solana;
            await this.updateBalance();
            this.updateUI();

            // Send message to background script
            chrome.runtime.sendMessage({
                action: 'wallet_connected',
                publicKey: response.publicKey.toString()
            });

        } catch (error) {
            console.error('Wallet connection failed:', error);
            alert('Failed to connect wallet: ' + error.message);
        }
    }

    async updateBalance() {
        if (!this.wallet) return;

        try {
            // Get SOL balance
            const connection = new solanaWeb3.Connection('https://api.devnet.solana.com');
            const balance = await connection.getBalance(this.wallet.publicKey);
            const solBalance = balance / solanaWeb3.LAMPORTS_PER_SOL;

            document.getElementById('balance').textContent = `${solBalance.toFixed(4)} SOL`;
        } catch (error) {
            console.error('Failed to get balance:', error);
        }
    }

    updateUI() {
        const walletText = document.getElementById('walletText');
        const walletStatus = document.getElementById('walletStatus');
        const connectBtn = document.getElementById('connectWallet');
        const depositBtn = document.getElementById('depositNull');
        const sendBtn = document.getElementById('sendPrivate');
        const claimBtn = document.getElementById('claimFaucet');

        if (this.wallet) {
            walletText.textContent = `🔗 Connected: ${this.wallet.publicKey.toString().slice(0, 6)}...${this.wallet.publicKey.toString().slice(-4)}`;
            walletStatus.classList.add('connected');
            connectBtn.style.display = 'none';
            depositBtn.style.display = 'block';
            sendBtn.style.display = 'block';
            claimBtn.style.display = 'block';
        } else {
            walletText.textContent = '🔌 Connect Your Solana Wallet';
            walletStatus.classList.remove('connected');
            connectBtn.style.display = 'block';
            depositBtn.style.display = 'none';
            sendBtn.style.display = 'none';
            claimBtn.style.display = 'none';
        }
    }

    showTransferForm() {
        if (!this.wallet) {
            alert('Please connect your wallet first');
            return;
        }
        document.getElementById('transferForm').classList.remove('hidden');
    }

    hideTransferForm() {
        document.getElementById('transferForm').classList.add('hidden');
    }

    async executeTransfer() {
        const recipient = document.getElementById('recipient').value;
        const amount = parseFloat(document.getElementById('amount').value);
        const memo = document.getElementById('memo').value;

        if (!recipient || !amount) {
            alert('Please fill in recipient and amount');
            return;
        }

        try {
            // This would integrate with the PDX client
            alert('PDX Transfer functionality will be implemented after deployment');

            // Hide form after "successful" transfer
            this.hideTransferForm();

        } catch (error) {
            console.error('Transfer failed:', error);
            alert('Transfer failed: ' + error.message);
        }
    }

    async depositNull() {
        alert('Deposit $NULL functionality will be implemented after deployment');
    }

    async claimFaucet() {
        alert('Claim $NULL faucet functionality will be implemented after deployment');
    }

    // Wallet Generation Functionality
    generateNewWallet() {
        // Generate new Solana keypair
        const keypair = window.solanaWeb3 ? window.solanaWeb3.Keypair.generate() : null;
        if (!keypair) {
            alert('Solana Web3 library not loaded');
            return;
        }

        const publicKey = keypair.publicKey.toBase58();
        const secretKey = Array.from(keypair.secretKey);

        // Create wallet name
        const walletName = prompt('Enter a name for your new wallet:', `PDX Wallet ${Date.now()}`);

        if (!walletName) return;

        // Display wallet info
        const walletInfo = `
🎉 New Wallet Generated!

Name: ${walletName}
Address: ${publicKey}

⚠️  IMPORTANT: Save your private key securely!
Private Key: [${secretKey.join(', ')}]

This keypair will be downloaded as a JSON file.
Keep it safe - never share your private key!
        `;

        alert(walletInfo);

        // Download wallet file
        const walletData = {
            name: walletName,
            publicKey: publicKey,
            secretKey: secretKey,
            created: new Date().toISOString(),
            warning: "Never share this file or your private key!"
        };

        const blob = new Blob([JSON.stringify(walletData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${walletName.replace(/[^a-zA-Z0-9]/g, '_')}_wallet.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Copy address to clipboard
        navigator.clipboard.writeText(publicKey).then(() => {
            alert('Address copied to clipboard!');
        });
    }
}

// Initialize extension
document.addEventListener('DOMContentLoaded', () => {
    new PDXExtension();
});

// Import Solana web3 from local file
if (typeof solanaWeb3 === 'undefined') {
    // Load Solana web3 library from local file
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('solana-web3.js');
    document.head.appendChild(script);
}
