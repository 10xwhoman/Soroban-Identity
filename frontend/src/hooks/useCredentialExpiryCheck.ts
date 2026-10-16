import { useState, useEffect, useCallback, useRef } from "react";
import type { Credential } from "../../../sdk/src/types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ExpiryNotification {
  count: number;
  credentials: Credential[];
  readIds: string[];
  dismissed: boolean;
}

/**
 * Checks credentials for the connected wallet and notifies when any
 * expire within the next 7 days. Re-checks every 5 minutes.
 */
export function useCredentialExpiryCheck(
  publicKey: string | null,
  fetchCredentials: (address: string) => Promise<Credential[]>
) {
  const [notification, setNotification] = useState<ExpiryNotification | null>(null);
  const readIdsRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    if (!publicKey) return;
    try {
      const credentials = await fetchCredentials(publicKey);
      const now = Date.now();
      const expiring = credentials.filter((c) => {
        if (c.expiresAt === 0 || c.revoked) return false;
        const expiryMs = c.expiresAt * 1000;
        return expiryMs > now && expiryMs - now <= SEVEN_DAYS_MS;
      });
      if (expiring.length > 0) {
        const unreadCount = expiring.filter((c) => !readIdsRef.current.has(c.id)).length;
        setNotification((prev: ExpiryNotification | null) =>
          prev?.dismissed
            ? prev
            : {
                count: unreadCount,
                credentials: expiring,
                readIds: Array.from(readIdsRef.current),
                dismissed: unreadCount === 0,
              }
        );
      } else {
        setNotification(null);
      }
    } catch {
      // silently ignore fetch errors
    }
  }, [publicKey, fetchCredentials]);

  useEffect(() => {
    if (!publicKey) {
      readIdsRef.current.clear();
      setNotification(null);
      return;
    }
    check();
    intervalRef.current = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [publicKey, check]);

  const markAsRead = useCallback((credentialId: string) => {
    readIdsRef.current.add(credentialId);
    setNotification((prev: ExpiryNotification | null) => {
      if (!prev) return null;
      const unread = prev.credentials.filter((c) => !readIdsRef.current.has(c.id));
      return {
        ...prev,
        count: unread.length,
        readIds: Array.from(readIdsRef.current),
        dismissed: unread.length === 0 ? true : prev.dismissed,
      };
    });
  }, []);

  const markBatchAsRead = useCallback((credentialIds: string[]) => {
    credentialIds.forEach((id) => readIdsRef.current.add(id));
    setNotification((prev: ExpiryNotification | null) => {
      if (!prev) return null;
      const unread = prev.credentials.filter((c) => !readIdsRef.current.has(c.id));
      return {
        ...prev,
        count: unread.length,
        readIds: Array.from(readIdsRef.current),
        dismissed: unread.length === 0 ? true : prev.dismissed,
      };
    });
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotification((prev: ExpiryNotification | null) => {
      if (!prev) return null;
      prev.credentials.forEach((c) => readIdsRef.current.add(c.id));
      return {
        ...prev,
        count: 0,
        readIds: Array.from(readIdsRef.current),
        dismissed: true,
      };
    });
  }, []);

  const dismiss = useCallback(() => {
    setNotification((prev: ExpiryNotification | null) =>
      prev ? { ...prev, count: 0, dismissed: true } : null
    );
  }, []);

  return { notification, dismiss, markAsRead, markBatchAsRead, markAllAsRead };
}
