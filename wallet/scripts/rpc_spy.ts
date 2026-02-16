import puppeteer, { HTTPRequest } from 'puppeteer';

// CONFIGURATION
const APP_URL = 'http://localhost:3000'; // Your local frontend
const SECRET_RECIPIENT = '88888888888888888888888888888888888888888888'; // A distinct fake address
const ALLOWED_ENDPOINTS = ['/api/relayer-proxy']; // If you have a backend proxy, whitelist it here

(async () => {
    console.log("🕵️  STARTING RPC SPY: Monitoring Network Traffic...");

    // 1. Launch Headless Browser
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox']
    });
    const page = await browser.newPage();

    // 2. Setup The Network Sniffer
    let leakDetected = false;
    await page.setRequestInterception(true);

    page.on('request', (request: HTTPRequest) => {
        const url = request.url();
        const postData = request.postData();

        // Check if the request is going to a Public RPC (e.g., Helius, Alchemy, Solana)
        const isPublicRpc = url.includes('solana.com') || url.includes('helius') || url.includes('alchemy') || url.includes('quicknode');

        if (isPublicRpc && postData) {
            // THE TRAP: Does the payload contain our Secret Address?
            if (postData.includes(SECRET_RECIPIENT)) {
                console.error(`\n🚨 CRITICAL LEAK DETECTED! 🚨`);
                console.error(`   Dest: ${url}`);
                console.error(`   Payload: ${postData.slice(0, 200)}...`);
                console.error(`   Reason: The frontend sent the Secret Recipient address directly to a Public RPC.`);
                leakDetected = true;
            }
        }

        request.continue();
    });

    try {
        // 3. Navigate to App
        console.log(`   Navigating to ${APP_URL}...`);
        await page.goto(APP_URL, { waitUntil: 'networkidle0' });

        // 4. Simulate User Input
        // Replace 'input[name="recipient"]' with your actual CSS selector
        const selector = 'input[type="text"]';
        console.log(`   Typing Secret Address into ${selector}...`);

        await page.waitForSelector(selector);
        await page.type(selector, SECRET_RECIPIENT);

        // 5. Wait for "Reactive" Hooks to Fire
        console.log("   Waiting 5 seconds for React hooks to trigger auto-fetches...");
        await new Promise(r => setTimeout(r, 5000));

    } catch (err) {
        console.error("   Test Error:", err);
    } finally {
        await browser.close();
    }

    // 6. Final Report
    if (leakDetected) {
        console.log("\n❌ TEST FAILED: Your app is leaking metadata.");
        process.exit(1);
    } else {
        console.log("\n✅ TEST PASSED: No RPC leaks detected for the recipient address.");
        process.exit(0);
    }
})();
