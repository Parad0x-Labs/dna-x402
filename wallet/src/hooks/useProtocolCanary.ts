import { useState, useEffect } from 'react';

// HOSTING OPTIONS (Pick one or use multiple for redundancy):
// 1. IPFS via IPNS (Truly decentralized) -> "https://ipfs.io/ipns/your-ipns-hash"
// 2. GitHub Raw (Fast & Immutable history) -> "https://raw.githubusercontent.com/your-org/status/main/status.json"
// 3. Arweave -> "https://arweave.net/tx-id"

// For initial deployment, we'll use GitHub Raw for simplicity
// TODO: Replace with your actual GitHub repo or IPFS hash
const CANARY_URL = "https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPO/main/status.json";

interface CanaryStatus {
    status: "operational" | "critical" | "maintenance";
    message: string;
    recommended_version: string;
    critical_alert: boolean;
    timestamp?: string;
}

interface CanaryResult {
    isSafe: boolean;
    alertMessage: string;
    loading: boolean;
    status: CanaryStatus | null;
}

export const useProtocolCanary = (): CanaryResult => {
    const [isSafe, setIsSafe] = useState(true);
    const [alertMessage, setAlertMessage] = useState("");
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<CanaryStatus | null>(null);

    useEffect(() => {
        const checkCanary = async () => {
            try {
                // Add timestamp to prevent browser caching
                const response = await fetch(`${CANARY_URL}?t=${Date.now()}`, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'Cache-Control': 'no-cache'
                    },
                    // Timeout after 10 seconds
                    signal: AbortSignal.timeout(10000)
                });

                if (!response.ok) {
                    // If the status file is unreachable, assume safe (fail-open)
                    // This preserves the autonomous nature - we don't want network issues to break the protocol
                    console.warn("Canary file unreachable, assuming safe");
                    setIsSafe(true);
                    setAlertMessage("");
                    setStatus(null);
                    return;
                }

                const data: CanaryStatus = await response.json();

                // Store the status for debugging
                setStatus(data);

                // Check for critical alerts
                if (data.critical_alert === true) {
                    setIsSafe(false);
                    setAlertMessage(data.message || "Critical protocol alert active. Deposits disabled for safety.");
                } else {
                    setIsSafe(true);
                    setAlertMessage("");
                }

            } catch (err) {
                console.error("Canary check failed:", err);
                // Fail-open: if the check fails, we default to allowing operation
                // This is safer than failing closed, as network issues shouldn't break the protocol
                setIsSafe(true);
                setAlertMessage("");
                setStatus(null);
            } finally {
                setLoading(false);
            }
        };

        checkCanary();

        // Re-check every 5 minutes (300 seconds)
        const interval = setInterval(checkCanary, 300000);
        return () => clearInterval(interval);

    }, []);

    return { isSafe, alertMessage, loading, status };
};
