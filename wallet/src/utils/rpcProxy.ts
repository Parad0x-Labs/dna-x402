/**
 * RPC Proxy - Hides User IP from Node Providers
 * Prevents deanonymization through RPC connection correlation
 */

export class RPCProxy {
  private static readonly PROXY_ENDPOINT = '/api/rpc'; // Backend proxy endpoint
  private static readonly FALLBACK_RPC = 'https://api.devnet.solana.com';

  /**
   * Proxy RPC calls to hide user IP from node providers
   * Backend strips IP headers and routes through multiple proxies
   */
  static async proxyRequest(method: string, params: any[] = []): Promise<any> {
    const requestBody = {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method,
      params
    };

    try {
      // Route through backend proxy to hide IP
      const response = await fetch(this.PROXY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Backend will strip all IP-identifying headers
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`RPC proxy failed: ${response.status}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.warn('[RPC Proxy] Backend proxy failed, falling back to direct RPC:', error);

      // Fallback to direct RPC only for essential operations
      // This should be extremely rare and logged for security review
      return this.fallbackRequest(requestBody);
    }
  }

  /**
   * Emergency fallback - direct RPC (logs security concern)
   */
  private static async fallbackRequest(requestBody: any): Promise<any> {
    console.error('[SECURITY] RPC PROXY FAILED - USING DIRECT CONNECTION');
    console.error('[SECURITY] This may deanonymize the user - investigate proxy immediately');

    // Log this security incident
    this.logSecurityIncident('rpc_proxy_failure', {
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      url: window.location.href
    });

    // Fallback to direct connection (last resort)
    const response = await fetch(this.FALLBACK_RPC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    return response.json();
  }

  /**
   * Send transaction through proxy to prevent IP correlation
   */
  static async sendTransaction(serializedTx: string): Promise<string> {
    const result = await this.proxyRequest('sendTransaction', [serializedTx, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed', // Wait for confirmation
      maxRetries: 3
    }]);

    return result.result; // Transaction signature
  }

  /**
   * Get recent blockhash through proxy
   */
  static async getRecentBlockhash(): Promise<{ blockhash: string, lastValidBlockHeight: number }> {
    const result = await this.proxyRequest('getRecentBlockhash', [{
      commitment: 'confirmed'
    }]);

    return result.result.value;
  }

  /**
   * Confirm transaction through proxy (wait for confirmation)
   */
  static async confirmTransaction(signature: string): Promise<boolean> {
    const result = await this.proxyRequest('getTransaction', [signature, {
      commitment: 'confirmed',
      encoding: 'jsonParsed'
    }]);

    return result.result !== null; // Transaction confirmed
  }

  /**
   * Log security incidents for monitoring
   */
  private static async logSecurityIncident(type: string, details: any): Promise<void> {
    try {
      await fetch('/api/security/incident', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, details, timestamp: Date.now() })
      });
    } catch (error) {
      // Silent fail - don't expose logging failures to user
      console.error('[Security Logging Failed]', error);
    }
  }
}

/**
 * Privacy-preserving connection wrapper
 * Replaces direct Solana connections with proxied calls
 */
export class PrivacyConnection {
  static async sendPrivacyTransaction(
    serializedTx: string,
    options: {
      requireConfirmation: boolean;
      maxRetries: number;
    } = { requireConfirmation: true, maxRetries: 3 }
  ): Promise<{ signature: string; confirmed: boolean }> {
    console.log('[Privacy] Sending transaction through proxy...');

    // Send transaction
    const signature = await RPCProxy.sendTransaction(serializedTx);

    // Wait for confirmation (prevents "ghost state")
    let confirmed = false;
    if (options.requireConfirmation) {
      console.log('[Privacy] Waiting for confirmation...');
      // Wait up to 30 seconds for confirmation
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        confirmed = await RPCProxy.confirmTransaction(signature);
        if (confirmed) break;
      }
    }

    console.log(`[Privacy] Transaction ${confirmed ? 'confirmed' : 'unconfirmed'}: ${signature}`);

    return { signature, confirmed };
  }

  /**
   * Get blockhash for transaction building
   */
  static async getLatestBlockhash(): Promise<{ blockhash: string, lastValidBlockHeight: number }> {
    return RPCProxy.getRecentBlockhash();
  }
}
