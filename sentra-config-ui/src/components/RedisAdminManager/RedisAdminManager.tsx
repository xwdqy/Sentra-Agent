import { useCallback, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import styles from './RedisAdminManager.module.css';
import '../../utils/monacoSetup';
import {
  fetchRedisAdminGroups,
  fetchRedisAdminHealth,
  fetchRedisAdminInfoByProfile,
  fetchRedisAdminInspect,
  fetchRedisAdminList,
  fetchRedisAdminOverview,
  fetchRedisAdminRelated,
  deleteRedisAdminGroupStatePairs,
  deleteRedisAdminByPattern,
} from '../../services/redisAdminApi';
import { useDevice } from '../../hooks/useDevice';

type ToastFn = (type: 'success' | 'error' | 'info', title: string, message?: string) => void;

type RedisKeyItem = {
  key: string;
  category?: string;
  chatType?: string | null;
  groupId?: string | null;
  userId?: string | null;
  date?: string | null;
  tsMs?: number | null;
  ttl?: number | null;
  redisType?: string;
  len?: number;
  extra?: Record<string, any>;
};

function normalizeMultilineText(v: unknown) {
  return String(v ?? '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function stringifyForPreview(v: unknown) {
  return normalizeMultilineText(JSON.stringify(v, null, 2));
}

function ttlTone(ttl: number | null | undefined): 'unknown' | 'missing' | 'permanent' | 'warn' | 'ok' {
  if (ttl == null || !Number.isFinite(ttl)) return 'unknown';
  if (ttl === -2) return 'missing';
  if (ttl === -1) return 'permanent';
  if (ttl >= 0 && ttl < 60) return 'warn';
  return 'ok';
}

function readThemeAttr(): 'light' | 'dark' {
  try {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function formatTtl(ttl: number | null | undefined) {
  if (ttl == null) return '-';
  if (ttl === -2) return '不存在';
  if (ttl === -1) return '永久';
  if (!Number.isFinite(ttl)) return '-';
  const s = Math.max(0, Math.floor(ttl));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatRedisType(t?: string | null) {
  const x = (t || '').toLowerCase();
  if (!x) return '-';
  const m: Record<string, string> = {
    string: '文本',
    list: '列表',
    hash: '字典',
    zset: '排序集',
    set: '集合',
    unknown: '未知',
  };
  return m[x] || x;
}

function parseDateStartMs(dateStr: string): number | null {
  const d = String(dateStr || '').trim();
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00`);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseDateEndExclusiveMs(dateStr: string): number | null {
  const start = parseDateStartMs(dateStr);
  if (start == null) return null;
  return start + 24 * 60 * 60 * 1000;
}

function getItemTsMs(it: { tsMs?: number | null; date?: string | null }): number | null {
  const raw = it?.tsMs;
  if (raw != null && Number.isFinite(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n > 0 && n < 1e12 ? n * 1000 : n;
  }
  const ds = String(it?.date || '').trim();
  if (!ds) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
    const ms = new Date(`${ds}T00:00:00`).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(ds)) {
    const iso = ds.includes('T') ? ds : ds.replace(' ', 'T');
    const fixed = /:/.test(iso.slice(-3)) ? iso : `${iso}:00`;
    const ms = new Date(fixed).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const ms = new Date(ds).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fmtDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function RedisAdminManager(props: { addToast: ToastFn }) {
  const { addToast } = props;

  const { isMobile, isTablet } = useDevice();
  const isCompact = isMobile || isTablet;
  const [mobilePane, setMobilePane] = useState<'filters' | 'keys' | 'detail'>('filters');
  const [uiTheme, setUiTheme] = useState<'light' | 'dark'>(() => readThemeAttr());
  const [sentraRoot, setSentraRoot] = useState<string>('');
  const [redisInfo, setRedisInfo] = useState<any>(null);

  const [profile, setProfile] = useState<'main' | 'mcp'>(() => {
    try {
      const v = localStorage.getItem('redisAdmin.profile');
      return v === 'main' ? 'main' : 'mcp';
    } catch {
      return 'mcp';
    }
  });

  const [errorText, setErrorText] = useState<string>('');

  const [groups, setGroups] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  const [pattern, setPattern] = useState('sentra:');
  const [items, setItems] = useState<RedisKeyItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [inspect, setInspect] = useState<any>(null);
  const [rightTab, setRightTab] = useState<'detail' | 'overview' | 'related' | 'danger'>('detail');
  const [detailFocus, setDetailFocus] = useState<'preview' | 'pairs' | 'split'>('preview');

  const [categoryFilter, setCategoryFilter] = useState<string>('全部');
  const [keyword, setKeyword] = useState<string>('');

  const [profileKeyScope, setProfileKeyScope] = useState<'all' | 'profileOnly'>(() => {
    try {
      const v = localStorage.getItem('redisAdmin.profileKeyScope');
      return v === 'all' ? 'all' : 'profileOnly';
    } catch {
      return 'profileOnly';
    }
  });

  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [sizeMin, setSizeMin] = useState<string>('');
  const [sizeMax, setSizeMax] = useState<string>('');
  const [ttlFilter, setTtlFilter] = useState<'all' | 'permanent' | 'expiring' | 'missing'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'string' | 'list' | 'hash' | 'set' | 'zset'>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'known' | 'unknown'>('all');
  const [sortBy, setSortBy] = useState<'ts' | 'len' | 'ttl' | 'key'>('ts');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const [groupId, setGroupId] = useState('');
  const [userId, setUserId] = useState('');
  const [relatedItems, setRelatedItems] = useState<RedisKeyItem[]>([]);

  const [busy, setBusy] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deletePreview, setDeletePreview] = useState<{ pattern: string; requested: number; deleted: number; ts: number } | null>(null);

  const [pairConfirmOpen, setPairConfirmOpen] = useState(false);
  const [pairConfirmText, setPairConfirmText] = useState('');
  const [pairSelectedId, setPairSelectedId] = useState<string>('');
  const [pairSectionCollapsed, setPairSectionCollapsed] = useState<boolean>(false);
  const [pairExpandAll, setPairExpandAll] = useState<boolean>(false);
  const [pairExpandedMap, setPairExpandedMap] = useState<Record<string, boolean>>({});
  const [pairListLimit, setPairListLimit] = useState<number>(200);
  const [pairSearchText, setPairSearchText] = useState<string>('');
  const [pairSearchMode, setPairSearchMode] = useState<'auto' | 'pairId' | 'keyword'>('auto');
  const [pairSelectedMap, setPairSelectedMap] = useState<Record<string, boolean>>({});
  const [pairDeletePreview, setPairDeletePreview] = useState<{
    groupId: string;
    pairId: string;
    shortId: string;
    dryRun: boolean;
    stats: any;
    ts: number;
  } | null>(null);
  const [pairBulkConfirmOpen, setPairBulkConfirmOpen] = useState(false);
  const [pairBulkConfirmText, setPairBulkConfirmText] = useState('');
  const [pairBulkDeletePreview, setPairBulkDeletePreview] = useState<{
    groupId: string;
    pairIds: string[];
    dryRun: boolean;
    stats: any;
    ts: number;
  } | null>(null);

  const applyDatePreset = useCallback((days: number | null) => {
    if (days == null) {
      setDateFrom('');
      setDateTo('');
      return;
    }
    const now = new Date();
    const end = fmtDateInput(now);
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - Math.max(0, days - 1));
    const start = fmtDateInput(startDate);
    setDateFrom(start);
    setDateTo(end);
  }, []);

  const loadHealth = useCallback(async () => {
    const h = await fetchRedisAdminHealth();
    setSentraRoot(String(h.sentraRoot || ''));
  }, []);

  const loadInfo = useCallback(async () => {
    const info = await fetchRedisAdminInfoByProfile(profile);
    setRedisInfo(info);
  }, [profile]);

  const loadOverview = useCallback(async () => {
    const payload = await fetchRedisAdminOverview({ profile, count: 500 });
    setCounts(payload?.counts || {});
  }, [profile]);

  const loadGroups = useCallback(async () => {
    const payload = await fetchRedisAdminGroups({ profile });
    setGroups(payload?.groups || {});
  }, [profile]);

  const groupNameCn = useMemo(() => {
    return {
      conversation_private: '会话（私聊）',
      conversation_group: '会话（群聊）',
      group_history: '群会话状态',
      desire_state: '意愿/主动',
      desire_user_fatigue: '疲劳度',
      context_memory: '记忆（按天）',
      preset_teaching_examples: '预设示例',
      mcp_metrics: 'MCP 指标',
      mcp_context: 'MCP 上下文',
      mcp_memory: 'MCP 记忆',
      mcp_tool_cache: 'MCP 工具缓存',
      mcp_argcache: 'MCP 参数缓存',
      attention_stats: '关注度',
    } as Record<string, string>;
  }, []);

  const runList = useCallback(async () => {
    const p = pattern.trim();
    if (!p) return;
    const payload = await fetchRedisAdminList({ profile, pattern: p, count: 800, withMeta: true });
    const list = Array.isArray(payload?.items) ? payload.items : [];
    setItems(list);
    setSelectedKey('');
    setInspect(null);
  }, [pattern, profile]);

  const runListFor = useCallback(async (p: string) => {
    const ptn = String(p || '').trim();
    if (!ptn) return;
    setBusy(true);
    setErrorText('');
    setPattern(ptn);
    try {
      const payload = await fetchRedisAdminList({ profile, pattern: ptn, count: 800, withMeta: true });
      const list = Array.isArray(payload?.items) ? payload.items : [];
      setItems(list);
      setSelectedKey('');
      setInspect(null);
      addToast('success', '已列出', `keys=${list.length}`);
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', '列出失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast, profile]);

  const runInspect = useCallback(async (k: string) => {
    const key = String(k || '').trim();
    if (!key) return;
    const payload = await fetchRedisAdminInspect({ profile, key, preview: 1200, head: 5, tail: 5, sample: 12, top: 20 });
    setInspect(payload);
  }, [profile]);

  const runRelated = useCallback(async () => {
    const gid = groupId.trim();
    const uid = userId.trim();
    const payload = await fetchRedisAdminRelated({
      profile,
      groupId: gid || undefined,
      userId: uid || undefined,
      count: 800,
      withMeta: true,
    });
    const list = Array.isArray(payload?.items) ? payload.items : [];
    setRelatedItems(list);
  }, [groupId, userId, profile]);

  const runDeleteDry = useCallback(async () => {
    const p = pattern.trim();
    if (!p) return;
    const payload = await deleteRedisAdminByPattern({ profile, pattern: p, dryRun: true, count: 1200 });
    setDeletePreview({
      pattern: p,
      requested: Number(payload.requested || 0),
      deleted: Number(payload.deleted || 0),
      ts: Date.now(),
    });
    addToast('info', 'Dry-run 删除预览', `requested=${payload.requested}, deleted=${payload.deleted}`);
  }, [addToast, pattern, profile]);

  const runDeleteConfirm = useCallback(async () => {
    const p = pattern.trim();
    if (!p) return;
    const payload = await deleteRedisAdminByPattern({
      profile,
      pattern: p,
      dryRun: false,
      count: 1500,
    });
    setDeletePreview(null);
    addToast('success', '删除完成', `requested=${payload.requested}, deleted=${payload.deleted}`);
    await loadOverview();
    await runList();
  }, [addToast, loadOverview, pattern, runList, profile]);

  const init = useCallback(async () => {
    setBusy(true);
    setErrorText('');
    try {
      await loadHealth();
      await loadInfo();
      await loadGroups();
      await loadOverview();
    } finally {
      setBusy(false);
    }
  }, [loadGroups, loadHealth, loadInfo, loadOverview]);

  useEffect(() => {
    try {
      localStorage.setItem('redisAdmin.profile', profile);
    } catch {}
  }, [profile]);

  useEffect(() => {
    try {
      localStorage.setItem('redisAdmin.profileKeyScope', profileKeyScope);
    } catch {}
  }, [profileKeyScope]);

  useEffect(() => {
    // switching profile should refresh metadata and clear current list/selection
    setItems([]);
    setSelectedKey('');
    setInspect(null);
    setDeletePreview(null);
    setDetailFocus('preview');
    setPairSelectedId('');
    init().catch((e) => {
      setErrorText(String(e));
      addToast('error', '初始化失败', String(e));
    });
  }, [profile, init, addToast]);

  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => {
      setUiTheme(readThemeAttr());
    });
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (selectedKey) {
      runInspect(selectedKey).catch((e) => addToast('error', 'Inspect 失败', String(e)));
    }
  }, [selectedKey, runInspect, addToast]);

  useEffect(() => {
    setPairSelectedId('');
    setPairExpandAll(false);
    setPairExpandedMap({});
    setPairSearchText('');
    setPairSearchMode('auto');
    setPairSelectedMap({});
    setPairDeletePreview(null);
    setPairBulkDeletePreview(null);
    setPairBulkConfirmOpen(false);
    setPairBulkConfirmText('');
  }, [selectedKey]);

  const openPreview = useCallback((k: string) => {
    const key = String(k || '').trim();
    if (!key) return;
    setSelectedKey(key);
    setRightTab('detail');
    setPairSelectedId('');
    setDetailFocus('preview');
    if (isCompact) setMobilePane('detail');
  }, [isCompact]);

  const onPickQuickPattern = useCallback((ptn: string, label?: string, count?: number | null) => {
    const v = String(ptn || '').trim();
    if (!v) return;
    setPattern(v);
    if (count === 0) {
      const db = redisInfo?.db ?? '-';
      addToast('info', '该分组当前为空', `${label || v}：count=0（可能 MCP 使用了不同 DB/实例；当前 DB=${db}）`);
    }
  }, [addToast, redisInfo?.db]);

  type QuickPatternItem = { label: string; value: string; count: number | null };

  const quickPatternsByProfile = useMemo((): { main: QuickPatternItem[]; mcp: QuickPatternItem[] } => {
    const hasGroups = groups && Object.keys(groups).length > 0;

    const mainFallback: QuickPatternItem[] = [
      { label: '会话(私聊)', value: 'sentra:conv:private:*', count: null },
      { label: '会话(群聊)', value: 'sentra:conv:group:*', count: null },
      { label: '群会话状态', value: 'sentra:group:*', count: null },
      { label: '意愿/主动', value: 'sentra:desire:*', count: null },
      { label: '记忆(摘要)', value: 'sentra:memory:*', count: null },
      { label: '全部 sentra:*', value: 'sentra:*', count: null },
    ];

    const mcpFallback: QuickPatternItem[] = [
      { label: 'MCP ctx', value: 'sentra:mcp:ctx*', count: null },
      { label: 'MCP metrics', value: 'sentra:mcp:metrics*', count: null },
      { label: 'MCP tool cache', value: 'sentra:mcp:metrics:cache:tool:*', count: null },
      { label: 'MCP cooldown', value: 'sentra:mcp:metrics:cooldown:*', count: null },
      { label: 'MCP mem', value: 'sentra:mcp:mem*', count: null },
      { label: 'MCP argcache', value: 'sentra:mcp:mem:argcache:*', count: null },
      { label: '全部 sentra:*', value: 'sentra:*', count: null },
    ];

    if (!hasGroups) return { main: mainFallback, mcp: mcpFallback };

    const mainOrder = [
      'conversation_private',
      'conversation_group',
      'group_history',
      'desire_state',
      'desire_user_fatigue',
      'context_memory',
      'preset_teaching_examples',
      'attention_stats',
    ];
    const mcpOrder = [
      'mcp_context',
      'mcp_metrics',
      'mcp_tool_cache',
      'mcp_memory',
      'mcp_argcache',
    ];

    const build = (order: string[], wantMcp: boolean): QuickPatternItem[] => {
      const used = new Set<string>();
      const out: QuickPatternItem[] = [];

      for (const name of order) {
        const ptn = (groups as any)?.[name];
        if (!ptn) continue;
        used.add(name);
        out.push({
          label: groupNameCn[name] || name,
          value: String(ptn),
          count: counts[name] == null ? null : (counts[name] as any),
        });
      }

      for (const [name, ptn] of Object.entries(groups || {})) {
        if (used.has(name)) continue;
        const isMcp = String(name).startsWith('mcp_');
        if (wantMcp !== isMcp) continue;
        out.push({
          label: groupNameCn[name] || name,
          value: String(ptn),
          count: counts[name] == null ? null : (counts[name] as any),
        });
      }

      if (!out.find((x) => x.value === 'sentra:*')) {
        out.push({ label: '全部 sentra:*', value: 'sentra:*', count: null });
      }
      return out;
    };

    return {
      main: build(mainOrder, false),
      mcp: build(mcpOrder, true),
    };
  }, [counts, groupNameCn, groups]);

  const knownCategorySet = useMemo(() => {
    return new Set([
      '会话',
      '群会话状态',
      '记忆',
      '意愿/主动',
      '疲劳度',
      '关注度',
      '预设示例',
      'MCP 指标',
      'MCP 上下文',
      'MCP 记忆',
    ]);
  }, []);

  const scopeStats = useMemo(() => {
    let known = 0;
    let unknown = 0;
    for (const it of items) {
      const cat = String(it?.category || '其他');
      if (cat === '其他' || !knownCategorySet.has(cat)) unknown += 1;
      else known += 1;
    }
    return { known, unknown };
  }, [items, knownCategorySet]);

  const openDangerConfirm = useCallback(() => {
    const p = pattern.trim();
    if (!p) return;
    if (!deletePreview || deletePreview.pattern !== p) {
      addToast('info', '请先预览删除', '先点击“预览删除”，确认数量无误后再继续。');
      return;
    }
    setConfirmText('');
    setConfirmOpen(true);
  }, [addToast, deletePreview, pattern]);

  const runPairDeleteDry = useCallback(async (groupId: string, pairId: string) => {
    const gid = String(groupId || '').trim();
    const pid = String(pairId || '').trim();
    if (!gid || !pid) return;
    const shortId = pid.substring(0, 8);
    const payload = await deleteRedisAdminGroupStatePairs({ profile, groupId: gid, pairIds: [pid], dryRun: true });
    setPairDeletePreview({ groupId: gid, pairId: pid, shortId, dryRun: true, stats: payload?.stats, ts: Date.now() });
    addToast('info', '已生成预览', `pairId=${shortId} deleted.conversations=${payload?.stats?.deleted?.conversations ?? '-'}`);
  }, [addToast, profile]);

  const runPairBulkDeleteDry = useCallback(async (groupId: string, pairIds: string[]) => {
    const gid = String(groupId || '').trim();
    const uniq = Array.from(new Set((pairIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (!gid || !uniq.length) return;
    const payload = await deleteRedisAdminGroupStatePairs({ profile, groupId: gid, pairIds: uniq, dryRun: true });
    setPairBulkDeletePreview({ groupId: gid, pairIds: uniq, dryRun: true, stats: payload?.stats, ts: Date.now() });
    addToast('info', '已生成批量预览', `pairs=${uniq.length} deleted.conversations=${payload?.stats?.deleted?.conversations ?? '-'}`);
  }, [addToast, profile]);

  const openPairConfirm = useCallback((groupId: string, pairId: string) => {
    const gid = String(groupId || '').trim();
    const pid = String(pairId || '').trim();
    if (!gid || !pid) return;
    const shortId = pid.substring(0, 8);
    if (!pairDeletePreview || pairDeletePreview.groupId !== gid || pairDeletePreview.pairId !== pid) {
      addToast('info', '请先预览移除', `先点击“预览移除”，再确认删除（pairId=${shortId}）`);
      return;
    }
    setPairConfirmText('');
    setPairConfirmOpen(true);
  }, [addToast, pairDeletePreview]);

  const openPairBulkConfirm = useCallback((groupId: string, pairIds: string[]) => {
    const gid = String(groupId || '').trim();
    const uniq = Array.from(new Set((pairIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (!gid || !uniq.length) return;
    const same = pairBulkDeletePreview && pairBulkDeletePreview.groupId === gid && Array.isArray(pairBulkDeletePreview.pairIds) && pairBulkDeletePreview.pairIds.length === uniq.length && uniq.every((x) => pairBulkDeletePreview.pairIds.includes(x));
    if (!same) {
      addToast('info', '请先预览批量移除', `先点击“批量预览移除”，再确认删除（pairs=${uniq.length}）`);
      return;
    }
    setPairBulkConfirmText('');
    setPairBulkConfirmOpen(true);
  }, [addToast, pairBulkDeletePreview]);

  const runPairDeleteConfirm = useCallback(async () => {
    if (!pairDeletePreview) return;
    const gid = pairDeletePreview.groupId;
    const pid = pairDeletePreview.pairId;
    const shortId = pairDeletePreview.shortId;
    const payload = await deleteRedisAdminGroupStatePairs({ profile, groupId: gid, pairIds: [pid], dryRun: false });
    setPairDeletePreview({ groupId: gid, pairId: pid, shortId, dryRun: false, stats: payload?.stats, ts: Date.now() });
    addToast('success', '已移除对话对', `pairId=${shortId}`);
    setPairConfirmOpen(false);
    setPairConfirmText('');
    try {
      await runInspect(String(selectedKey || ''));
    } catch {}
    try {
      await runList();
    } catch {}
  }, [pairDeletePreview, profile, addToast, runInspect, selectedKey, runList]);

  const runPairBulkDeleteConfirm = useCallback(async () => {
    if (!pairBulkDeletePreview) return;
    const gid = pairBulkDeletePreview.groupId;
    const pairIds = pairBulkDeletePreview.pairIds;
    const payload = await deleteRedisAdminGroupStatePairs({ profile, groupId: gid, pairIds, dryRun: false });
    setPairBulkDeletePreview({ groupId: gid, pairIds, dryRun: false, stats: payload?.stats, ts: Date.now() });
    addToast('success', '已批量移除对话对', `pairs=${pairIds.length}`);
    setPairBulkConfirmOpen(false);
    setPairBulkConfirmText('');
    setPairSelectedMap({});
    try {
      await runInspect(String(selectedKey || ''));
    } catch {}
    try {
      await runList();
    } catch {}
  }, [pairBulkDeletePreview, profile, addToast, runInspect, selectedKey, runList]);

  const resetFilters = useCallback(() => {
    setScopeFilter('all');
    setCategoryFilter('全部');
    setTypeFilter('all');
    setTtlFilter('all');
    setKeyword('');
    setDateFrom('');
    setDateTo('');
    setSizeMin('');
    setSizeMax('');
    setSortBy('ts');
    setSortDir('desc');
  }, []);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      if (it && it.category) set.add(String(it.category));
    }
    const arr = Array.from(set);
    arr.sort();
    return ['全部', ...arr];
  }, [items]);

  const filteredItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const fromMs = parseDateStartMs(dateFrom);
    const toMsEx = parseDateEndExclusiveMs(dateTo);

    const minLen = sizeMin.trim() ? Number(sizeMin) : null;
    const maxLen = sizeMax.trim() ? Number(sizeMax) : null;
    const minLenOk = minLen == null || Number.isFinite(minLen);
    const maxLenOk = maxLen == null || Number.isFinite(maxLen);
    const minLenNum = minLenOk ? minLen : null;
    const maxLenNum = maxLenOk ? maxLen : null;

    const list = items.filter((it) => {
      if (profileKeyScope === 'profileOnly') {
        const k = String(it?.key || '');
        const cat = String(it?.category || '');
        const isMcp = k.startsWith('sentra:mcp:') || cat.startsWith('MCP');
        if (profile === 'main' && isMcp) return false;
        if (profile === 'mcp' && !isMcp) return false;
      }

      const cat = it.category || '其他';
      if (categoryFilter !== '全部' && cat !== categoryFilter) return false;

      if (scopeFilter !== 'all') {
        const isKnown = cat !== '其他' && knownCategorySet.has(String(cat));
        if (scopeFilter === 'known' && !isKnown) return false;
        if (scopeFilter === 'unknown' && isKnown) return false;
      }

      if (typeFilter !== 'all') {
        const t = String(it.redisType || '').toLowerCase();
        if (t !== typeFilter) return false;
      }

      if (ttlFilter !== 'all') {
        const ttl = it.ttl;
        if (ttlFilter === 'permanent') {
          if (ttl !== -1) return false;
        } else if (ttlFilter === 'missing') {
          if (ttl !== -2) return false;
        } else if (ttlFilter === 'expiring') {
          if (!(ttl != null && Number.isFinite(ttl) && ttl >= 0 && ttl < 60)) return false;
        }
      }

      if (fromMs != null || toMsEx != null) {
        const tms = getItemTsMs(it);
        if (tms != null) {
          if (fromMs != null && tms < fromMs) return false;
          if (toMsEx != null && tms >= toMsEx) return false;
        }
      }

      if (minLenNum != null || maxLenNum != null) {
        const ln = it.len;
        if (ln == null || !Number.isFinite(ln)) return false;
        if (minLenNum != null && ln < minLenNum) return false;
        if (maxLenNum != null && ln > maxLenNum) return false;
      }

      if (!kw) return true;
      const hay = [
        it.category,
        it.chatType,
        it.groupId,
        it.userId,
        it.date,
        it.redisType,
        it.key,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(kw);
    });

    const dir = sortDir === 'asc' ? 1 : -1;

    const cmpNumNullLast = (a: number | null, b: number | null) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return a === b ? 0 : a < b ? -1 : 1;
    };

    const sorted = [...list].sort((a, b) => {
      if (sortBy === 'key') {
        const av = String(a.key || '');
        const bv = String(b.key || '');
        const r = av.localeCompare(bv);
        return r * dir;
      }

      if (sortBy === 'len') {
        const r = cmpNumNullLast(a.len == null ? null : Number(a.len), b.len == null ? null : Number(b.len));
        if (r !== 0) return r * dir;
        return String(a.key || '').localeCompare(String(b.key || ''));
      }

      if (sortBy === 'ttl') {
        const av = a.ttl == null || !Number.isFinite(a.ttl) ? null : Number(a.ttl);
        const bv = b.ttl == null || !Number.isFinite(b.ttl) ? null : Number(b.ttl);
        const r = cmpNumNullLast(av, bv);
        if (r !== 0) return r * dir;
        return String(a.key || '').localeCompare(String(b.key || ''));
      }

      const at = getItemTsMs(a);
      const bt = getItemTsMs(b);
      const r = cmpNumNullLast(at, bt);
      if (r !== 0) return r * dir;
      return String(a.key || '').localeCompare(String(b.key || ''));
    });

    return sorted;
  }, [items, categoryFilter, dateFrom, dateTo, keyword, sizeMax, sizeMin, sortBy, sortDir, ttlFilter, typeFilter, scopeFilter, knownCategorySet]);

  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    return filteredItems.find((x) => x.key === selectedKey) || items.find((x) => x.key === selectedKey) || null;
  }, [filteredItems, items, selectedKey]);

  const inspectPreview = useMemo(() => {
    if (!inspect || typeof inspect !== 'object') return null;

    const t = String((inspect as any).type || '').toLowerCase();
    if (!t) return null;

    const renderMobilePre = (title: string, text: string) => {
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>{title}</div>
          <pre className={styles.previewPre}>{text}</pre>
        </div>
      );
    };

    if (t === 'string') {
      const v = (inspect as any).valuePreview;
      const isJson = !!(inspect as any).isJson;
      const json = (inspect as any).json;

      if (isCompact) {
        const text = isJson ? stringifyForPreview(json ?? {}) : normalizeMultilineText(v);
        return renderMobilePre('文本预览', text);
      }
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>文本预览</div>
          <div className={styles.editorBox} style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language={isJson ? 'json' : 'plaintext'}
              value={isJson ? stringifyForPreview(json ?? {}) : normalizeMultilineText(v)}
              theme={uiTheme === 'dark' ? 'hc-black' : 'light'}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                lineNumbers: 'off',
                folding: false,
                renderLineHighlight: 'none',
                scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                automaticLayout: true,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
              }}
            />
          </div>
        </div>
      );
    }

    if (t === 'list') {
      const len = (inspect as any).len;
      const head = Array.isArray((inspect as any).head) ? (inspect as any).head : [];

      if (isCompact) {
        return renderMobilePre(`列表预览（共 ${len ?? '-'} 条）`, stringifyForPreview(head));
      }
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>列表预览（共 {len ?? '-'} 条）</div>
          <div className={styles.editorBox} style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language="json"
              value={stringifyForPreview(head)}
              theme={uiTheme === 'dark' ? 'hc-black' : 'light'}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                lineNumbers: 'off',
                folding: false,
                renderLineHighlight: 'none',
                scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                automaticLayout: true,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
              }}
            />
          </div>
        </div>
      );
    }

    if (t === 'hash') {
      const len = (inspect as any).len;
      const fields = (inspect as any).fields;

      if (isCompact) {
        return renderMobilePre(`字典预览（共 ${len ?? '-'} 个字段）`, stringifyForPreview(fields));
      }
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>字典预览（共 {len ?? '-'} 个字段）</div>
          <div className={styles.editorBox} style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language="json"
              value={stringifyForPreview(fields)}
              theme={uiTheme === 'dark' ? 'hc-black' : 'light'}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                lineNumbers: 'off',
                folding: false,
                renderLineHighlight: 'none',
                scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                automaticLayout: true,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
              }}
            />
          </div>
        </div>
      );
    }

    if (t === 'zset') {
      const len = (inspect as any).len;
      const top = (inspect as any).top;

      if (isCompact) {
        return renderMobilePre(`排序集预览（共 ${len ?? '-'} 条）`, stringifyForPreview(top));
      }
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>排序集预览（共 {len ?? '-'} 条）</div>
          <div className={styles.editorBox} style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language="json"
              value={stringifyForPreview(top)}
              theme={uiTheme === 'dark' ? 'hc-black' : 'light'}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                lineNumbers: 'off',
                folding: false,
                renderLineHighlight: 'none',
                scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                automaticLayout: true,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
              }}
            />
          </div>
        </div>
      );
    }

    if (t === 'set') {
      const len = (inspect as any).len;
      const sample = (inspect as any).sample;

      if (isCompact) {
        return renderMobilePre(`集合预览（共 ${len ?? '-'} 条）`, stringifyForPreview(sample));
      }
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>集合预览（共 {len ?? '-'} 条）</div>
          <div className={styles.editorBox} style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              language="json"
              value={stringifyForPreview(sample)}
              theme={uiTheme === 'dark' ? 'hc-black' : 'light'}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                lineNumbers: 'off',
                folding: false,
                renderLineHighlight: 'none',
                scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                automaticLayout: true,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
              }}
            />
          </div>
        </div>
      );
    }

    return null;
  }, [inspect, uiTheme, isCompact]);

  const overviewRows = useMemo(() => {
    return Object.entries(groups)
      .map(([name, ptn]) => ({ name, ptn, count: counts[name] == null ? null : counts[name] }))
      .sort((a, b) => {
        const av = a.count == null ? -1 : a.count;
        const bv = b.count == null ? -1 : b.count;
        return bv - av;
      });
  }, [counts, groups]);

  return (
    <div className={styles.root}>
      <div className={styles.topBar}>
        <div className={styles.headerLeft}>
          <div className={styles.headerTitleRow}>
            <div className={styles.headerTitle}>Redis 管理器</div>
            <div className={styles.headerBadge}>{busy ? '加载中' : '可用'}</div>
          </div>
          <div className={styles.headerMetaRow}>
            <div className={styles.pill}><span className={styles.pillLabel}>Root</span>{sentraRoot || '-'}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>Profile</span>{profile}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>Pattern</span>{pattern.trim() || '-'}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>列表</span>{String(filteredItems.length)}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>已知</span>{String(scopeStats.known)}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>未知</span>{String(scopeStats.unknown)}</div>
          </div>
        </div>

        <div className={styles.headerActions}>
          <button className={styles.btn} onClick={() => init()} disabled={busy}>刷新</button>
        </div>
      </div>

      {isCompact ? (
        <div className={styles.mobileStepBar}>
          <button
            className={`${styles.mobileStepBtn} ${mobilePane === 'filters' ? styles.mobileStepBtnActive : ''}`}
            type="button"
            onClick={() => setMobilePane('filters')}
          >
            筛选
          </button>
          <button
            className={`${styles.mobileStepBtn} ${mobilePane === 'keys' ? styles.mobileStepBtnActive : ''}`}
            type="button"
            onClick={() => setMobilePane('keys')}
          >
            Keys
            <span className={styles.mobileStepCount}>{filteredItems.length}</span>
          </button>
          <button
            className={`${styles.mobileStepBtn} ${mobilePane === 'detail' ? styles.mobileStepBtnActive : ''}`}
            type="button"
            onClick={() => setMobilePane('detail')}
          >
            详情
          </button>
        </div>
      ) : null}

      <div className={`${styles.workspace} ${isCompact ? styles.workspaceMobile : ''}`}>
        <div className={`${styles.sidebar} ${isCompact && mobilePane !== 'filters' ? styles.mobileHidden : ''}`}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelTitle}>筛选与定位</div>
              <div className={styles.small}>左侧筛选，中间列表，右侧详情</div>
            </div>
          </div>

          <div className={styles.sidebarBody}>
            {errorText ? (
              <div className={styles.warning} style={{ margin: 10 }}>
                {errorText}
              </div>
            ) : null}

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>连接</div>
              <div className={styles.kvList} style={{ padding: 0, borderBottom: 'none' }}>
                <div className={styles.kvRow}>
                  <div className={styles.kvK}>Profile</div>
                  <div className={styles.kvV}>
                    <select className={styles.input} value={profile} onChange={(e) => setProfile(e.target.value as any)} style={{ height: 30 }}>
                      <option value="mcp">MCP（sentra-mcp/.env）</option>
                      <option value="main">主程序（根目录 .env）</option>
                    </select>
                  </div>
                </div>
                <div className={styles.kvRow}><div className={styles.kvK}>Root</div><div className={styles.kvV}>{sentraRoot || '-'}</div></div>
                <div className={styles.kvRow}><div className={styles.kvK}>Env</div><div className={styles.kvV}>{String(redisInfo?.envPath || '-')}</div></div>
                <div className={styles.kvRow}><div className={styles.kvK}>Redis</div><div className={styles.kvV}>{redisInfo?.host ? `${redisInfo.host}:${redisInfo.port ?? '-'}` : '-'}</div></div>
                <div className={styles.kvRow}><div className={styles.kvK}>DB</div><div className={styles.kvV}>{redisInfo?.db ?? '-'}</div></div>
                <div className={styles.kvRow}><div className={styles.kvK}>密码</div><div className={styles.kvV}>{redisInfo?.hasPassword ? '已配置' : '未配置'}</div></div>
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>Pattern</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <input className={styles.input} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="例如: sentra:memory:* 或 sentra:mcp:ctx*" />
                <button
                  className={styles.btn}
                  onClick={() => {
                    setRightTab('detail');
                    runList();
                    if (isCompact) setMobilePane('keys');
                  }}
                  disabled={busy || !pattern.trim()}
                  type="button"
                >
                  列出
                </button>
              </div>

              <div className={styles.profileQuickHeader}>
                <div className={styles.small}>快捷分组（当前：{profile === 'main' ? '主程序' : 'MCP'}）</div>
                <button className={styles.btn} onClick={() => setProfile(profile === 'main' ? 'mcp' : 'main')} disabled={busy} type="button">
                  切换到{profile === 'main' ? 'MCP' : '主程序'}
                </button>
              </div>

              <div className={styles.tagRow} style={{ padding: 0, marginTop: 10 }}>
                {(profile === 'main' ? quickPatternsByProfile.main : quickPatternsByProfile.mcp).map((x: QuickPatternItem) => (
                  <div
                    key={x.value}
                    className={`${styles.tag} ${pattern.trim() === x.value ? styles.tagActive : ''} ${x.count === 0 ? styles.tagDisabled : ''}`}
                    onClick={() => onPickQuickPattern(x.value, x.label, x.count)}
                  >
                    <span>{x.label}</span>
                    <span className={styles.tagCount}>{x.count == null ? '' : String(x.count)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>过滤</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <select className={styles.input} value={profileKeyScope} onChange={(e) => setProfileKeyScope(e.target.value as any)}>
                  <option value="profileOnly">仅显示当前 Profile 相关 keys</option>
                  <option value="all">显示全部 keys（可能混合 MCP/主程序）</option>
                </select>
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <select className={styles.input} value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as any)}>
                  <option value="all">范围：全部</option>
                  <option value="known">范围：已知结构</option>
                  <option value="unknown">范围：未知/其他</option>
                </select>
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <select className={styles.input} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                  {allCategories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <select className={styles.input} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as any)}>
                  <option value="all">类型：全部</option>
                  <option value="string">类型：文本</option>
                  <option value="list">类型：列表</option>
                  <option value="hash">类型：字典</option>
                  <option value="set">类型：集合</option>
                  <option value="zset">类型：排序集</option>
                </select>
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <select className={styles.input} value={ttlFilter} onChange={(e) => setTtlFilter(e.target.value as any)}>
                  <option value="all">TTL：全部</option>
                  <option value="permanent">TTL：永久</option>
                  <option value="expiring">TTL：即将过期(&lt;60s)</option>
                  <option value="missing">TTL：不存在(-2)</option>
                </select>
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <input className={styles.input} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索：key / 群号 / 用户 / 日期" />
                <button
                  className={styles.btn}
                  onClick={resetFilters}
                  disabled={busy}
                  type="button"
                >
                  重置
                </button>
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>日期范围</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <input className={styles.input} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                <input className={styles.input} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </div>
              <div className={styles.btnRowCompact} style={{ padding: 0, marginTop: 10 }}>
                <button className={styles.btn} onClick={() => applyDatePreset(1)} disabled={busy} type="button">今天</button>
                <button className={styles.btn} onClick={() => applyDatePreset(7)} disabled={busy} type="button">近7天</button>
                <button className={styles.btn} onClick={() => applyDatePreset(30)} disabled={busy} type="button">近30天</button>
                <button className={styles.btn} onClick={() => applyDatePreset(null)} disabled={busy} type="button">清空</button>
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>大小（len）</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <input className={styles.input} inputMode="numeric" value={sizeMin} onChange={(e) => setSizeMin(e.target.value)} placeholder="最小" />
                <input className={styles.input} inputMode="numeric" value={sizeMax} onChange={(e) => setSizeMax(e.target.value)} placeholder="最大" />
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>排序</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <select className={styles.input} value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
                  <option value="ts">按时间</option>
                  <option value="len">按大小</option>
                  <option value="ttl">按 TTL</option>
                  <option value="key">按 Key</option>
                </select>
                <select className={styles.input} value={sortDir} onChange={(e) => setSortDir(e.target.value as any)}>
                  <option value="desc">降序</option>
                  <option value="asc">升序</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className={`${styles.main} ${isCompact && mobilePane !== 'keys' ? styles.mobileHidden : ''}`}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelTitle}>Keys</div>
              <div className={styles.small}>点击一行，右侧查看详情（不会遮挡列表）</div>
            </div>
            <div className={styles.small}>keys={filteredItems.length} / raw={items.length}</div>
          </div>

          {!isCompact ? (
            <div className={styles.tableHeaderMain}>
              <div>Key</div>
              <div>分类</div>
              <div>TTL</div>
              <div>类型</div>
              <div>大小</div>
            </div>
          ) : null}

          <div className={styles.listMain}>
            {busy && !filteredItems.length ? (
              <div className={styles.skeletonList}>
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className={styles.skeletonRow} />
                ))}
              </div>
            ) : null}

            {!busy && items.length > 0 && filteredItems.length === 0 ? (
              <div className={styles.emptyHint}>
                当前筛选条件导致列表为空（raw={items.length}）。
                <div className={styles.btnRow}>
                  <button className={styles.btn} onClick={resetFilters} type="button">一键重置筛选</button>
                </div>
              </div>
            ) : null}

            {filteredItems.map((it) => (
              isCompact ? (
                <div
                  key={it.key}
                  className={`${styles.keyCard} ${selectedKey === it.key ? styles.keyCardActive : ''}`}
                  onClick={() => openPreview(it.key)}
                  title={it.key}
                >
                  <div className={styles.keyCardTop}>
                    <div className={styles.keyCardKey}>{it.key}</div>
                    <div className={styles.keyCardMetaLine}>
                      <span className={styles.badge}>{it.category || '其他'}</span>
                      <span className={`${styles.badge} ${styles[`badgeTtl_${ttlTone(it.ttl)}`]}`}>{formatTtl(it.ttl)}</span>
                      <span className={styles.badge}>{formatRedisType(it.redisType)}</span>
                      <span className={styles.badge}>{it.len == null ? '-' : String(it.len)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key={it.key}
                  className={`${styles.tableRowMain} ${selectedKey === it.key ? styles.rowActive : ''}`}
                  onClick={() => openPreview(it.key)}
                  title={it.key}
                >
                  <div className={styles.keyCell}>{it.key}</div>
                  <div>
                    <span className={styles.badge}>{it.category || '其他'}</span>
                  </div>
                  <div>
                    <span className={`${styles.badge} ${styles[`badgeTtl_${ttlTone(it.ttl)}`]}`}>{formatTtl(it.ttl)}</span>
                  </div>
                  <div>
                    <span className={styles.badge}>{formatRedisType(it.redisType)}</span>
                  </div>
                  <div>
                    <span className={styles.badge}>{it.len == null ? '-' : String(it.len)}</span>
                  </div>
                </div>
              )
            ))}
          </div>
        </div>

        <div className={`${styles.inspector} ${isCompact && mobilePane !== 'detail' ? styles.mobileHidden : ''}`}>
          {isCompact ? (
            <div className={styles.mobileBackRow}>
              <button className={styles.mobileBackBtn} type="button" onClick={() => setMobilePane('keys')}>
                返回
              </button>
              <div className={styles.mobileBackTitle}>{selectedKey ? (selectedKey.length > 28 ? `${selectedKey.slice(0, 28)}…` : selectedKey) : '未选择'}</div>
            </div>
          ) : null}
          <div className={styles.tabs}>
            <button className={`${styles.tabBtn} ${rightTab === 'detail' ? styles.tabBtnActive : ''}`} onClick={() => setRightTab('detail')} type="button">详情</button>
            <button className={`${styles.tabBtn} ${rightTab === 'overview' ? styles.tabBtnActive : ''}`} onClick={() => setRightTab('overview')} type="button">概览</button>
            <button className={`${styles.tabBtn} ${rightTab === 'related' ? styles.tabBtnActive : ''}`} onClick={() => setRightTab('related')} type="button">关联</button>
            <button className={`${styles.tabBtn} ${rightTab === 'danger' ? styles.tabBtnActive : ''}`} onClick={() => setRightTab('danger')} type="button">危险</button>
          </div>

          <div className={styles.inspectorBody}>
            {rightTab === 'detail' ? (
              <>
                <div className={styles.panelHeader} style={{ borderBottom: 'none', padding: 0 }}>
                  <div>
                    <div className={styles.panelTitle}>Key 详情</div>
                    <div className={styles.small}>{selectedItem ? (selectedItem.category || '其他') : '未选择 key'}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className={styles.btn}
                      onClick={async () => {
                        if (!selectedKey) return;
                        try {
                          await navigator.clipboard?.writeText(selectedKey);
                          addToast('success', '已复制 Key');
                        } catch (e: any) {
                          addToast('error', '复制失败', String(e?.message || e));
                        }
                      }}
                      disabled={busy || !selectedKey}
                      type="button"
                    >
                      复制 Key
                    </button>
                    <button className={styles.btn} onClick={() => { setSelectedKey(''); setInspect(null); }} disabled={busy || !selectedKey} type="button">清空选择</button>
                  </div>
                </div>

                {!selectedItem ? (
                  <div className={styles.emptyHint}>从中间列表选择一个 key，即可在这里查看内容预览与原始数据。</div>
                ) : (
                  <>
                    <div className={styles.kvList}>
                      <div className={styles.kvRow}><div className={styles.kvK}>TTL</div><div className={styles.kvV}>{formatTtl(selectedItem.ttl)}</div></div>
                      <div className={styles.kvRow}><div className={styles.kvK}>类型</div><div className={styles.kvV}>{formatRedisType(selectedItem.redisType)}</div></div>
                      <div className={styles.kvRow}><div className={styles.kvK}>大小</div><div className={styles.kvV}>{selectedItem.len == null ? '-' : String(selectedItem.len)}</div></div>
                      {selectedItem.groupId ? (<div className={styles.kvRow}><div className={styles.kvK}>群</div><div className={styles.kvV}>{selectedItem.groupId}</div></div>) : null}
                      {selectedItem.userId ? (<div className={styles.kvRow}><div className={styles.kvK}>用户</div><div className={styles.kvV}>{selectedItem.userId}</div></div>) : null}
                      {selectedItem.date ? (<div className={styles.kvRow}><div className={styles.kvK}>日期</div><div className={styles.kvV}>{selectedItem.date}</div></div>) : null}
                    </div>

                    <div className={styles.detailModeRow}>
                      <button
                        className={`${styles.detailModeBtn} ${detailFocus === 'preview' ? styles.detailModeBtnActive : ''}`}
                        onClick={() => setDetailFocus('preview')}
                        type="button"
                      >
                        预览
                      </button>
                      <button
                        className={`${styles.detailModeBtn} ${detailFocus === 'pairs' ? styles.detailModeBtnActive : ''}`}
                        onClick={() => { setDetailFocus('pairs'); setPairSectionCollapsed(false); }}
                        type="button"
                      >
                        对话对
                      </button>
                      <button
                        className={`${styles.detailModeBtn} ${detailFocus === 'split' ? styles.detailModeBtnActive : ''}`}
                        onClick={() => { setDetailFocus('split'); setPairSectionCollapsed(false); }}
                        type="button"
                      >
                        分屏
                      </button>
                    </div>

                    {selectedItem.category === '群会话状态' && selectedItem.groupId && inspect && typeof inspect === 'object' && String((inspect as any).type || '').toLowerCase() === 'string' && (inspect as any).isJson && (inspect as any).json && typeof (inspect as any).json === 'object' ? (
                      (() => {
                        const json = (inspect as any).json;
                        const conv = Array.isArray(json.conversations) ? json.conversations : [];
                        const byPair = new Map<string, { pairId: string; ts: number | null; count: number }>();
                        const snippetByPair = new Map<string, { user: string; assistant: string }>();
                        const fullByPair = new Map<string, { userText: string; userTs: number | null; assistantText: string; assistantTs: number | null }>();

                        const toText = (v: any) => {
                          if (v == null) return '';
                          if (typeof v === 'string') return v;
                          try { return JSON.stringify(v); } catch { return String(v); }
                        };

                        for (const m of conv) {
                          const pid = m && m.pairId != null ? String(m.pairId) : '';
                          if (!pid) continue;
                          const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
                          const prev = byPair.get(pid);
                          if (!prev) {
                            byPair.set(pid, { pairId: pid, ts, count: 1 });
                          } else {
                            prev.count += 1;
                            if (ts != null) {
                              prev.ts = prev.ts == null ? ts : Math.min(prev.ts, ts);
                            }
                          }

                          const role = String(m?.role || '').toLowerCase();
                          const text = toText(m?.content);
                          if (text && text.trim()) {
                            const sn = snippetByPair.get(pid) || { user: '', assistant: '' };
                            if (role === 'user' && !sn.user) sn.user = text;
                            if (role === 'assistant' && !sn.assistant) sn.assistant = text;
                            snippetByPair.set(pid, sn);

                            const full = fullByPair.get(pid) || { userText: '', userTs: null as number | null, assistantText: '', assistantTs: null as number | null };
                            if (role === 'user') {
                              if (!full.userText || (ts != null && (full.userTs == null || ts < full.userTs))) {
                                full.userText = text;
                                full.userTs = ts;
                              }
                            }
                            if (role === 'assistant') {
                              if (!full.assistantText || (ts != null && (full.assistantTs == null || ts < full.assistantTs))) {
                                full.assistantText = text;
                                full.assistantTs = ts;
                              }
                            }
                            fullByPair.set(pid, full);
                          }
                        }
                        const allRows = Array.from(byPair.values()).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
                        const totalPairs = allRows.length;
                        const query = pairSearchText.trim();
                        const qLower = query.toLowerCase();
                        const isPairIdLike = /^[-_a-zA-Z0-9]{6,}$/.test(query);
                        const mode = pairSearchMode === 'auto' ? (isPairIdLike ? 'pairId' : 'keyword') : pairSearchMode;

                        const matchedAllRows = !query ? allRows : allRows.filter((r) => {
                          if (mode === 'pairId') {
                            const pid = String(r.pairId || '');
                            const shortId = pid.substring(0, 8);
                            return pid.toLowerCase().includes(qLower) || shortId.toLowerCase().includes(qLower);
                          }
                          const pid = String(r.pairId || '');
                          const shortId = pid.substring(0, 8);
                          const sn = snippetByPair.get(pid) || { user: '', assistant: '' };
                          const full = fullByPair.get(pid);
                          const hay = [
                            pid,
                            shortId,
                            sn.user,
                            sn.assistant,
                            full?.userText,
                            full?.assistantText,
                          ].filter(Boolean).join(' ').toLowerCase();
                          return hay.includes(qLower);
                        });

                        const rows = pairListLimit > 0 ? matchedAllRows.slice(0, pairListLimit) : matchedAllRows;
                        const selectedIds = Object.entries(pairSelectedMap).filter(([, v]) => !!v).map(([k]) => k);

                        if (totalPairs === 0) {
                          return (
                            <div className={styles.emptyHint}>
                              该群会话状态未发现可按 pairId 管理的对话记录（conversations 为空）。
                            </div>
                          );
                        }

                        return (
                          <>
                            {detailFocus === 'preview' ? null : (
                              <div className={styles.sectionTitle} style={{ paddingLeft: 0, paddingRight: 0 }}>对话对（pairId）</div>
                            )}

                            {detailFocus === 'preview' ? null : (
                              <div className={styles.pairSection} style={{ maxHeight: detailFocus === 'pairs' ? 540 : 320 }}>
                              <div className={styles.pairHeader}>
                                <div className={styles.pairHeaderTop}>
                                  <div className={styles.pairHeaderLeft}>
                                    <div className={styles.small}>
                                      显示 {rows.length} / {matchedAllRows.length}（总 {totalPairs}）
                                      {selectedIds.length ? ` · 已选 ${selectedIds.length}` : ''}
                                    </div>
                                  </div>
                                  <div className={styles.pairHeaderRight}>
                                    <select className={styles.pairHeaderSelect} value={pairSearchMode} onChange={(e) => setPairSearchMode(e.target.value as any)}>
                                      <option value="auto">自动</option>
                                      <option value="pairId">pairId</option>
                                      <option value="keyword">关键词</option>
                                    </select>
                                    <input
                                      className={styles.pairSearchInput}
                                      value={pairSearchText}
                                      onChange={(e) => setPairSearchText(e.target.value)}
                                      placeholder="检索：pairId 或关键词（U/A 文本）"
                                    />
                                    <select className={styles.pairHeaderSelect} value={String(pairListLimit)} onChange={(e) => setPairListLimit(Number(e.target.value) || 0)}>
                                      <option value="24">24</option>
                                      <option value="100">100</option>
                                      <option value="200">200</option>
                                      <option value="500">500</option>
                                      <option value="0">全部</option>
                                    </select>
                                  </div>
                                </div>

                                <div className={styles.pairHeaderBottom}>
                                  <div className={styles.pairHeaderGroup}>
                                    <button
                                      className={styles.btn}
                                      onClick={() => {
                                        const next: Record<string, boolean> = {};
                                        for (const r of matchedAllRows) next[r.pairId] = true;
                                        setPairSelectedMap(next);
                                      }}
                                      type="button"
                                    >
                                      全选筛选
                                    </button>
                                    <button className={styles.btn} onClick={() => setPairSelectedMap({})} type="button">清空选择</button>
                                  </div>

                                  <div className={styles.pairHeaderGroupRight}>
                                    <button
                                      className={styles.btn}
                                      onClick={() => {
                                        if (!selectedItem.groupId) return;
                                        runPairBulkDeleteDry(selectedItem.groupId, selectedIds);
                                      }}
                                      disabled={!selectedIds.length}
                                      type="button"
                                    >
                                      批量预览移除
                                    </button>
                                    <button
                                      className={`${styles.btn} ${styles.btnDanger}`}
                                      onClick={() => {
                                        if (!selectedItem.groupId) return;
                                        openPairBulkConfirm(selectedItem.groupId, selectedIds);
                                      }}
                                      disabled={!selectedIds.length || !pairBulkDeletePreview || !pairBulkDeletePreview.dryRun}
                                      type="button"
                                    >
                                      批量确认移除
                                    </button>
                                    <div className={styles.pairHeaderDivider} />
                                    <button className={styles.btn} onClick={() => { setPairExpandAll(true); setPairExpandedMap({}); }} type="button">展开全部</button>
                                    <button className={styles.btn} onClick={() => { setPairExpandAll(false); setPairExpandedMap({}); }} type="button">收起全部</button>
                                    <button className={styles.btn} onClick={() => setPairSectionCollapsed((v) => !v)} type="button">
                                      {pairSectionCollapsed ? '展开' : '收起'}
                                    </button>
                                  </div>
                                </div>
                              </div>

                              {!pairSectionCollapsed ? (
                                <div className={styles.pairList}>
                                  {!rows.length ? (
                                    <div className={styles.emptyHint} style={{ marginTop: 0 }}>
                                      未命中检索条件。请调整 pairId/关键词检索，或点击“清空选择”后重新筛选。
                                    </div>
                                  ) : null}
                                  {rows.map((r) => {
                                    const shortId = r.pairId.substring(0, 8);
                                    const isPreview = pairDeletePreview && pairDeletePreview.groupId === selectedItem.groupId && pairDeletePreview.pairId === r.pairId && pairDeletePreview.dryRun;
                                    const isActive = pairSelectedId === r.pairId;
                                    const isChecked = !!pairSelectedMap[r.pairId];
                                    const sn = snippetByPair.get(r.pairId) || { user: '', assistant: '' };
                                    const userLine = sn.user;
                                    const assistantLine = sn.assistant;
                                    const isExpanded = pairExpandAll || !!pairExpandedMap[r.pairId];
                                    const full = fullByPair.get(r.pairId);
                                    return (
                                      <div
                                        key={r.pairId}
                                        className={`${styles.pairRow} ${isActive ? styles.pairRowActive : ''}`}
                                        title={r.pairId}
                                        onClick={() => {
                                          setPairSelectedId(r.pairId);
                                          if (pairExpandAll) return;
                                          setPairExpandedMap((prev) => ({
                                            ...prev,
                                            [r.pairId]: !prev[r.pairId],
                                          }));
                                        }}
                                      >
                                        <div className={styles.pairRowTop}>
                                          <div style={{ minWidth: 0, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                            <label
                                              className={styles.pairCheck}
                                              onClick={(e) => e.stopPropagation()}
                                              title={isChecked ? '取消选择' : '选择'}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={isChecked}
                                                onChange={(e) => {
                                                  const checked = e.target.checked;
                                                  setPairSelectedMap((prev) => ({
                                                    ...prev,
                                                    [r.pairId]: checked,
                                                  }));
                                                }}
                                              />
                                            </label>
                                            <div>
                                              <div className={styles.pairId}>{shortId}</div>
                                              <div className={styles.pairMeta}>messages={r.count}{r.ts ? ` · ${new Date(r.ts).toLocaleString()}` : ''}</div>
                                            </div>
                                          </div>
                                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                            <button className={styles.btn} onClick={(e) => { e.stopPropagation(); runPairDeleteDry(selectedItem.groupId!, r.pairId); }} type="button">预览移除</button>
                                            <button className={`${styles.btn} ${styles.btnDanger}`} onClick={(e) => { e.stopPropagation(); openPairConfirm(selectedItem.groupId!, r.pairId); }} disabled={!isPreview} type="button">确认移除</button>
                                          </div>
                                        </div>

                                        <div className={styles.pairSnippet}>
                                          <div className={styles.pairSnippetLine}>
                                            <div className={styles.pairSnippetLabel}>U</div>
                                            <div className={styles.pairSnippetText}>{userLine ? normalizeMultilineText(userLine) : '-'}</div>
                                          </div>
                                          <div className={styles.pairSnippetLine}>
                                            <div className={styles.pairSnippetLabel}>A</div>
                                            <div className={styles.pairSnippetText}>{assistantLine ? normalizeMultilineText(assistantLine) : '-'}</div>
                                          </div>
                                        </div>

                                        {isExpanded ? (
                                          <div className={styles.pairDetail}>
                                            <div className={styles.pairDetailRow}>
                                              <div className={styles.pairDetailTitle}>User</div>
                                              <div className={styles.pairDetailText}>{full?.userText ? normalizeMultilineText(full.userText) : '-'}</div>
                                            </div>
                                            <div className={styles.pairDetailRow}>
                                              <div className={styles.pairDetailTitle}>Assistant</div>
                                              <div className={styles.pairDetailText}>{full?.assistantText ? normalizeMultilineText(full.assistantText) : '-'}</div>
                                            </div>
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                              </div>
                            )}
                          </>
                        );
                      })()
                    ) : null}

                    {detailFocus === 'pairs' ? null : (
                      <>
                        <div className={styles.sectionTitle} style={{ paddingLeft: 0, paddingRight: 0 }}>内容预览</div>
                        <div className={styles.previewFill}>
                          {inspectPreview ? inspectPreview : <div className={styles.skeletonRow} style={{ flex: 1, minHeight: 220 }} />}
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            ) : null}

            {rightTab === 'overview' ? (
              <>
                <div className={styles.panelHeader} style={{ borderBottom: 'none', padding: 0 }}>
                  <div>
                    <div className={styles.panelTitle}>概览</div>
                    <div className={styles.small}>按 key group 统计数量</div>
                  </div>
                  <button className={styles.btn} onClick={() => loadOverview()} disabled={busy} type="button">刷新</button>
                </div>

                <div className={styles.overviewTableHeader}>
                  <div>分组</div>
                  <div>数量</div>
                  <div>操作</div>
                </div>
                <div className={styles.overviewTable}>
                  {overviewRows.map((r) => (
                    <div key={r.name} className={styles.overviewTableRow}>
                      <div>
                        <div className={styles.overviewName}>{groupNameCn[r.name] || r.name}</div>
                        <div className={styles.keyText}>{r.ptn}</div>
                      </div>
                      <div className={styles.overviewCountCell}>{r.count == null ? '-' : String(r.count)}</div>
                      <div>
                        <button className={styles.btn} onClick={() => { setPattern(r.ptn); setRightTab('detail'); runListFor(r.ptn); }} disabled={busy} type="button">列出</button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {rightTab === 'related' ? (
              <>
                <div className={styles.panelHeader} style={{ borderBottom: 'none', padding: 0 }}>
                  <div>
                    <div className={styles.panelTitle}>关联查询</div>
                    <div className={styles.small}>按群/用户快速定位关联 key</div>
                  </div>
                </div>

                <div className={styles.inputRow}>
                  <input className={styles.input} value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="groupId (可选)" />
                  <input className={styles.input} value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="userId (可选)" />
                  <button className={styles.btn} onClick={() => runRelated()} disabled={busy || (!groupId.trim() && !userId.trim())} type="button">查询</button>
                </div>

                {relatedItems && relatedItems.length ? (
                  <div className={styles.relatedList}>
                    {relatedItems.map((it) => (
                      <div
                        key={it.key}
                        className={styles.relatedRow}
                        onClick={() => { setSelectedKey(it.key); setRightTab('detail'); setDetailFocus('preview'); setPairSelectedId(''); }}
                        title={it.key}
                      >
                        <div className={styles.relatedKey}>{it.key}</div>
                        <div className={styles.relatedMeta}>{it.category || '其他'} · {formatRedisType(it.redisType)} · {formatTtl(it.ttl)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.emptyHint}>输入 groupId / userId 后点击查询。</div>
                )}
              </>
            ) : null}

            {rightTab === 'danger' ? (
              <>
                <div className={styles.panelHeader} style={{ borderBottom: 'none', padding: 0 }}>
                  <div>
                    <div className={styles.panelTitle}>危险操作</div>
                    <div className={styles.small}>批量删除 Key（不可恢复）</div>
                  </div>
                </div>

                <div className={styles.warning} style={{ margin: '10px 0 0' }}>
                  建议先点“预览删除”，确认无误后再删除。
                </div>

                <div className={styles.inputRow} style={{ paddingLeft: 0, paddingRight: 0, borderBottom: 'none' }}>
                  <input className={styles.input} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="例如: sentra:memory:*" />
                </div>
                <div className={styles.btnRow}>
                  <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => runDeleteDry()} disabled={busy || !pattern.trim()} type="button">预览删除</button>
                  <button
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => openDangerConfirm()}
                    disabled={
                      busy ||
                      !pattern.trim() ||
                      !deletePreview ||
                      deletePreview.pattern !== pattern.trim()
                    }
                    type="button"
                  >
                    确认删除
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {confirmOpen ? (
        <div className={styles.modalOverlay} onClick={() => setConfirmOpen(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 96vw)' }}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalTitle}>确认删除</div>
                <div className={styles.small}>此操作会删除匹配 pattern 的 key，且不可恢复。</div>
              </div>
              <div className={styles.modalActions}>
                <button className={styles.btn} onClick={() => setConfirmOpen(false)} type="button">关闭</button>
              </div>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.warning} style={{ margin: 0 }}>
                将删除匹配：{pattern.trim() || '-'}
              </div>
              <div className={styles.small} style={{ marginTop: 8 }}>
                预览结果：
                {deletePreview && deletePreview.pattern === pattern.trim()
                  ? ` requested=${deletePreview.requested}, matched=${deletePreview.deleted}`
                  : '（无预览）'}
              </div>
              <div className={styles.small} style={{ marginTop: 10 }}>
                请输入当前 pattern 以确认：
              </div>
              <div className={styles.inputRow} style={{ padding: '10px 0', borderBottom: 'none' }}>
                <input className={styles.input} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={pattern.trim()} />
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={
                    busy ||
                    !pattern.trim() ||
                    !deletePreview ||
                    deletePreview.pattern !== pattern.trim() ||
                    confirmText.trim() !== pattern.trim()
                  }
                  type="button"
                  onClick={async () => {
                    try {
                      setConfirmOpen(false);
                      await runDeleteConfirm();
                    } finally {
                      setConfirmText('');
                    }
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {pairConfirmOpen && pairDeletePreview ? (
        <div className={styles.modalOverlay} onClick={() => setPairConfirmOpen(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 96vw)' }}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalTitle}>确认移除对话对</div>
                <div className={styles.small}>此操作会修改群会话状态 JSON，仅移除指定 pairId 的历史消息。</div>
              </div>
              <div className={styles.modalActions}>
                <button className={styles.btn} onClick={() => setPairConfirmOpen(false)} type="button">关闭</button>
              </div>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.warning} style={{ margin: 0 }}>
                groupId={pairDeletePreview.groupId}，pairId={pairDeletePreview.shortId}
              </div>
              <div className={styles.small} style={{ marginTop: 8 }}>
                预览结果：deleted.conversations={pairDeletePreview?.stats?.deleted?.conversations ?? '-'}
              </div>
              <div className={styles.small} style={{ marginTop: 10 }}>
                请输入 pairId 前 8 位以确认：
              </div>
              <div className={styles.inputRow} style={{ padding: '10px 0', borderBottom: 'none' }}>
                <input className={styles.input} value={pairConfirmText} onChange={(e) => setPairConfirmText(e.target.value)} placeholder={pairDeletePreview.shortId} />
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={busy || pairConfirmText.trim() !== pairDeletePreview.shortId}
                  type="button"
                  onClick={async () => {
                    try {
                      await runPairDeleteConfirm();
                    } catch (e: any) {
                      addToast('error', '移除失败', String(e?.message || e));
                    }
                  }}
                >
                  移除
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {pairBulkConfirmOpen && pairBulkDeletePreview ? (
        <div className={styles.modalOverlay} onClick={() => { setPairBulkConfirmOpen(false); setPairBulkConfirmText(''); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 96vw)' }}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalTitle}>确认批量移除对话对</div>
                <div className={styles.small}>此操作会修改群会话状态 JSON，仅移除选中的 pairId 历史消息。</div>
              </div>
              <div className={styles.modalActions}>
                <button className={styles.btn} onClick={() => { setPairBulkConfirmOpen(false); setPairBulkConfirmText(''); }} type="button">关闭</button>
              </div>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.warning} style={{ margin: 0 }}>
                groupId={pairBulkDeletePreview.groupId}，pairs={pairBulkDeletePreview.pairIds.length}
              </div>
              <div className={styles.small} style={{ marginTop: 8 }}>
                预览结果：deleted.conversations={pairBulkDeletePreview?.stats?.deleted?.conversations ?? '-'}，deleted.activePairs={pairBulkDeletePreview?.stats?.deleted?.activePairs ?? '-'}
              </div>
              <div className={styles.small} style={{ marginTop: 10 }}>
                请输入移除数量以确认：
              </div>
              <div className={styles.inputRow} style={{ padding: '10px 0', borderBottom: 'none' }}>
                <input
                  className={styles.input}
                  value={pairBulkConfirmText}
                  onChange={(e) => setPairBulkConfirmText(e.target.value)}
                  placeholder={String(pairBulkDeletePreview.pairIds.length)}
                />
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={busy || pairBulkConfirmText.trim() !== String(pairBulkDeletePreview.pairIds.length)}
                  type="button"
                  onClick={async () => {
                    try {
                      await runPairBulkDeleteConfirm();
                    } catch (e: any) {
                      addToast('error', '批量移除失败', String(e?.message || e));
                    }
                  }}
                >
                  批量移除
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
