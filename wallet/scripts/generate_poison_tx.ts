/**
 * RED TEAM SCRIPT - Generate Poisoned Transactions
 *
 * Creates malicious transaction bundles to test TransactionGuard.
 * Run this script locally to verify your security layer works.
 */

import {
    Connection,
    Keypair,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    PublicKey
} from "@solana/web3.js";
import { TransactionGuard } from "../src/utils/TransactionGuard";

async function runRedTeamSimulation() {
    console.log("😈 RED TEAM: Constructing Poisoned Transactions...");
    console.log("🛡️ Testing TransactionGuard security layer\n");

    const connection = new Connection("https://api.devnet.solana.com");
    const victim = Keypair.generate();
    const attacker = Keypair.generate();
    const pdxProgramId = new PublicKey("11111111111111111111111111111112"); // Mock PDX program

    // ============================================================================
    // TEST 1: CLASSIC COMPOSITION ATTACK (Hidden Drain)
    // ============================================================================
    console.log("🧪 TEST 1: Hidden Drain Attack");
    console.log("A legitimate PDX instruction bundled with a fund drain\n");

    // Instruction A: "Legitimate" PDX Privacy Transfer (user thinks this is safe)
    const legitimatePdxIx = new TransactionInstruction({
        programId: pdxProgramId,
        keys: [
            { pubkey: victim.publicKey, isSigner: true, isWritable: true },
            // Mock PDX accounts
        ],
        data: Buffer.from([1, 0, 0, 0]) // Mock "privacy transfer" instruction
    });

    // Instruction B: HIDDEN ATTACK - Drain 1 SOL to attacker
    const hiddenDrainIx = SystemProgram.transfer({
        fromPubkey: victim.publicKey,
        toPubkey: attacker.publicKey,
        lamports: 1_000_000_000 // 1 SOL theft
    });

    // BUNDLE THEM - This is the phishing site's malicious payload
    const poisonTx1 = new Transaction().add(legitimatePdxIx).add(hiddenDrainIx);

    // TEST THE GUARD
    const guardResult1 = TransactionGuard.scanTransactionContent(poisonTx1);

    if (guardResult1.safe) {
        console.log("❌ FAILURE: Guard missed the hidden drain instruction!");
        console.log("🚨 CRITICAL: Users would be robbed!");
    } else {
        console.log("✅ SUCCESS: Guard caught the attack!");
        console.log(`   Reason: "${guardResult1.error}"`);
    }

    console.log("");

    // ============================================================================
    // TEST 2: INSTRUCTION SPAM ATTACK
    // ============================================================================
    console.log("🧪 TEST 2: Instruction Spam Attack");
    console.log("Too many instructions (suspicious bot behavior)\n");

    const spamTx = new Transaction();

    // Add 10 suspicious instructions (way too many for a simple transfer)
    for (let i = 0; i < 10; i++) {
        const spamIx = SystemProgram.transfer({
            fromPubkey: victim.publicKey,
            toPubkey: attacker.publicKey,
            lamports: 1_000_000 // Small amounts to avoid attention
        });
        spamTx.add(spamIx);
    }

    const guardResult2 = TransactionGuard.scanTransactionContent(spamTx);

    if (guardResult2.safe) {
        console.log("❌ FAILURE: Guard allowed instruction spam!");
    } else {
        console.log("✅ SUCCESS: Guard blocked instruction spam!");
        console.log(`   Reason: "${guardResult2.error}"`);
    }

    console.log("");

    // ============================================================================
    // TEST 3: UNKNOWN PROGRAM ATTACK
    // ============================================================================
    console.log("🧪 TEST 3: Unknown Program Attack");
    console.log("Transaction interacts with unauthorized program\n");

    const unknownProgram = new PublicKey("99999999999999999999999999999999"); // Fake program
    const unknownIx = new TransactionInstruction({
        programId: unknownProgram,
        keys: [
            { pubkey: victim.publicKey, isSigner: true, isWritable: true },
        ],
        data: Buffer.from([0])
    });

    const unknownTx = new Transaction().add(unknownIx);
    const guardResult3 = TransactionGuard.scanTransactionContent(unknownTx);

    if (guardResult3.safe) {
        console.log("❌ FAILURE: Guard allowed unknown program interaction!");
    } else {
        console.log("✅ SUCCESS: Guard blocked unknown program!");
        console.log(`   Reason: "${guardResult3.error}"`);
    }

    console.log("");

    // ============================================================================
    // TEST 4: HUMAN VERIFICATION BYPASS
    // ============================================================================
    console.log("🧪 TEST 4: Human Verification (Mock Test)");
    console.log("This would test isTrusted event validation\n");

    // Create a mock event that looks like a real click
    const mockRealEvent = {
        isTrusted: true,
        type: 'click',
        target: document.createElement('button')
    } as React.MouseEvent;

    const humanResult1 = TransactionGuard.verifyHumanAction(mockRealEvent);
    console.log(humanResult1.safe ? "✅ Human action verified" : `❌ Human check failed: ${humanResult1.error}`);

    // Create a mock bot event
    const mockBotEvent = {
        isTrusted: false, // This would be set by browser automation
        type: 'click',
        target: document.createElement('button')
    } as React.MouseEvent;

    const humanResult2 = TransactionGuard.verifyHumanAction(mockBotEvent);
    console.log(humanResult2.safe ? "❌ Bot bypassed human check!" : `✅ Bot correctly blocked: ${humanResult2.error}`);

    console.log("");

    // ============================================================================
    // SUMMARY
    // ============================================================================
    console.log("🎯 RED TEAM ASSESSMENT COMPLETE");
    console.log("================================");
    console.log("");
    console.log("These tests demonstrate why TransactionGuard is essential:");
    console.log("• Solana allows dangerous transaction composition by design");
    console.log("• Phishing sites can bundle legitimate + malicious instructions");
    console.log("• Only frontend validation can prevent these attacks");
    console.log("• Your TransactionGuard is the critical security layer!");
    console.log("");
    console.log("💡 Next: Test with real phishing payloads and edge cases");
}

// Export for use in other scripts
export { runRedTeamSimulation };

// Run if called directly
if (require.main === module) {
    runRedTeamSimulation().catch(console.error);
}
