import { PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";

export interface AddressValidationResult {
    isValid: boolean;
    type: "WALLET" | "PDA" | "INVALID";
    error?: string;
    exists?: boolean;
    balance?: number;
    isSystemAccount?: boolean;
}

export const SolanaAddressValidator = {
    /**
     * OFF-LINE VALIDATION
     * Validates a Solana address using only local math.
     * ZERO network requests. ZERO metadata leaks.
     */
    validateLocal: (addressInput: string): AddressValidationResult => {
        // 1. Basic Length & Character Check (Fast Fail)
        // Solana addresses are Base58 strings, typically 32-44 chars.
        const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

        if (!addressInput) {
            return { isValid: false, type: "INVALID", error: "Address is empty" };
        }

        if (!base58Regex.test(addressInput)) {
            return { isValid: false, type: "INVALID", error: "Invalid characters or length" };
        }

        try {
            // 2. Cryptographic Parse Check
            // This attempts to decode the Base58 string into a 32-byte array.
            const pubKey = new PublicKey(addressInput);

            // 3. Curve Check (The "Ghost" Detector)
            // isOnCurve() returns true for standard wallets (Ed25519 points).
            // isOnCurve() returns false for Program Derived Addresses (PDAs).
            const onCurve = PublicKey.isOnCurve(pubKey.toBuffer());

            if (onCurve) {
                return { isValid: true, type: "WALLET" };
            } else {
                // PDAs are valid destinations but cannot sign transactions.
                // For a Privacy Relay, sending to a PDA (like a vault) is valid,
                // but usually users send to their own wallets.
                return { isValid: true, type: "PDA" };
            }

        } catch (err) {
            return { isValid: false, type: "INVALID", error: "Checksum failed (Not a valid Solana key)" };
        }
    },

    /**
     * ON-CHAIN VALIDATION
     * Checks if the address exists on Solana blockchain and gets account info.
     * This requires network access but provides richer validation.
     */
    async validateOnChain(
        addressInput: string,
        connection: Connection
    ): Promise<AddressValidationResult> {
        // First do local validation
        const localResult = this.validateLocal(addressInput);
        if (!localResult.isValid) {
            return localResult;
        }

        try {
            const pubKey = new PublicKey(addressInput);

            // Check if account exists and get balance
            const balance = await connection.getBalance(pubKey);
            const accountInfo = await connection.getAccountInfo(pubKey);

            const exists = accountInfo !== null;
            const isSystemAccount = accountInfo?.owner?.equals(new PublicKey('11111111111111111111111111111112')) || false;

            return {
                ...localResult,
                exists,
                balance: balance / LAMPORTS_PER_SOL, // Convert to SOL
                isSystemAccount
            };

        } catch (err) {
            // If on-chain check fails, return local validation result
            console.warn("On-chain validation failed, using local validation:", err);
            return localResult;
        }
    },

    /**
     * COMPREHENSIVE VALIDATION
     * Combines local and on-chain validation for complete address checking.
     */
    async validateComprehensive(
        addressInput: string,
        connection: Connection
    ): Promise<AddressValidationResult> {
        const result = await this.validateOnChain(addressInput, connection);

        // Additional validation for sending
        if (result.type === "PDA") {
            // PDAs can receive funds but might not be able to send them back
            result.error = "Warning: This is a Program Derived Address (PDA). It can receive funds but cannot sign transactions.";
        }

        return result;
    }
};
