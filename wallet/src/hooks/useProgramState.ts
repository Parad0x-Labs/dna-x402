import { useState, useEffect } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';

export interface ProgramState {
    isPaused: boolean;
    loading: boolean;
    error?: string;
}

export const useProgramState = (connection: Connection, programId: PublicKey): ProgramState => {
    const [isPaused, setIsPaused] = useState<boolean>(false);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        const checkState = async () => {
            try {
                setError(undefined);

                // 1. Fetch the "Config" or "State" account of your program
                // (You need to know the PDA address of your config account)
                const [configPda] = PublicKey.findProgramAddressSync(
                    [Buffer.from("config")],
                    programId
                );

                const accountInfo = await connection.getAccountInfo(configPda);

                if (accountInfo) {
                    // 2. Decode the data (Assuming byte 0 is the boolean 'is_paused')
                    // In a real app, use your Anchor IDL to decode this properly!
                    const data = accountInfo.data;
                    const pausedByte = data[0]; // Example: First byte is boolean
                    setIsPaused(pausedByte === 1);
                } else {
                    // If no config account exists, assume system is operational
                    setIsPaused(false);
                }
            } catch (err) {
                console.error("Failed to fetch program state:", err);
                setError(err instanceof Error ? err.message : 'Unknown error');
                // On error, assume system is operational to avoid false positives
                setIsPaused(false);
            } finally {
                setLoading(false);
            }
        };

        // Poll every 10 seconds
        checkState();
        const interval = setInterval(checkState, 10000);
        return () => clearInterval(interval);
    }, [connection, programId]);

    return { isPaused, loading, error };
};
