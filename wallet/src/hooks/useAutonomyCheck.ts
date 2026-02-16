import { useState, useEffect } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';

export interface AutonomyStatus {
    safe: boolean;
    loading: boolean;
    error?: string;
    details: {
        immutableCode: boolean;
        fixedSupply: boolean;
        censorshipResistant: boolean;
    };
}

export const verifyAutonomy = async (
    connection: Connection,
    programId: PublicKey,
    tokenMint: PublicKey
): Promise<AutonomyStatus> => {
    try {
        // 1. CHECK PROGRAM IMMUTABILITY
        // Fetch the BPF Loader data for your program ID
        const accountInfo = await connection.getParsedAccountInfo(programId);
        const programData = (accountInfo.value?.data as any)?.parsed?.info;

        // In Solana, if 'authority' is null, it's immutable.
        // If it's a Squads address, it's multisig (Partial Trust).
        const isCodeMutable = programData?.authority !== null;

        // 2. CHECK TOKEN MINT (The $NULL Token)
        const mintInfo = await connection.getParsedAccountInfo(tokenMint);
        const mintData = (mintInfo.value?.data as any)?.parsed?.info;

        const canMintMore = mintData?.mintAuthority !== null;
        const canFreeze = mintData?.freezeAuthority !== null;

        const safe = !isCodeMutable && !canMintMore && !canFreeze;

        return {
            safe,
            loading: false,
            details: {
                immutableCode: !isCodeMutable,
                fixedSupply: !canMintMore,
                censorshipResistant: !canFreeze
            }
        };
    } catch (err) {
        return {
            safe: false,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to verify autonomy',
            details: {
                immutableCode: false,
                fixedSupply: false,
                censorshipResistant: false
            }
        };
    }
};

export const useAutonomyCheck = (
    connection: Connection,
    programId: PublicKey,
    tokenMint: PublicKey
): AutonomyStatus => {
    const [status, setStatus] = useState<AutonomyStatus>({
        safe: false,
        loading: true,
        details: {
            immutableCode: false,
            fixedSupply: false,
            censorshipResistant: false
        }
    });

    useEffect(() => {
        const checkAutonomy = async () => {
            const result = await verifyAutonomy(connection, programId, tokenMint);
            setStatus(result);
        };

        checkAutonomy();

        // Re-check every 30 seconds (less frequent than program state checks)
        const interval = setInterval(checkAutonomy, 30000);
        return () => clearInterval(interval);
    }, [connection, programId, tokenMint]);

    return status;
};
