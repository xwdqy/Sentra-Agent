import { useEffect, useRef, type MutableRefObject } from 'react';
import { storage } from '../../utils/storage';
import type { Conversation } from './QqSandbox.types';
import type { QqLimits } from './useQqRuntimeConfig';

export function useQqPersistence(opts: {
  hydratedRef: MutableRefObject<boolean>;
  selfIdRef: MutableRefObject<number>;
  qqLimitsRef: MutableRefObject<QqLimits>;
  activeKey: string | null;
  setActiveKey: (k: string | null) => void;
  convoMap: Record<string, Conversation>;
  setConvoMap: (m: Record<string, Conversation>) => void;
  sendText: string;
  setSendText: (v: string) => void;
  pendingAttachments: Array<{ previewUrl?: string }>;
}) {
  const {
    hydratedRef,
    selfIdRef,
    qqLimitsRef,
    activeKey,
    setActiveKey,
    convoMap,
    setConvoMap,
    sendText,
    setSendText,
    pendingAttachments,
  } = opts;

  useEffect(() => {
    try {
      if (!hydratedRef.current) return;
      storage.setString('sentra_qq_sandbox_active_key', String(activeKey || ''), 'local');
    } catch {
    }
  }, [activeKey, hydratedRef]);

  useEffect(() => {
    try {
      const savedKey = storage.getString('sentra_qq_sandbox_active_key', { fallback: '' });
      const savedMap = storage.getJson<Record<string, Conversation>>('sentra_qq_sandbox_convo_cache', { fallback: {} as any });
      if (savedMap && typeof savedMap === 'object') {
        const keys = Object.keys(savedMap);
        if (keys.length > 0) setConvoMap(savedMap);
      }
      if (savedKey) setActiveKey(savedKey);

      const drafts = storage.getJson<Record<string, string>>('sentra_qq_sandbox_drafts', { fallback: {} as any });
      if (drafts && savedKey && drafts[savedKey]) {
        setSendText(String(drafts[savedKey] || ''));
      }

      const sid = storage.getNumber('sentra_qq_sandbox_self_id', { fallback: 0 });
      if (Number.isFinite(sid) && sid > 0) selfIdRef.current = sid;
    } catch {
    } finally {
      hydratedRef.current = true;
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        for (const a of pendingAttachments) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        }
      } catch {
      }
    };
  }, [pendingAttachments]);

  const persistTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    } catch {
    }

    persistTimerRef.current = window.setTimeout(() => {
      try {
        const entries = Object.values(convoMap || {});
        entries.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
        const persistMaxConversations = qqLimitsRef.current.persistMaxConversations;
        const persistMaxMessages = qqLimitsRef.current.persistMaxMessages;

        const limited = entries.slice(0, persistMaxConversations);
        const next: Record<string, Conversation> = {};
        for (const c of limited) {
          const msgs = Array.isArray(c.messages) ? (persistMaxMessages > 0 ? c.messages.slice(-persistMaxMessages) : []) : [];
          next[c.key] = { ...c, unread: 0, messages: msgs };
        }
        storage.setJson('sentra_qq_sandbox_convo_cache', next, 'local');
      } catch {
      }
    }, 500);

    return () => {
      try {
        if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
      } catch {
      }
    };
  }, [convoMap, hydratedRef, qqLimitsRef]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      const drafts = storage.getJson<Record<string, string>>('sentra_qq_sandbox_drafts', { fallback: {} as any });
      const key = String(activeKey || '');
      if (!key) return;
      const next = { ...(drafts || {}) };
      next[key] = String(sendText || '');
      storage.setJson('sentra_qq_sandbox_drafts', next, 'local');
    } catch {
    }
  }, [activeKey, hydratedRef, sendText]);
}
