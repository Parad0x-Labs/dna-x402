/**
 * MOBILE HARDENING - Safari/iOS Memory Management
 * Prevents crashes on iOS Safari during ZK proof generation
 */

export class MobileHardening {
  private static readonly SAFARI_MEMORY_LIMIT = 500 * 1024 * 1024; // 500MB conservative limit
  private static readonly CHUNK_SIZE = 64 * 1024; // 64KB chunks for memory management

  /**
   * Detect iOS Safari and apply memory constraints
   */
  static isIOS(): boolean {
    const userAgent = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
  }

  static isSafari(): boolean {
    const userAgent = navigator.userAgent;
    const vendor = navigator.vendor;
    return /Safari/.test(userAgent) && /Apple Computer/.test(vendor) && !/Chrome|Chromium|Edge/.test(userAgent);
  }

  /**
   * Check available memory before heavy operations
   */
  static async checkMemorySafety(): Promise<{ safe: boolean; availableMB: number }> {
    try {
      // Use Performance.memory if available (Chrome/Edge)
      if ('memory' in performance) {
        const memInfo = (performance as any).memory;
        const usedMB = memInfo.usedJSHeapSize / (1024 * 1024);
        const availableMB = Math.max(0, 500 - usedMB); // Conservative estimate

        const safe = usedMB < this.SAFARI_MEMORY_LIMIT / (1024 * 1024);

        return { safe, availableMB };
      }

      // Fallback: estimate based on device
      const isIOS = this.isIOS();
      const isSafari = this.isSafari();

      if (isIOS && isSafari) {
        // iOS Safari is most memory-constrained
        return { safe: false, availableMB: 100 }; // Conservative estimate
      }

      return { safe: true, availableMB: 500 };

    } catch (error) {
      // If memory check fails, assume unsafe
      return { safe: false, availableMB: 0 };
    }
  }

  /**
   * Memory-safe chunked processing for large data
   */
  static async processInChunks<T>(
    data: any[],
    processor: (chunk: any[]) => Promise<T[]>,
    chunkSize: number = this.CHUNK_SIZE
  ): Promise<T[]> {
    const results: T[] = [];
    const { safe, availableMB } = await this.checkMemorySafety();

    // Reduce chunk size on memory-constrained devices
    const effectiveChunkSize = safe ? chunkSize : Math.max(1, Math.floor(chunkSize / 4));

    for (let i = 0; i < data.length; i += effectiveChunkSize) {
      const chunk = data.slice(i, i + effectiveChunkSize);
      const chunkResults = await processor(chunk);
      results.push(...chunkResults);

      // Force garbage collection hint on memory-constrained devices
      if (!safe && i % (effectiveChunkSize * 4) === 0) {
        await this.forceGC();
      }
    }

    return results;
  }

  /**
   * ZK proof generation with mobile safety checks
   */
  static async generateZKProofSafe(proofInputs: any): Promise<any> {
    const { safe, availableMB } = await this.checkMemorySafety();

    if (!safe) {
      throw new Error(
        `Insufficient memory for ZK proof generation. ` +
        `Available: ${availableMB.toFixed(1)}MB. ` +
        `Try on a device with more memory or close other apps.`
      );
    }

    // Add progress indicator for long operations on mobile
    if (this.isIOS() || this.isSafari()) {
      console.log('[Mobile] Starting ZK proof generation (may take 30+ seconds)...');
    }

    try {
      // Your ZK proof generation logic here
      // This would integrate with snarkjs or your backend

      // Simulate progress for mobile users
      if (this.isIOS() || this.isSafari()) {
        const progressInterval = setInterval(() => {
          console.log('[Mobile] ZK proof generation in progress...');
        }, 10000);

        // Clear progress indicator
        setTimeout(() => clearInterval(progressInterval), 60000);
      }

      // Return mock result for now
      return {
        proof: { /* proof data */ },
        publicSignals: []
      };

    } catch (error) {
      if (error instanceof Error && error.message.includes('out of memory')) {
        throw new Error(
          'Memory limit exceeded during ZK proof generation. ' +
          'Try on a device with more RAM or use the desktop version.'
        );
      }
      throw error;
    }
  }

  /**
   * Force garbage collection (hint)
   */
  static async forceGC(): Promise<void> {
    // Force garbage collection if available
    if (window.gc) {
      window.gc();
    }

    // Additional memory cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Monitor memory usage during operations
   */
  static startMemoryMonitoring(operationName: string): () => void {
    const startMemory = performance.memory ?
      (performance as any).memory.usedJSHeapSize : 0;

    console.log(`[Memory] Starting ${operationName}: ${startMemory / (1024 * 1024)}MB`);

    const interval = setInterval(() => {
      if (performance.memory) {
        const currentMemory = (performance as any).memory.usedJSHeapSize;
        const usedMB = currentMemory / (1024 * 1024);
        console.log(`[Memory] ${operationName}: ${usedMB.toFixed(1)}MB`);
      }
    }, 5000);

    // Return cleanup function
    return () => {
      clearInterval(interval);
      if (performance.memory) {
        const endMemory = (performance as any).memory.usedJSHeapSize;
        const deltaMB = (endMemory - startMemory) / (1024 * 1024);
        console.log(`[Memory] ${operationName} complete. Memory delta: ${deltaMB.toFixed(1)}MB`);
      }
    };
  }

  /**
   * Check if device can handle ZK operations
   */
  static canHandleZKOperations(): Promise<{ canHandle: boolean; reason?: string }> {
    return new Promise((resolve) => {
      const isIOS = this.isIOS();
      const isSafari = this.isSafari();

      // Quick memory check
      this.checkMemorySafety().then(({ safe, availableMB }) => {
        if (!safe) {
          resolve({
            canHandle: false,
            reason: `Insufficient memory (${availableMB.toFixed(1)}MB available). Try desktop or Android.`
          });
          return;
        }

        // Device capability check
        if (isIOS && isSafari) {
          // Test WebAssembly support
          if (typeof WebAssembly !== 'object') {
            resolve({
              canHandle: false,
              reason: 'WebAssembly not supported. Update Safari to latest version.'
            });
            return;
          }

          // Test for known Safari memory issues
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl');
          if (!gl) {
            resolve({
              canHandle: false,
              reason: 'WebGL not available. ZK operations require hardware acceleration.'
            });
            return;
          }
        }

        resolve({ canHandle: true });
      });
    });
  }
}

/**
 * USAGE EXAMPLES:
 *
 * // Check if device can handle ZK operations
 * const { canHandle, reason } = await MobileHardening.canHandleZKOperations();
 * if (!canHandle) {
 *   alert(`Device not supported: ${reason}`);
 *   return;
 * }
 *
 * // Memory-safe proof generation
 * const stopMonitoring = MobileHardening.startMemoryMonitoring('ZK Proof Generation');
 * try {
 *   const proof = await MobileHardening.generateZKProofSafe(inputs);
 *   console.log('Proof generated successfully');
 * } finally {
 *   stopMonitoring();
 * }
 *
 * // Chunked processing for large datasets
 * const results = await MobileHardening.processInChunks(
 *   largeDataset,
 *   async (chunk) => processChunk(chunk),
 *   1000 // items per chunk
 * );
 */
