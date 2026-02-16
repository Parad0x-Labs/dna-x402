import React from 'react';
import { AutonomyStatus } from '../hooks/useAutonomyCheck';
import { StatusCheckResult } from '../utils/statusChecker';
import './AutonomyDashboard.css';

interface AutonomyDashboardProps {
    autonomyStatus: AutonomyStatus;
    protocolStatus: StatusCheckResult;
    compact?: boolean;
}

export const AutonomyDashboard: React.FC<AutonomyDashboardProps> = ({
    autonomyStatus,
    protocolStatus,
    compact = false
}) => {
    if (compact) {
        // Compact version for header/footer
        return (
            <div className="autonomy-compact">
                <div className={`status-indicator ${autonomyStatus.safe ? 'safe' : 'unsafe'}`}>
                    {autonomyStatus.safe ? '🔒' : '⚠️'}
                </div>
                {!autonomyStatus.safe && (
                    <span className="compact-warning">UNSAFE</span>
                )}
            </div>
        );
    }

    return (
        <div className="autonomy-dashboard">
            <h3>🔐 Protocol Autonomy Status</h3>
            <p className="autonomy-subtitle">
                Trustless verification that this protocol cannot be censored or modified
            </p>

            {autonomyStatus.loading ? (
                <div className="status-loading">
                    🔍 Verifying protocol autonomy...
                </div>
            ) : (
                <>
                    {/* CRITICAL ALERTS */}
                    {protocolStatus.alert?.critical_alert && (
                        <div className="critical-alert">
                            🚨 CRITICAL ALERT: {protocolStatus.alert.critical_alert}
                            <br />
                            <small>Posted: {new Date(protocolStatus.alert.timestamp).toLocaleString()}</small>
                        </div>
                    )}

                    {/* AUTONOMY STATUS INDICATORS */}
                    <div className="status-grid">
                        <div className={`status-item ${autonomyStatus.details.immutableCode ? 'verified' : 'failed'}`}>
                            <div className="status-icon">
                                {autonomyStatus.details.immutableCode ? '✅' : '❌'}
                            </div>
                            <div className="status-content">
                                <h4>Program Authority</h4>
                                <p>
                                    {autonomyStatus.details.immutableCode
                                        ? 'Burned - Code cannot be upgraded'
                                        : 'EXISTS - Program can be modified'
                                    }
                                </p>
                            </div>
                        </div>

                        <div className={`status-item ${autonomyStatus.details.fixedSupply ? 'verified' : 'failed'}`}>
                            <div className="status-icon">
                                {autonomyStatus.details.fixedSupply ? '✅' : '❌'}
                            </div>
                            <div className="status-content">
                                <h4>$NULL Mint Authority</h4>
                                <p>
                                    {autonomyStatus.details.fixedSupply
                                        ? 'Burned - Fixed supply forever'
                                        : 'EXISTS - Can mint unlimited tokens'
                                    }
                                </p>
                            </div>
                        </div>

                        <div className={`status-item ${autonomyStatus.details.censorshipResistant ? 'verified' : 'failed'}`}>
                            <div className="status-icon">
                                {autonomyStatus.details.censorshipResistant ? '✅' : '❌'}
                            </div>
                            <div className="status-content">
                                <h4>Freeze Authority</h4>
                                <p>
                                    {autonomyStatus.details.censorshipResistant
                                        ? 'Burned - Cannot freeze user funds'
                                        : 'EXISTS - Can seize user assets'
                                    }
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* OVERALL STATUS */}
                    <div className={`overall-status ${autonomyStatus.safe ? 'autonomous' : 'controlled'}`}>
                        <h4>🔐 Protocol Status: {autonomyStatus.safe ? 'TRULY AUTONOMOUS' : 'NOT AUTONOMOUS'}</h4>
                        {autonomyStatus.safe ? (
                            <p className="autonomous-message">
                                ✅ This protocol is censorship-resistant. No admin can modify it, pause it, or mint tokens.
                                Your funds are safe from centralized control.
                            </p>
                        ) : (
                            <div className="controlled-warning">
                                ⚠️ WARNING: This protocol has admin authorities that can:
                                {!autonomyStatus.details.immutableCode && <li>Upgrade the program code</li>}
                                {!autonomyStatus.details.fixedSupply && <li>Mint unlimited $NULL tokens</li>}
                                {!autonomyStatus.details.censorshipResistant && <li>Freeze user funds</li>}
                                <p><strong>This is not a truly autonomous privacy tool.</strong></p>
                            </div>
                        )}
                    </div>

                    {/* VERIFICATION LINK */}
                    <div className="verification-section">
                        <h4>🔍 Verify Source Code</h4>
                        <p>
                            For maximum trust, verify this build matches the on-chain program:
                        </p>
                        <a
                            href={`https://explorer.solana.com/address/${process.env.REACT_APP_PROGRAM_ID}/anchor-program`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="verify-link"
                        >
                            View Verified Build on Solana Explorer →
                        </a>
                    </div>

                    {/* MAINTENANCE ALERTS */}
                    {protocolStatus.alert?.warning_alert && (
                        <div className="warning-alert">
                            ⚠️ {protocolStatus.alert.warning_alert}
                        </div>
                    )}

                    {protocolStatus.alert?.maintenance_mode && (
                        <div className="maintenance-notice">
                            🔧 Protocol is in maintenance mode. Some features may be limited.
                        </div>
                    )}
                </>
            )}

            {autonomyStatus.error && (
                <div className="autonomy-error">
                    ⚠️ Could not verify autonomy: {autonomyStatus.error}
                    <br />
                    <small>Assuming safe until verification succeeds</small>
                </div>
            )}
        </div>
    );
};
