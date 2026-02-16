import React from 'react';
import { useProtocolCanary } from '../hooks/useProtocolCanary';

interface ProtocolCanaryProps {
    children: React.ReactNode;
}

export const ProtocolCanary: React.FC<ProtocolCanaryProps> = ({ children }) => {
    const { isSafe, alertMessage, loading } = useProtocolCanary();

    // Loading State (Optional, maybe just a spinner)
    if (loading) {
        return (
            <div className="fixed inset-0 bg-black flex items-center justify-center">
                <div className="text-white text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
                    <p>🔍 Checking Protocol Status...</p>
                </div>
            </div>
        );
    }

    // THE EMERGENCY LOCK
    if (!isSafe) {
        return (
            <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
                <div className="bg-red-900/20 border border-red-500 rounded-lg p-8 max-w-lg text-center">
                    <h1 className="text-3xl font-bold text-red-500 mb-4">
                        🚫 PROTOCOL ALERT
                    </h1>
                    <p className="text-white text-lg mb-6">
                        {alertMessage}
                    </p>
                    <div className="bg-black/50 p-4 rounded text-sm text-gray-400 font-mono">
                        The frontend has detected a critical advisory.
                        Deposit interfaces are disabled for your safety.
                    </div>

                    {/* OPTIONAL: Allow "Withdraw Only" mode here */}
                    <div className="mt-6 space-y-2">
                        <button className="w-full border border-gray-600 px-4 py-2 rounded text-gray-400 hover:text-white hover:border-gray-400 transition-colors">
                            Enter Withdraw-Only Mode
                        </button>
                        <p className="text-xs text-gray-500 mt-2">
                            Withdrawals remain available for existing funds
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // Normal App
    return <>{children}</>;
};
