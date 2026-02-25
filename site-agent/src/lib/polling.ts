import { useEffect, useMemo, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  latencyMs: number | null;
  p95LatencyMs: number | null;
  errorRate: number;
}

function p95(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95) - 1));
  return sorted[index];
}

export function usePolling<T>(options: {
  intervalMs: number;
  enabled?: boolean;
  fetcher: () => Promise<T>;
  deps?: ReadonlyArray<unknown>;
  onSuccess?: (data: T, latencyMs: number) => void;
  onError?: (error: Error) => void;
}): PollingState<T> {
  const { intervalMs, enabled = true, fetcher, deps = [], onSuccess, onError } = options;
  const [state, setState] = useState<PollingState<T>>({
    data: null,
    loading: true,
    error: null,
    lastUpdatedAt: null,
    latencyMs: null,
    p95LatencyMs: null,
    errorRate: 0,
  });

  const latenciesRef = useRef<number[]>([]);
  const outcomesRef = useRef<boolean[]>([]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    const runOnce = async () => {
      const started = performance.now();
      try {
        const data = await fetcher();
        if (cancelled) {
          return;
        }
        const latency = Math.max(0, Math.round(performance.now() - started));

        latenciesRef.current = [...latenciesRef.current, latency].slice(-60);
        outcomesRef.current = [...outcomesRef.current, true].slice(-120);
        const failures = outcomesRef.current.filter((ok) => !ok).length;
        const errorRate = outcomesRef.current.length === 0 ? 0 : failures / outcomesRef.current.length;

        setState({
          data,
          loading: false,
          error: null,
          lastUpdatedAt: new Date().toISOString(),
          latencyMs: latency,
          p95LatencyMs: p95(latenciesRef.current),
          errorRate,
        });

        if (onSuccess) {
          onSuccess(data, latency);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        outcomesRef.current = [...outcomesRef.current, false].slice(-120);
        const failures = outcomesRef.current.filter((ok) => !ok).length;
        const errorRate = outcomesRef.current.length === 0 ? 0 : failures / outcomesRef.current.length;
        const message = error instanceof Error ? error.message : String(error);

        setState((prev) => ({
          ...prev,
          loading: false,
          error: message,
          errorRate,
        }));

        if (onError) {
          onError(error instanceof Error ? error : new Error(message));
        }
      }
    };

    void runOnce();
    const timer = window.setInterval(() => {
      void runOnce();
    }, Math.max(250, intervalMs));

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps]);

  return useMemo(() => state, [state]);
}
