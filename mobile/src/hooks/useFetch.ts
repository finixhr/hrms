// Custom hook — useFetch<T>
// Wraps rpc() with loading / error / data state + pull-to-refresh support

import { useState, useEffect, useCallback, useRef } from "react";
import { rpc, ApiError } from "../lib/api";

interface FetchState<T> {
  data:       T | null;
  loading:    boolean;
  refreshing: boolean;
  error:      string | null;
  refresh:    () => void;
}

export function useFetch<T>(
  action: string,
  payload?: unknown,
  deps: unknown[] = [],
): FetchState<T> {
  const [data,       setData]       = useState<T | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true;  return () => { mounted.current = false; }; }, []);

  // T-11 — dependency lists must be simple expressions (no inline
  // JSON.stringify, no spread): the serialized payload stays the cache key
  // (stable across renders even when the payload object identity changes),
  // and the optional extra deps collapse into one serialized trigger key —
  // load() does the work either way.
  const payloadKey = JSON.stringify(payload ?? {});
  const extraKey = JSON.stringify(deps);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const result = await rpc<T>(action, payload ?? {});
      if (mounted.current) setData(result);
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, [action, payloadKey]);

  useEffect(() => { load(); }, [load, extraKey]);

  const refresh = useCallback(() => { setRefreshing(true); load(true); }, [load]);

  return { data, loading, refreshing, error, refresh };
}
