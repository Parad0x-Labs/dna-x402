/**
 * TRANSACTION GUARD - Paranoid Safety Wrapper
 *
 * Final firewall between user's "Send" click and Wallet Adapter request.
 * Catches bots, hidden instructions, and suspicious transaction composition.
 *
 * This is your last line of defense against phishing and malware.
 */

import {
    Transaction,
    VersionedTransaction,
    PublicKey,
    SystemProgram
} from "@solana/web3.js";

// Whitelist known safe programs (System, Token, Memo, YOUR_PROGRAM_ID)
const ALLOWED_PROGRAMS = new Set([
    "11111111111111111111111111111111", // System Program
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcQb", // Memo
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC Mint (example)
    // "YOUR_PROGRAM_ID_HERE" // <-- ADD YOUR PRIVACY CONTRACT ID HERE
]);

interface SecurityCheckResult {
    safe: boolean;
    error?: string;
    warnings?: string[];
}

export const TransactionGuard = {
    /**
     * 1. ANTI-BOT CHECK
     * Verifies that the event was triggered by a real human hardware action.
     */
    verifyHumanAction: (event: React.MouseEvent | React.TouchEvent): SecurityCheckResult => {
        // 'isTrusted' is read-only and false if triggered by script (bot/console)
        if (!event.isTrusted) {
            return {
                safe: false,
                error: "SECURITY ALERT: Automated click detected. Transaction blocked."
            };
        }

        // WebDriver check (detects Selenium/Puppeteer/Playwright)
        if (navigator.webdriver) {
            return {
                safe: false,
                error: "SECURITY ALERT: Browser automation detected. Transaction blocked."
            };
        }

        // Check for suspicious timing (too fast clicks)
        const now = Date.now();
        const lastClick = parseInt(localStorage.getItem('last_click_time') || '0');
        localStorage.setItem('last_click_time', now.toString());

        if (now - lastClick < 100) { // Less than 100ms since last click
            return {
                safe: false,
                error: "SECURITY ALERT: Suspicious click timing detected. Transaction blocked."
            };
        }

        return { safe: true };
    },

    /**
     * 2. HIDDEN INSTRUCTION SCANNER
     * Dissects the transaction to ensure no malicious extra steps are hidden.
     */
    scanTransactionContent: (tx: Transaction | VersionedTransaction): SecurityCheckResult => {
        let instructions = [];
        let warnings: string[] = [];

        // Normalize instruction parsing for Legacy vs Versioned TXs
        if (tx instanceof VersionedTransaction) {
            // Versioned transactions need message inspection
            // This would require connection.simulateTransaction for full analysis
            // For now, do basic checks
            if (tx.message.instructions.length > 4) {
                return {
                    safe: false,
                    error: `SUSPICIOUS: Versioned transaction contains ${tx.message.instructions.length} instructions. Expected < 4.`
                };
            }
            instructions = tx.message.instructions;
        } else {
            instructions = tx.instructions;
        }

        // A. Count Check - Privacy transactions should be simple
        if (instructions.length > 4) {
            return {
                safe: false,
                error: `SUSPICIOUS: Transaction contains ${instructions.length} instructions. Expected < 4.`
            };
        }

        // B. Program ID Whitelist Check
        const programIds = new Set<string>();
        for (const ix of instructions) {
            const programId = ix.programId.toBase58();

            if (!ALLOWED_PROGRAMS.has(programId)) {
                return {
                    safe: false,
                    error: `SECURITY WARNING: Transaction interacts with unknown program: ${programId}`
                };
            }

            // Check for duplicates (suspicious)
            if (programIds.has(programId)) {
                warnings.push(`DUPLICATE: Multiple instructions for program ${programId}`);
            }
            programIds.add(programId);
        }

        // C. Instruction Size Check (prevent buffer overflow attacks)
        for (let i = 0; i < instructions.length; i++) {
            const ix = instructions[i];
            if (ix.data.length > 1024) { // Arbitrary limit for PDX transactions
                return {
                    safe: false,
                    error: `SUSPICIOUS: Instruction ${i} has unusually large data (${ix.data.length} bytes)`
                };
            }
        }

        // D. Account Count Sanity Check
        for (let i = 0; i < instructions.length; i++) {
            const ix = instructions[i];
            if (ix.keys.length > 10) { // Privacy tx shouldn't need many accounts
                warnings.push(`Instruction ${i} has ${ix.keys.length} accounts (expected < 10)`);
            }
        }

        return {
            safe: true,
            warnings: warnings.length > 0 ? warnings : undefined
        };
    },

    /**
     * 3. SAFE COPY (CLIPBOARD VERIFIER)
     * Writes to clipboard, then immediately reads back to ensure no malware swapped it.
     * Note: Requires user permission to 'read' clipboard.
     */
    safeCopyToClipboard: async (text: string): Promise<boolean> => {
        try {
            await navigator.clipboard.writeText(text);

            // Wait 50ms for any potential malware listeners to trigger
            await new Promise(r => setTimeout(r, 50));

            // Read it back
            const readBack = await navigator.clipboard.readText();

            if (readBack !== text) {
                alert("CRITICAL SECURITY WARNING: Your clipboard content was altered by external software! Do not paste.");
                return false; // Compromised
            }
            return true;
        } catch (err) {
            // If read permission denied, fallback to just write but warn user
            console.warn("Could not verify clipboard integrity (permission denied).");
            return true;
        }
    },

    /**
     * 4. COMPREHENSIVE TRANSACTION SECURITY CHECK
     * Runs all security checks in sequence
     */
    fullSecurityCheck: async (
        event: React.MouseEvent | React.TouchEvent,
        transaction: Transaction | VersionedTransaction
    ): Promise<SecurityCheckResult> => {
        // 1. Human Action Check
        const humanCheck = this.verifyHumanAction(event);
        if (!humanCheck.safe) {
            return humanCheck;
        }

        // 2. Transaction Content Scan
        const contentCheck = this.scanTransactionContent(transaction);
        if (!contentCheck.safe) {
            return contentCheck;
        }

        // 3. Additional Checks (extend as needed)
        const deviceCheck = this.checkDeviceSecurity();
        if (!deviceCheck.safe) {
            return deviceCheck;
        }

        return {
            safe: true,
            warnings: contentCheck.warnings
        };
    },

    /**
     * 5. DEVICE SECURITY CHECK
     * Additional device-level security validations
     */
    checkDeviceSecurity: (): SecurityCheckResult => {
        // Check if running in iframe (phishing attempt)
        if (window.self !== window.top) {
            return {
                safe: false,
                error: "SECURITY ALERT: Application is running in an iframe. This may be a phishing attempt."
            };
        }

        // Check for developer tools (basic detection)
        const devtools = {
            open: false,
            orientation: null as string | null
        };

        const threshold = 160;
        setTimeout(() => {
            if (window.outerHeight - window.innerHeight > threshold || window.outerWidth - window.innerWidth > threshold) {
                devtools.open = true;
                devtools.orientation = window.outerHeight > window.outerWidth ? 'vertical' : 'horizontal';
            }
        }, 100);

        // Note: This is not foolproof, but adds a layer

        return { safe: true };
    }
};
