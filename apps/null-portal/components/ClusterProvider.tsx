"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type Cluster,
  type ClusterConfig,
  DEFAULT_CLUSTER,
  configFor,
  loadCluster,
  saveCluster,
} from "@/lib/cluster";

interface ClusterState {
  cluster: Cluster;
  config: ClusterConfig;
  setCluster: (c: Cluster) => void;
  /** true once the persisted value has been hydrated from localStorage */
  ready: boolean;
}

const ClusterContext = createContext<ClusterState | null>(null);

export function ClusterProvider({ children }: { children: React.ReactNode }) {
  // Start at the SSR-safe default; hydrate the persisted choice on mount so the
  // server and first client render agree (no hydration mismatch).
  const [cluster, setClusterState] = useState<Cluster>(DEFAULT_CLUSTER);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setClusterState(loadCluster());
    setReady(true);
  }, []);

  const setCluster = useCallback((c: Cluster) => {
    setClusterState(c);
    saveCluster(c);
  }, []);

  const value = useMemo<ClusterState>(
    () => ({ cluster, config: configFor(cluster), setCluster, ready }),
    [cluster, setCluster, ready],
  );

  return (
    <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>
  );
}

export function useCluster(): ClusterState {
  const ctx = useContext(ClusterContext);
  if (!ctx) throw new Error("useCluster must be used within <ClusterProvider>");
  return ctx;
}
