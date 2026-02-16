// PDX STATUS CHECKER - IPFS/CRITICAL ALERT SYSTEM
// This allows warning users about critical issues without admin control over the contract

export interface StatusAlert {
    critical_alert?: string;
    warning_alert?: string;
    maintenance_mode?: boolean;
    timestamp: string;
    version: string;
}

export interface StatusCheckResult {
    safe: boolean;
    alert?: StatusAlert;
    error?: string;
}

// IPFS/Arweave hash for the status file
// Update this when deploying new status
const STATUS_FILE_CID = 'QmYourStatusFileCIDHere'; // Replace with actual IPFS CID

const STATUS_FILE_URL = `https://gateway.pinata.cloud/ipfs/${STATUS_FILE_CID}`;
// Alternative gateways for redundancy:
// const STATUS_FILE_URL = `https://arweave.net/${ARWEAVE_TX_ID}`;
// const STATUS_FILE_URL = `https://cloudflare-ipfs.com/ipfs/${STATUS_FILE_CID}`;

export const checkProtocolStatus = async (): Promise<StatusCheckResult> => {
    try {
        // Try multiple gateways for redundancy
        const gateways = [
            `https://gateway.pinata.cloud/ipfs/${STATUS_FILE_CID}`,
            `https://ipfs.io/ipfs/${STATUS_FILE_CID}`,
            `https://cloudflare-ipfs.com/ipfs/${STATUS_FILE_CID}`,
            // Add more gateways as needed
        ];

        let response: Response | null = null;
        let lastError: Error | null = null;

        for (const gateway of gateways) {
            try {
                response = await fetch(gateway, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'Cache-Control': 'no-cache'
                    },
                    // Timeout after 5 seconds per gateway
                    signal: AbortSignal.timeout(5000)
                });

                if (response.ok) {
                    break;
                }
            } catch (err) {
                lastError = err as Error;
                continue;
            }
        }

        if (!response || !response.ok) {
            // If all gateways fail, assume safe (fail-open for autonomy)
            console.warn('Status check failed, assuming safe:', lastError?.message);
            return { safe: true };
        }

        const statusData: StatusAlert = await response.json();

        // Validate status data structure
        if (!statusData.timestamp || !statusData.version) {
            console.warn('Invalid status file format');
            return { safe: true };
        }

        // Check if alert is recent (within 24 hours)
        const alertTime = new Date(statusData.timestamp);
        const now = new Date();
        const hoursSinceAlert = (now.getTime() - alertTime.getTime()) / (1000 * 60 * 60);

        if (hoursSinceAlert > 24) {
            // Old alerts are ignored (stale status)
            return { safe: true };
        }

        // If there's a critical alert, mark as unsafe
        if (statusData.critical_alert) {
            return {
                safe: false,
                alert: statusData
            };
        }

        // Maintenance mode or warnings don't block, just inform
        return {
            safe: true,
            alert: statusData
        };

    } catch (error) {
        console.warn('Status check error:', error);
        // Fail-open: if we can't check status, assume safe
        // This preserves autonomy - we don't want network issues to break the protocol
        return { safe: true };
    }
};

// Utility to create/update status file (for developers only)
export const createStatusFile = (alert: Partial<StatusAlert>): StatusAlert => {
    return {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        ...alert
    };
};
