/**
 * Session Manager - Forces disconnection after transactions
 * PDX Privacy Relay is for single-use transfers only
 */

export class SessionManager {
  private static readonly SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private static readonly TX_COMPLETION_TIMEOUT = 30 * 1000; // 30 seconds after tx

  static startSession(): void {
    const sessionData = {
      startTime: Date.now(),
      lastActivity: Date.now(),
      transactionsCompleted: 0,
      shouldDisconnect: false
    };

    localStorage.setItem('pdx_session', JSON.stringify(sessionData));
    console.log('[Session] Privacy transfer session started');
  }

  static updateActivity(): void {
    const session = this.getSession();
    if (session) {
      session.lastActivity = Date.now();
      localStorage.setItem('pdx_session', JSON.stringify(session));
    }
  }

  static recordTransaction(): void {
    const session = this.getSession();
    if (session) {
      session.transactionsCompleted++;
      session.shouldDisconnect = true;
      localStorage.setItem('pdx_session', JSON.stringify(session));
      console.log(`[Session] Transaction completed. Total: ${session.transactionsCompleted}`);

      // Schedule forced disconnection
      setTimeout(() => {
        this.forceDisconnect();
      }, this.TX_COMPLETION_TIMEOUT);
    }
  }

  static shouldForceDisconnect(): boolean {
    const session = this.getSession();
    if (!session) return false;

    const now = Date.now();
    const timeSinceStart = now - session.startTime;
    const timeSinceActivity = now - session.lastActivity;

    // Force disconnect after transaction completion
    if (session.shouldDisconnect) return true;

    // Force disconnect after timeout
    if (timeSinceStart > this.SESSION_TIMEOUT) return true;

    // Force disconnect after inactivity
    if (timeSinceActivity > (2 * 60 * 1000)) return true; // 2 minutes inactivity

    return false;
  }

  static forceDisconnect(): void {
    console.log('[Session] Forcing disconnection - Privacy transfer complete');

    // Clear all PDX-related data
    this.clearSession();

    // Show disconnection modal
    this.showDisconnectModal();
  }

  static clearSession(): void {
    localStorage.removeItem('pdx_session');
    localStorage.removeItem('pdx_terms_accepted');
    localStorage.removeItem('pdx_terms_timestamp');

    // Clear any cached transaction data
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith('pdx_')) {
        localStorage.removeItem(key);
      }
    });

    // Clear clipboard after sensitive operations
    this.nukeClipboard();

    // Clear IndexedDB artifacts
    this.clearIndexedDB();

    // Clear any proof-related data from memory
    this.clearMemoryArtifacts();
  }

  /**
   * Nuke clipboard after sensitive operations (60 second delay)
   */
  static nukeClipboard(): void {
    setTimeout(() => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText('').catch(() => {
          // Silent fail - clipboard API may be restricted
        });
      }
    }, 60000); // 60 seconds
  }

  /**
   * Clear IndexedDB artifacts that might contain proof data
   */
  static clearIndexedDB(): void {
    try {
      // Clear any PDX-related IndexedDB databases
      const deleteRequest = indexedDB.deleteDatabase('pdx-privacy-relay');
      deleteRequest.onerror = () => console.warn('IndexedDB cleanup failed');
      deleteRequest.onsuccess = () => console.log('IndexedDB artifacts cleared');
    } catch (error) {
      // Silent fail - IndexedDB may not be available
    }
  }

  /**
   * Clear memory artifacts (proof data, etc.)
   */
  static clearMemoryArtifacts(): void {
    // Force garbage collection hints
    if (window.gc) {
      window.gc();
    }

    // Clear any global references to sensitive data
    // (Implementation depends on your specific data structures)
  }

  private static getSession(): any {
    try {
      const sessionStr = localStorage.getItem('pdx_session');
      return sessionStr ? JSON.parse(sessionStr) : null;
    } catch {
      return null;
    }
  }

  private static showDisconnectModal(): void {
    // Create and show disconnect modal
    const modal = document.createElement('div');
    modal.innerHTML = `
      <div style="
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      ">
        <div style="
          background: white;
          padding: 30px;
          border-radius: 15px;
          text-align: center;
          max-width: 400px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        ">
          <div style="font-size: 48px; margin-bottom: 20px;">✅</div>
          <h2 style="color: #28a745; margin: 0 0 15px 0;">Privacy Transfer Complete!</h2>
          <p style="margin: 0 0 25px 0; color: #666;">
            Your private transaction has been processed successfully.
            For your security, this session will now close.
          </p>
          <div style="
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            border-left: 4px solid #dc3545;
          ">
            <strong>Security Reminder:</strong><br>
            Always disconnect after transfers.<br>
            Never store funds in transfer tools.
          </div>
          <button onclick="window.location.reload()" style="
            background: #007bff;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
          ">
            Close Session & Return to Wallet
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  static checkTermsAccepted(): boolean {
    const accepted = localStorage.getItem('pdx_terms_accepted');
    const timestamp = localStorage.getItem('pdx_terms_timestamp');

    if (!accepted || !timestamp) return false;

    // Terms expire after 24 hours
    const termsAge = Date.now() - parseInt(timestamp);
    if (termsAge > 24 * 60 * 60 * 1000) {
      this.clearSession();
      return false;
    }

    return accepted === 'true';
  }
}
