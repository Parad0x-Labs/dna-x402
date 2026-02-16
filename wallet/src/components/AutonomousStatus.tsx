import React, { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { PDX_PROGRAM_ID, NULL_TOKEN_MINT } from '../constants/protocol';

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

interface AutonomyState {
    codeImmutable: boolean;
    mintLocked: boolean;
    noFreeze: boolean;
    loading: boolean;
}

interface AutonomousStatusProps {
    connection: Connection;
}

export const AutonomousStatus: React.FC<AutonomousStatusProps> = ({ connection }) => {
    const [status, setStatus] = useState<AutonomyState>({
        codeImmutable: false,
        mintLocked: false,
        noFreeze: false,
        loading: true,
    });

    useEffect(() => {
        const checkChain = async () => {
            try {
                // 1. CHECK PROGRAM AUTHORITY (IMMUTABILITY)
                // We fetch the "ProgramData" account (PDA of the program)
                const [programDataAddress] = PublicKey.findProgramAddressSync(
                    [PDX_PROGRAM_ID.toBuffer()],
                    BPF_LOADER_UPGRADEABLE
                );

                const programAccount = await connection.getParsedAccountInfo(programDataAddress);
                const parsedInfo = (programAccount.value?.data as any)?.parsed?.info;

                // If authority is null, the code is immutable.
                const isImmutable = parsedInfo?.authority === null || parsedInfo?.authority === undefined;

                // 2. CHECK TOKEN AUTHORITIES
                const mintAccount = await connection.getParsedAccountInfo(NULL_TOKEN_MINT);
                const mintInfo = (mintAccount.value?.data as any)?.parsed?.info;

                const isMintLocked = mintInfo?.mintAuthority === null;
                const isNoFreeze = mintInfo?.freezeAuthority === null;

                setStatus({
                    codeImmutable: isImmutable,
                    mintLocked: isMintLocked,
                    noFreeze: isNoFreeze,
                    loading: false
                });
            } catch (err) {
                console.error("Autonomy check failed:", err);
                setStatus(prev => ({ ...prev, loading: false }));
            }
        };

        checkChain();
    }, [connection]);

    if (status.loading) return (
        <div className="text-xs text-gray-500 animate-pulse">
            🔍 Verifying Protocol Autonomy...
        </div>
    );

    return (
        <div className="bg-black border border-gray-800 rounded-lg p-4 max-w-sm">
            <h3 className="text-gray-400 text-xs uppercase tracking-widest font-bold mb-3 border-b border-gray-800 pb-2">
                🔐 Protocol Autonomy Status
            </h3>

            <div className="space-y-2">
                {/* 1. CODE CHECK */}
                <StatusRow
                    label="Smart Contract Code"
                    isValid={status.codeImmutable}
                    successText="IMMUTABLE (Keys Burned)"
                    failText="MUTABLE (Admin Active)"
                />

                {/* 2. MINT CHECK */}
                <StatusRow
                    label="$NULL Token Supply"
                    isValid={status.mintLocked}
                    successText="FIXED (Minting Disabled)"
                    failText="UNLOCKED (Inflation Risk)"
                />

                {/* 3. FREEZE CHECK */}
                <StatusRow
                    label="Censorship Resistance"
                    isValid={status.noFreeze}
                    successText="PERMANENT (No Freeze Key)"
                    failText="CENTRALIZED (Freeze Active)"
                />
            </div>

            {/* Global Trust Badge */}
            <div className={`mt-4 text-center text-xs font-mono py-1 rounded ${
                status.codeImmutable && status.mintLocked && status.noFreeze
                ? "bg-green-900/30 text-green-400 border border-green-900"
                : "bg-red-900/30 text-red-400 border border-red-900"
            }`}>
                {status.codeImmutable && status.mintLocked && status.noFreeze
                    ? "🛡️ 100% AUTONOMOUS"
                    : "⚠️ PARTIALLY CENTRALIZED"}
            </div>

            {/* Verify Source Link */}
            <div className="mt-3 text-center">
                <a
                    href={`https://explorer.solana.com/address/${PDX_PROGRAM_ID.toString()}/anchor-program`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:text-blue-300 underline"
                >
                    🔍 View Verified Build →
                </a>
            </div>
        </div>
    );
};

// Helper Component for the Rows
const StatusRow = ({ label, isValid, successText, failText }: any) => (
    <div className="flex justify-between items-center text-sm">
        <span className="text-gray-300">{label}</span>
        <div className="flex items-center gap-2">
            <span className={`text-xs font-mono ${isValid ? "text-green-500" : "text-red-500"}`}>
                {isValid ? successText : failText}
            </span>
            {isValid ? (
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
            ) : (
                <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
            )}
        </div>
    </div>
);
