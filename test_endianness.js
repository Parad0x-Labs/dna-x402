// PDX Dark Protocol - Endianness Testing Script
// Test snarkjs proof compatibility with Rust contract

const { groth16 } = require('snarkjs');
const fs = require('fs');

async function testEndianness() {
    console.log('🔍 Testing snarkjs → Rust endianness compatibility...\n');

    try {
        // Load your circuit files (adjust paths as needed)
        const wasmPath = './circuits/dark_transfer_js/dark_transfer.wasm';
        const zkeyPath = './circuits/dark_transfer.zkey';

        if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
            console.log('⚠️  Circuit files not found. Generate them first:');
            console.log('   npx snarkjs groth16 setup');
            console.log('   npx snarkjs zkey export solidityverifier');
            return;
        }

        // Example inputs (adjust for your circuit)
        const inputs = {
            root: "0x" + "11".repeat(32), // 32 bytes
            nullifierAsset: "0x" + "22".repeat(32),
            nullifierFee: "0x" + "33".repeat(32),
            newCommitment: "0x" + "44".repeat(32),
            assetIdHash: "0x" + "55".repeat(32)
        };

        console.log('📝 Generating proof with snarkjs...');

        // Generate proof
        const { proof, publicSignals } = await groth16.fullProve(
            inputs,
            wasmPath,
            zkeyPath
        );

        console.log('✅ Proof generated successfully');

        // Convert proof to bytes (snarkjs format)
        const proofBytes = proofToBytes(proof);
        console.log(`📏 Proof size: ${proofBytes.length} bytes (expected: 256)`);

        // Log public signals in different endianness
        console.log('\n🔢 Public Signals Analysis:');
        publicSignals.forEach((signal, i) => {
            const hex = BigInt(signal).toString(16).padStart(64, '0');
            const bytes = Buffer.from(hex, 'hex');

            console.log(`Signal ${i}:`);
            console.log(`  Big Endian (snarkjs):  ${bytes.toString('hex')}`);
            console.log(`  Little Endian (Rust): ${Buffer.from(bytes).reverse().toString('hex')}`);
        });

        console.log('\n📋 Testing Instructions:');
        console.log('1. Copy the proof bytes to your Rust test');
        console.log('2. If verification fails in Rust, uncomment: bytes.reverse()');
        console.log('3. Rebuild and test again');

        console.log('\n🔐 Proof Bytes (for Rust testing):');
        console.log('[' + Array.from(proofBytes).join(', ') + ']');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.log('\n💡 Setup required:');
        console.log('1. Install snarkjs: npm install -g snarkjs');
        console.log('2. Compile your Circom circuit');
        console.log('3. Generate trusted setup');
    }
}

function proofToBytes(proof) {
    // Convert snarkjs proof format to flat bytes
    // This depends on your exact proof format - adjust as needed

    const a = hexToBytes(proof.pi_a[0]) + hexToBytes(proof.pi_a[1]);
    const b = hexToBytes(proof.pi_b[0]) + hexToBytes(proof.pi_b[1]);
    const c = hexToBytes(proof.pi_c[0]) + hexToBytes(proof.pi_c[1]);

    return Buffer.concat([a, b, c]);
}

function hexToBytes(hex) {
    // Remove 0x prefix if present
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    // Pad to 64 characters (32 bytes)
    const padded = cleanHex.padStart(64, '0');
    return Buffer.from(padded, 'hex');
}

// Run the test
testEndianness().catch(console.error);
