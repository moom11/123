import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearTokens, hasSession, setTokens } from './api.js';

export interface Me {
  user: {
    id: string; name: string; role: string; roleLabel: string; isAdmin: boolean;
    employeeId: string | null; employeeCode: string | null; department: string | null;
    branchId: string | null; allowedBranchIds: string[]; mfaSatisfied: boolean;
  };
  branch: { id: string; code: string; name: string; vat_percent: number } | null;
  permissions: string[];
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  /** True when the caller holds the permission. Rendering only — never security. */
  can: (...permissions: string[]) => boolean;
  signIn: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!hasSession()) { setMe(null); setLoading(false); return; }
    try {
      setMe(await api<Me>('/auth/me'));
    } catch {
      clearTokens();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const value = useMemo<SessionValue>(() => ({
    me,
    loading,
    // A permission set is a plain lookup; the backend enforces the same rules
    // again on every request, so a stale set here can only hide a button.
    can: (...permissions) =>
      permissions.some((p) => me?.permissions.includes(p) ?? false),
    signIn: async (tokens) => {
      setTokens(tokens);
      setLoading(true);
      await load();
    },
    signOut: async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
      clearTokens();
      setMe(null);
    },
    reload: load,
  }), [me, loading, load]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
