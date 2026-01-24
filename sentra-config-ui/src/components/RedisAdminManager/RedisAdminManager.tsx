import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './RedisAdminManager.module.css';
import { Alert, Button, Checkbox, Descriptions, Divider, Input, List, Modal, Popover, Segmented, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CopyOutlined, EyeOutlined, SettingOutlined } from '@ant-design/icons';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
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
  setRedisAdminStringValue,
  updateRedisAdminGroupStatePairMessage,
} from '../../services/redisAdminApi';
import { useDevice } from '../../hooks/useDevice';
import { storage } from '../../utils/storage';

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

const MonacoEditor = lazy(async () => {
  await import('../../utils/monacoSetup');
  const mod = await import('@monaco-editor/react');
  return { default: mod.default };
});

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

export function RedisAdminManager(props: { addToast: ToastFn; performanceMode?: boolean }) {
  const { addToast, performanceMode = false } = props;

  const { isMobile, isTablet } = useDevice();
  const isCompact = isMobile || isTablet;
  const [mobilePane, setMobilePane] = useState<'filters' | 'keys' | 'detail'>('filters');
  const [uiTheme, setUiTheme] = useState<'light' | 'dark'>(() => readThemeAttr());
  const [sentraRoot, setSentraRoot] = useState<string>('');
  const [redisInfo, setRedisInfo] = useState<any>(null);

  const [profile, setProfile] = useState<'main' | 'mcp'>(() => {
    const v = storage.getString('redisAdmin.profile', { fallback: 'mcp' });
    return v === 'main' ? 'main' : 'mcp';
  });

  const [errorText, setErrorText] = useState<string>('');

  const [groups, setGroups] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  const [pattern, setPattern] = useState('sentra:');
  const [items, setItems] = useState<RedisKeyItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [inspect, setInspect] = useState<any>(null);
  const [rightTab, setRightTab] = useState<'detail' | 'overview' | 'related' | 'danger'>('detail');
  const [detailFocus, setDetailFocus] = useState<'preview' | 'pairs'>('preview');

  const [categoryFilter, setCategoryFilter] = useState<string>('全部');
  const [keyword, setKeyword] = useState<string>('');

  const profileKeyScope: 'profileOnly' = 'profileOnly';

  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [sizeMin, setSizeMin] = useState<string>('');
  const [sizeMax, setSizeMax] = useState<string>('');
  const [ttlFilter, setTtlFilter] = useState<'all' | 'permanent' | 'expiring' | 'missing'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'string' | 'list' | 'hash' | 'set' | 'zset'>('all');
  const [sortBy, setSortBy] = useState<'ts' | 'len' | 'ttl' | 'key'>('ts');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const [keyTablePage, setKeyTablePage] = useState<number>(() => {
    return storage.getNumber('redisAdmin.keyTablePageSize', { fallback: 1 });
  });
  const [keyTablePageSize, setKeyTablePageSize] = useState<number>(() => {
    const n = storage.getNumber('redisAdmin.keyTablePageSize', { fallback: 50 });
    return Number.isFinite(n) && n > 0 ? n : 50;
  });
  const [keyTableSelectedKeys, setKeyTableSelectedKeys] = useState<string[]>([]);
  const [keyTableColsVisible, setKeyTableColsVisible] = useState<Record<string, boolean>>(() => {
    const parsed = storage.getJson<any>('redisAdmin.keyTableColsVisible', { fallback: {} });
    if (parsed && typeof parsed === 'object') return parsed as any;
    return {};
  });

  const [keyTableScrollY, setKeyTableScrollY] = useState<number>(520);
  const keyTableWrapRef = useRef<HTMLDivElement | null>(null);

  const [groupId, setGroupId] = useState('');
  const [userId, setUserId] = useState('');
  const [relatedItems, setRelatedItems] = useState<RedisKeyItem[]>([]);

  const [busy, setBusy] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deletePreview, setDeletePreview] = useState<{ pattern: string; requested: number; deleted: number; ts: number } | null>(null);

  const [deleteKeyOpen, setDeleteKeyOpen] = useState(false);
  const [deleteKeyConfirmText, setDeleteKeyConfirmText] = useState('');
  const [deleteKeyAcknowledge, setDeleteKeyAcknowledge] = useState(false);
  const [deleteKeyPreview, setDeleteKeyPreview] = useState<{ key: string; requested: number; deleted: number; ts: number } | null>(null);

  const [pairConfirmOpen, setPairConfirmOpen] = useState(false);
  const [pairConfirmText, setPairConfirmText] = useState('');
  const [pairConfirmAcknowledge, setPairConfirmAcknowledge] = useState(false);
  const [pairConfirmTarget, setPairConfirmTarget] = useState<{ groupId: string; pairId: string; shortId: string } | null>(null);
  const [pairSelectedId, setPairSelectedId] = useState<string>('');
  const [pairSectionCollapsed, setPairSectionCollapsed] = useState<boolean>(false);
  const [pairListLimit, setPairListLimit] = useState<number>(200);
  const [pairSearchText, setPairSearchText] = useState<string>('');
  const [pairSearchMode, setPairSearchMode] = useState<'auto' | 'pairId' | 'keyword'>('auto');
  const [pairSelectedMap, setPairSelectedMap] = useState<Record<string, boolean>>({});

  const [pairViewerOpen, setPairViewerOpen] = useState(false);
  const [pairViewerData, setPairViewerData] = useState<{
    groupId: string;
    pairId: string;
    shortId: string;
    count: number;
    ts: number | null;
    userText: string;
    assistantText: string;
    userTs: number | null;
    assistantTs: number | null;
  } | null>(null);

  const [pairValuePreviewOpen, setPairValuePreviewOpen] = useState(false);
  const [pairValuePreviewTitle, setPairValuePreviewTitle] = useState('');
  const [pairValuePreviewText, setPairValuePreviewText] = useState('');
  const [pairValuePreviewCtx, setPairValuePreviewCtx] = useState<null | {
    role: 'user' | 'assistant';
    basePath: string;
    messageJson: any;
    raw: any;
  }>(null);

  const [pairValueEditorOpen, setPairValueEditorOpen] = useState(false);
  const [pairValueEditorTitle, setPairValueEditorTitle] = useState('');
  const [pairValueEditorText, setPairValueEditorText] = useState('');
  const [pairValueEditorCtx, setPairValueEditorCtx] = useState<null | {
    groupId: string;
    pairId: string;
    role: 'user' | 'assistant';
    timestamp: number | null;
    path: string;
    leafType: string;
    baselineShapeSig: string;
    baselineFrozenAttrSig: string;
    baselineJson: any;
  }>(null);

  const [valueEditorOpen, setValueEditorOpen] = useState(false);
  const [valueEditorText, setValueEditorText] = useState('');
  const [valueEditorBaseline, setValueEditorBaseline] = useState<{
    isJson: boolean;
    shapeSig: string;
    frozenAttrSig: string;
    keyCount: number;
    keySamples: string[];
  } | null>(null);

  const [pairBulkConfirmOpen, setPairBulkConfirmOpen] = useState(false);
  const [pairBulkConfirmText, setPairBulkConfirmText] = useState('');
  const [pairBulkConfirmAcknowledge, setPairBulkConfirmAcknowledge] = useState(false);
  const [pairBulkConfirmTarget, setPairBulkConfirmTarget] = useState<{ groupId: string; pairIds: string[]; count: number } | null>(null);

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

  const xmlBuilder = useMemo(() => {
    return new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      format: true,
      suppressEmptyNode: true,
      processEntities: true,
    } as any);
  }, []);

  const joinJsonPath = useCallback((basePath: string, subPath: string) => {
    const base = String(basePath || '').trim();
    const sub = String(subPath || '').trim();
    if (!base) return sub;
    if (!sub) return base;
    if (sub.startsWith('[')) return `${base}${sub}`;
    return `${base}.${sub}`;
  }, []);

  const prefixJsonTreeRows = useCallback((rows: any[], basePath: string): any[] => {
    const prefix = String(basePath || '').trim();
    if (!prefix) return rows;
    const walk = (list: any[]): any[] => {
      return list.map((r) => {
        const next: any = { ...r };
        next.path = joinJsonPath(prefix, String(r?.path || ''));
        next.key = `${String(r?.key || '')}|${prefix}`;
        if (Array.isArray(r?.children) && r.children.length) {
          next.children = walk(r.children);
        }
        return next;
      });
    };
    return walk(rows);
  }, [joinJsonPath]);

  const parsePathTokens = useCallback((path: string): Array<string | number> => {
    const p = String(path || '').trim();
    if (!p) return [];
    const out: Array<string | number> = [];
    let i = 0;
    while (i < p.length) {
      const ch = p[i];
      if (ch === '.') {
        i += 1;
        continue;
      }
      if (ch === '[') {
        const end = p.indexOf(']', i);
        if (end <= i) break;
        const rawIdx = p.slice(i + 1, end);
        const n = Number(rawIdx);
        if (Number.isFinite(n)) out.push(n);
        i = end + 1;
        continue;
      }
      let j = i;
      while (j < p.length && p[j] !== '.' && p[j] !== '[') j += 1;
      const key = p.slice(i, j);
      if (key) out.push(key);
      i = j;
    }
    return out;
  }, []);

  const setJsonLeafAtPath = useCallback((root: any, path: string, value: any) => {
    const tokens = parsePathTokens(path);
    if (!tokens.length) throw new Error('Empty path');
    let cur: any = root;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const t = tokens[i];
      if (typeof t === 'number') {
        if (!Array.isArray(cur)) throw new Error(`Path expects array at ${tokens.slice(0, i).join('.')}`);
        cur = cur[t];
      } else {
        if (!cur || typeof cur !== 'object') throw new Error(`Path expects object at ${tokens.slice(0, i).join('.')}`);
        cur = cur[t];
      }
    }
    const last = tokens[tokens.length - 1];
    if (typeof last === 'number') {
      if (!Array.isArray(cur)) throw new Error(`Path expects array at ${tokens.slice(0, -1).join('.')}`);
      cur[last] = value;
    } else {
      if (!cur || typeof cur !== 'object') throw new Error(`Path expects object at ${tokens.slice(0, -1).join('.')}`);
      cur[last] = value;
    }
  }, [parsePathTokens]);

  const coerceLeafValue = useCallback((leafType: string, text: string) => {
    const t = String(leafType || '').toLowerCase();
    const raw = String(text ?? '');
    if (t === 'string') return { ok: true as const, value: raw };
    if (t === 'number') {
      const n = Number(raw.trim());
      if (!Number.isFinite(n)) return { ok: false as const, error: '请输入合法 number' };
      return { ok: true as const, value: n };
    }
    if (t === 'boolean') {
      const v = raw.trim().toLowerCase();
      if (v !== 'true' && v !== 'false') return { ok: false as const, error: '请输入 true / false' };
      return { ok: true as const, value: v === 'true' };
    }
    if (t === 'null') {
      const v = raw.trim().toLowerCase();
      if (v !== '' && v !== 'null') return { ok: false as const, error: '该节点为 null，只能保持为空或输入 null' };
      return { ok: true as const, value: null };
    }
    return { ok: false as const, error: `不支持编辑的类型：${leafType}` };
  }, []);

  const buildJsonShapeSig = useCallback((input: any) => {
    const parts: string[] = [];
    const keySet = new Set<string>();
    let maxKeySamples = 12;

    const walk = (node: any, path: string) => {
      const t = node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node;
      if (t !== 'object' && t !== 'array') {
        parts.push(`${path}|${t}`);
        return;
      }
      if (t === 'array') {
        const arr = Array.isArray(node) ? node : [];
        parts.push(`${path}|array|len=${arr.length}`);
        for (let i = 0; i < arr.length; i += 1) {
          walk(arr[i], `${path}[${i}]`);
        }
        return;
      }

      const obj = node && typeof node === 'object' ? node : {};
      const keys = Object.keys(obj).sort();
      parts.push(`${path}|object|keys=${keys.join(',')}`);
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        keySet.add(p);
        walk((obj as any)[k], p);
      }
    };

    walk(input, '');
    const keySamples = Array.from(keySet).slice(0, maxKeySamples);
    return {
      shapeSig: parts.join('\n'),
      keyCount: keySet.size,
      keySamples,
    };
  }, []);

  const buildFrozenAttrSig = useCallback((input: any) => {
    const parts: string[] = [];
    const walk = (node: any, path: string) => {
      if (node == null) return;
      if (typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          walk(node[i], `${path}[${i}]`);
        }
        return;
      }
      const keys = Object.keys(node);
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        if (k.startsWith('@_')) {
          parts.push(`${p}=${String((node as any)[k] ?? '')}`);
        }
        walk((node as any)[k], p);
      }
    };
    walk(input, '');
    return parts.sort().join('\n');
  }, []);

  const openPairLeafEditor = useCallback((args: {
    role: 'user' | 'assistant';
    path: string;
    leafType: string;
    leafRaw: any;
    messageJson: any;
  }) => {
    if (!pairViewerData) return;
    const groupId = String(pairViewerData.groupId || '').trim();
    const pairId = String(pairViewerData.pairId || '').trim();
    if (!groupId || !pairId) {
      addToast('error', '无法编辑', '缺少 groupId/pairId');
      return;
    }
    const timestamp = args.role === 'user' ? (pairViewerData.userTs ?? null) : (pairViewerData.assistantTs ?? null);

    const shape = buildJsonShapeSig(args.messageJson);
    const frozen = buildFrozenAttrSig(args.messageJson);

    const leafType = String(args.leafType || '').toLowerCase();
    const initialText = leafType === 'string' ? String(args.leafRaw ?? '') : leafType === 'null' ? '' : String(args.leafRaw ?? '');
    setPairValueEditorTitle(args.path ? `编辑值：${args.path}` : '编辑值');
    setPairValueEditorText(initialText);
    setPairValueEditorCtx({
      groupId,
      pairId,
      role: args.role,
      timestamp,
      path: String(args.path || ''),
      leafType: String(args.leafType || ''),
      baselineShapeSig: shape.shapeSig,
      baselineFrozenAttrSig: frozen,
      baselineJson: args.messageJson,
    });
    setPairValueEditorOpen(true);
  }, [addToast, buildFrozenAttrSig, buildJsonShapeSig, pairViewerData]);

  const savePairLeafEditor = useCallback(async () => {
    if (!pairViewerData) return;
    if (!pairValueEditorCtx) return;

    const ctx = pairValueEditorCtx;
    const coerced = coerceLeafValue(ctx.leafType, pairValueEditorText);
    if (!coerced.ok) {
      addToast('error', '校验失败', coerced.error);
      return;
    }

    let nextJson: any = null;
    try {
      nextJson = JSON.parse(JSON.stringify(ctx.baselineJson));
    } catch {
      addToast('error', '无法保存', 'JSON 深拷贝失败');
      return;
    }

    try {
      setJsonLeafAtPath(nextJson, ctx.path, coerced.value);
    } catch (e: any) {
      addToast('error', '无法保存', String(e?.message || e));
      return;
    }

    const shape = buildJsonShapeSig(nextJson);
    const frozen = buildFrozenAttrSig(nextJson);
    if (shape.shapeSig !== ctx.baselineShapeSig) {
      addToast('error', '结构不允许修改', '检测到节点类型/数组长度/键集合变化');
      return;
    }
    if (frozen !== ctx.baselineFrozenAttrSig) {
      addToast('error', '禁止修改', '检测到 @_xxx 字段变化');
      return;
    }

    let nextXml = '';
    try {
      nextXml = String(xmlBuilder.build(nextJson) || '').trim();
      if (!nextXml.startsWith('<')) throw new Error('XMLBuilder 输出异常');
    } catch (e: any) {
      addToast('error', '无法保存', `XML 构建失败：${String(e?.message || e)}`);
      return;
    }

    setBusy(true);
    setErrorText('');
    try {
      await updateRedisAdminGroupStatePairMessage({
        profile,
        groupId: ctx.groupId,
        pairId: ctx.pairId,
        role: ctx.role,
        content: nextXml,
        timestamp: ctx.timestamp,
      });
      addToast('success', '已保存对话对', `${ctx.role} · ${ctx.path || '-'}`);

      setPairValueEditorOpen(false);
      setPairValueEditorTitle('');
      setPairValueEditorText('');
      setPairValueEditorCtx(null);

      setPairViewerData((prev) => {
        if (!prev) return prev;
        if (ctx.role === 'user') return { ...prev, userText: nextXml };
        return { ...prev, assistantText: nextXml };
      });

      if (selectedKey) {
        const payload = await fetchRedisAdminInspect({ profile, key: String(selectedKey || ''), preview: 1200, head: 5, tail: 5, sample: 12, top: 20 });
        setInspect(payload);
      }
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', '保存失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast, buildFrozenAttrSig, buildJsonShapeSig, coerceLeafValue, pairValueEditorCtx, pairValueEditorText, pairViewerData, profile, selectedKey, setJsonLeafAtPath, xmlBuilder]);

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

  const openDeleteSelectedKey = useCallback(async () => {
    const k = String(selectedKey || '').trim();
    if (!k) return;
    setBusy(true);
    setErrorText('');
    try {
      const payload = await deleteRedisAdminByPattern({ profile, pattern: k, dryRun: true, count: 10 });
      setDeleteKeyPreview({
        key: k,
        requested: Number(payload.requested || 0),
        deleted: Number(payload.deleted || 0),
        ts: Date.now(),
      });
      setDeleteKeyConfirmText('');
      setDeleteKeyAcknowledge(false);
      setDeleteKeyOpen(true);
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', '预览删除失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast, profile, selectedKey]);

  const confirmDeleteSelectedKey = useCallback(async () => {
    const k = String(selectedKey || '').trim();
    if (!k) return;
    if (String(deleteKeyConfirmText || '').trim() !== k) return;
    setBusy(true);
    setErrorText('');
    try {
      await deleteRedisAdminByPattern({ profile, pattern: k, dryRun: false, count: 50 });
      addToast('success', '已删除 Key', k);
      setDeleteKeyOpen(false);
      setDeleteKeyConfirmText('');
      setDeleteKeyAcknowledge(false);
      setDeleteKeyPreview(null);
      setSelectedKey('');
      setInspect(null);
      await loadOverview();
      await runList();
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', '删除失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast, deleteKeyConfirmText, loadOverview, profile, runList, selectedKey]);

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
    storage.setString('redisAdmin.profile', profile);
  }, [profile]);

  useEffect(() => {
    storage.setNumber('redisAdmin.keyTablePageSize', keyTablePageSize);
  }, [keyTablePageSize]);

  useEffect(() => {
    storage.setJson('redisAdmin.keyTableColsVisible', keyTableColsVisible || {});
  }, [keyTableColsVisible]);

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
    setPairSearchText('');
    setPairSearchMode('auto');
    setPairSelectedMap({});
    setPairConfirmOpen(false);
    setPairConfirmText('');
    setPairConfirmAcknowledge(false);
    setPairConfirmTarget(null);
    setPairBulkConfirmOpen(false);
    setPairBulkConfirmText('');
    setPairBulkConfirmAcknowledge(false);
    setPairBulkConfirmTarget(null);
    setPairViewerOpen(false);
    setPairViewerData(null);
    setPairValuePreviewOpen(false);
    setPairValuePreviewTitle('');
    setPairValuePreviewText('');
    setPairValuePreviewCtx(null);

    setPairValueEditorOpen(false);
    setPairValueEditorTitle('');
    setPairValueEditorText('');
    setPairValueEditorCtx(null);

    setValueEditorOpen(false);
    setValueEditorText('');
    setValueEditorBaseline(null);
  }, [selectedKey]);

  const getStringValueForEditing = useCallback((): { ok: true; text: string; isJson: boolean; json: any } | { ok: false; error: string } => {
    if (!inspect || typeof inspect !== 'object') return { ok: false, error: '无 inspect 数据' };
    const t = String((inspect as any).type || '').toLowerCase();
    if (t !== 'string') return { ok: false, error: `仅支持 string key 编辑，当前类型=${t || '-'}` };
    const raw = (inspect as any).value ?? (inspect as any).valuePreview ?? '';
    const text = String(raw ?? '');
    const trimmed = text.trim();
    if (!trimmed) return { ok: true, text, isJson: false, json: null };
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return { ok: true, text, isJson: false, json: null };
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') return { ok: true, text, isJson: false, json: null };
      return { ok: true, text: stringifyForPreview(parsed), isJson: true, json: parsed };
    } catch {
      return { ok: true, text, isJson: false, json: null };
    }
  }, [inspect]);

  const openValueEditor = useCallback(() => {
    const cur = getStringValueForEditing();
    if (!cur.ok) {
      addToast('error', '无法编辑', cur.error);
      return;
    }
    let baseline = {
      isJson: false,
      shapeSig: '',
      frozenAttrSig: '',
      keyCount: 0,
      keySamples: [] as string[],
    };
    if (cur.isJson) {
      const shape = buildJsonShapeSig(cur.json);
      baseline = {
        isJson: true,
        shapeSig: shape.shapeSig,
        frozenAttrSig: buildFrozenAttrSig(cur.json),
        keyCount: shape.keyCount,
        keySamples: shape.keySamples,
      };
    }

    setValueEditorBaseline(baseline);
    setValueEditorText(cur.text);
    setValueEditorOpen(true);
  }, [addToast, buildFrozenAttrSig, buildJsonShapeSig, getStringValueForEditing]);

  const validateJsonEdit = useCallback((baseline: NonNullable<typeof valueEditorBaseline>, nextText: string) => {
    if (!baseline.isJson) return { ok: true as const, json: null as any };
    const raw = String(nextText || '').trim();
    if (!raw) return { ok: false as const, error: 'JSON 不能为空' };
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      return { ok: false as const, error: `JSON 解析失败：${String(e?.message || e)}` };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false as const, error: 'JSON 必须是 object/array' };
    }

    const shape = buildJsonShapeSig(parsed);
    const frozen = buildFrozenAttrSig(parsed);
    if (shape.shapeSig !== baseline.shapeSig) {
      return {
        ok: false as const,
        error: `结构不允许修改：原 key=${baseline.keyCount}（示例：${baseline.keySamples.join(', ') || '-'}）`,
      };
    }
    if (frozen !== baseline.frozenAttrSig) {
      return { ok: false as const, error: '禁止修改 @_xxx 字段（例如 @_name）' };
    }
    return { ok: true as const, json: parsed };
  }, [buildFrozenAttrSig, buildJsonShapeSig, valueEditorBaseline]);

  const saveValueEditor = useCallback(async () => {
    if (!selectedKey) return;
    if (!valueEditorBaseline) return;

    const nextText = String(valueEditorText ?? '');
    const baseline = valueEditorBaseline;
    const validate = validateJsonEdit(baseline, nextText);
    if (!(validate as any).ok) {
      addToast('error', '校验失败', (validate as any).error);
      return;
    }

    setBusy(true);
    setErrorText('');
    try {
      await setRedisAdminStringValue({ profile, key: selectedKey, value: nextText });
      addToast('success', '保存成功', selectedKey);
      setValueEditorOpen(false);
      setValueEditorText('');
      setValueEditorBaseline(null);
      await runInspect(String(selectedKey || ''));
      await loadOverview();
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', '保存失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast, loadOverview, profile, runInspect, selectedKey, validateJsonEdit, valueEditorBaseline, valueEditorText]);

  const xmlParser = useMemo(() => {
    return new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: true,
      parseTagValue: true,
      trimValues: true,
      allowBooleanAttributes: true,
    });
  }, []);

  const parseXmlToJson = useCallback((text: string) => {
    const raw = String(text || '').trim();
    if (!raw || !raw.startsWith('<')) return { ok: false as const, json: null as any, error: raw ? '非 XML 文本' : '空内容' };
    try {
      const json = xmlParser.parse(raw);
      return { ok: true as const, json, error: '' };
    } catch (e: any) {
      return { ok: false as const, json: null as any, error: String(e?.message || e) };
    }
  }, [xmlParser]);

  type JsonTreeRow = {
    key: string;
    name: string;
    path: string;
    type: string;
    value: string;
    raw: any;
    children?: JsonTreeRow[];
  };

  const formatPreviewValue = useCallback((v: any) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }, []);

  const makePairValuePreviewCols = useCallback((ctx: NonNullable<typeof pairValuePreviewCtx>): ColumnsType<any> => [
    {
      title: '节点',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      ellipsis: true,
      render: (v: any) => <Typography.Text style={{ fontSize: 12, fontWeight: 800 }}>{String(v || '')}</Typography.Text>,
    },
    {
      title: '路径',
      dataIndex: 'path',
      key: 'path',
      width: 420,
      ellipsis: true,
      render: (v: any) => (
        <Typography.Text code copyable={{ text: String(v || '') }} style={{ fontSize: 12 }}>
          {String(v || '')}
        </Typography.Text>
      ),
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      ellipsis: true,
      render: (_: any, r: any) => {
        const txt = formatPreviewValue(r?.raw);
        const short = txt.length > 220 ? `${txt.slice(0, 220)}…` : txt;
        const isLeaf = r?.type && String(r.type) !== 'object' && String(r.type) !== 'array' && String(r.type) !== 'limit';
        const forbidAttr = typeof r?.path === 'string' && r.path.split('.').some((seg: string) => seg.startsWith('@_'));
        return (
          <Tooltip title={txt.length > 220 ? '点击查看完整内容' : null}>
            <span style={{ display: 'inline-block', maxWidth: '100%' }}>
              <Typography.Text
                copyable={{ text: txt }}
                style={{ fontSize: 12, wordBreak: 'break-word', cursor: 'pointer' }}
                onClick={() => {
                  if (forbidAttr) {
                    addToast('error', '禁止编辑', '不允许修改 @_ 属性字段');
                    return;
                  }
                  if (isLeaf) {
                    openPairLeafEditor({
                      role: ctx.role,
                      path: String(r?.path || ''),
                      leafType: String(r?.type || ''),
                      leafRaw: r?.raw,
                      messageJson: ctx.messageJson,
                    });
                    return;
                  }
                  setPairValuePreviewTitle(r?.path ? `值详情：${r.path}` : '值详情');
                  setPairValuePreviewText(txt);
                  setPairValuePreviewCtx({
                    role: ctx.role,
                    basePath: String(r?.path || ''),
                    messageJson: ctx.messageJson,
                    raw: r?.raw,
                  });
                }}
              >
                {short}
              </Typography.Text>
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (v: any) => <Tag>{String(v || '')}</Tag>,
    },
  ], [addToast, formatPreviewValue, openPairLeafEditor]);

  const buildJsonTreeRows = useCallback((input: any, opts?: { maxNodes?: number; maxDepth?: number }) => {
    const maxNodes = Math.max(50, Number(opts?.maxNodes ?? 1600));
    const maxDepth = Math.max(3, Number(opts?.maxDepth ?? 18));
    let count = 0;

    const getType = (v: any) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

    const summarize = (v: any) => {
      const t = getType(v);
      if (t === 'string') {
        const s = String(v);
        return s.length > 140 ? `${s.slice(0, 140)}…` : s;
      }
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
      if (t === 'undefined') return 'undefined';
      if (t === 'null') return 'null';
      if (t === 'array') return `[${Array.isArray(v) ? v.length : 0}]`;
      if (t === 'object') {
        const keys = v && typeof v === 'object' ? Object.keys(v) : [];
        return `{${keys.length}}`;
      }
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };

    const walk = (node: any, name: string, path: string, depth: number): JsonTreeRow | null => {
      if (count >= maxNodes) {
        return {
          key: `limit:${path}:${count}`,
          name: '…',
          path,
          type: 'limit',
          value: `已达到展示上限（${maxNodes}）`,
          raw: null,
        };
      }
      count += 1;

      const t = getType(node);
      const row: JsonTreeRow = {
        key: `${count}:${path || name || 'root'}`,
        name: name || '(root)',
        path,
        type: t,
        value: summarize(node),
        raw: node,
      };

      if (depth >= maxDepth) {
        return row;
      }

      if (node && typeof node === 'object') {
        if (Array.isArray(node)) {
          const children: JsonTreeRow[] = [];
          for (let i = 0; i < node.length; i += 1) {
            if (count >= maxNodes) break;
            const childPath = path ? `${path}[${i}]` : `[${i}]`;
            const child = walk(node[i], `[${i}]`, childPath, depth + 1);
            if (child) children.push(child);
          }
          if (children.length) row.children = children;
        } else {
          const keys = Object.keys(node);
          const children: JsonTreeRow[] = [];
          for (const k of keys) {
            if (count >= maxNodes) break;
            const childPath = path ? `${path}.${k}` : k;
            const child = walk((node as any)[k], k, childPath, depth + 1);
            if (child) children.push(child);
          }
          if (children.length) row.children = children;
        }
      }
      return row;
    };

    const root = walk(input, '(root)', '', 0);
    if (!root) return [];
    if ((root.type === 'object' || root.type === 'array') && Array.isArray(root.children) && root.children.length) {
      return root.children;
    }
    return [root];
  }, []);

  const extractRedisKeyRefs = useCallback((input: any, opts?: { maxRefs?: number }) => {
    const maxRefs = Math.max(10, Number(opts?.maxRefs ?? 120));
    const out: Array<{ path: string; key: string }> = [];
    const seen = new Set<string>();
    const keyRe = /(sentra:[^\s"'<>]{3,})/gi;

    const walk = (node: any, path: string) => {
      if (out.length >= maxRefs) return;
      if (node == null) return;
      if (typeof node === 'string') {
        const s = node;
        const m = s.match(keyRe);
        if (m && m.length) {
          for (const raw of m) {
            if (out.length >= maxRefs) break;
            const k = String(raw || '').trim();
            if (!k) continue;
            const sig = `${path}=>${k}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            out.push({ path, key: k });
          }
        }
        return;
      }
      if (typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          if (out.length >= maxRefs) break;
          walk(node[i], path ? `${path}[${i}]` : `[${i}]`);
        }
        return;
      }
      for (const k of Object.keys(node)) {
        if (out.length >= maxRefs) break;
        walk((node as any)[k], path ? `${path}.${k}` : k);
      }
    };

    walk(input, '');
    return out;
  }, []);

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

  const openPairConfirm = useCallback((groupId: string, pairId: string) => {
    const gid = String(groupId || '').trim();
    const pid = String(pairId || '').trim();
    if (!gid || !pid) return;
    const shortId = pid.substring(0, 8);
    setPairConfirmText('');
    setPairConfirmAcknowledge(false);
    setPairConfirmTarget({ groupId: gid, pairId: pid, shortId });
    setPairConfirmOpen(true);
  }, []);

  const openPairBulkConfirm = useCallback((groupId: string, pairIds: string[]) => {
    const gid = String(groupId || '').trim();
    const uniq = Array.from(new Set((pairIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (!gid || !uniq.length) return;
    setPairBulkConfirmText('');
    setPairBulkConfirmAcknowledge(false);
    setPairBulkConfirmTarget({ groupId: gid, pairIds: uniq, count: uniq.length });
    setPairBulkConfirmOpen(true);
  }, []);

  const runPairDeleteConfirm = useCallback(async () => {
    if (!pairConfirmTarget) return;
    const gid = pairConfirmTarget.groupId;
    const pid = pairConfirmTarget.pairId;
    const shortId = pairConfirmTarget.shortId;
    await deleteRedisAdminGroupStatePairs({ profile, groupId: gid, pairIds: [pid], dryRun: false });
    addToast('success', '已移除对话对', `pairId=${shortId}`);
    setPairConfirmOpen(false);
    setPairConfirmText('');
    setPairConfirmAcknowledge(false);
    setPairConfirmTarget(null);
    setPairViewerOpen(false);
    setPairViewerData(null);
    try {
      await runInspect(String(selectedKey || ''));
    } catch {}
    try {
      await runList();
    } catch {}
  }, [pairConfirmTarget, profile, addToast, runInspect, selectedKey, runList]);

  const runPairBulkDeleteConfirm = useCallback(async () => {
    if (!pairBulkConfirmTarget) return;
    const gid = pairBulkConfirmTarget.groupId;
    const pairIds = pairBulkConfirmTarget.pairIds;
    await deleteRedisAdminGroupStatePairs({ profile, groupId: gid, pairIds, dryRun: false });
    addToast('success', '已批量移除对话对', `pairs=${pairIds.length}`);
    setPairBulkConfirmOpen(false);
    setPairBulkConfirmText('');
    setPairBulkConfirmAcknowledge(false);
    setPairBulkConfirmTarget(null);
    setPairSelectedMap({});
    try {
      await runInspect(String(selectedKey || ''));
    } catch {}
    try {
      await runList();
    } catch {}
  }, [pairBulkConfirmTarget, profile, addToast, runInspect, selectedKey, runList]);

  const resetFilters = useCallback(() => {
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
  }, [items, categoryFilter, dateFrom, dateTo, keyword, sizeMax, sizeMin, sortBy, sortDir, ttlFilter, typeFilter, profile, profileKeyScope]);

  useEffect(() => {
    setKeyTablePage(1);
    setKeyTableSelectedKeys([]);
  }, [profile, pattern, categoryFilter, typeFilter, ttlFilter, keyword, dateFrom, dateTo, sizeMin, sizeMax, sortBy, sortDir]);

  useEffect(() => {
    const el = keyTableWrapRef.current;
    if (!el) return;
    const compute = () => {
      const h = el.clientHeight;
      // reserve some space for pagination/footer + padding
      const next = Math.max(240, Math.floor(h - 140));
      setKeyTableScrollY(next);
    };
    compute();
    const ro = new ResizeObserver(() => compute());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    return filteredItems.find((x) => x.key === selectedKey) || items.find((x) => x.key === selectedKey) || null;
  }, [filteredItems, items, selectedKey]);

  const pairContext = useMemo(() => {
    if (!selectedItem || !inspect || typeof inspect !== 'object') return { ok: false as const };
    const t = String((inspect as any).type || '').toLowerCase();
    const isJson = !!(inspect as any).isJson;
    const jsonMarked = (inspect as any).json;

    const resolveJson = (): any | null => {
      if (isJson && jsonMarked && typeof jsonMarked === 'object') return jsonMarked;
      if (t !== 'string') return null;
      const raw = (inspect as any).valuePreview ?? (inspect as any).value ?? '';
      const text = String(raw || '').trim();
      if (!text) return null;
      if (!(text.startsWith('{') || text.startsWith('['))) return null;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
      } catch {
        return null;
      }
    };

    const json = resolveJson();
    if (!json || typeof json !== 'object') return { ok: false as const };

    const conv = Array.isArray((json as any).conversations) ? (json as any).conversations : [];
    const hasPairId = conv.some((m: any) => m && m.pairId != null && String(m.pairId).trim());
    if (!hasPairId) return { ok: false as const };

    const uniqPairIds = new Set<string>();
    for (const m of conv) {
      const pid = m && m.pairId != null ? String(m.pairId).trim() : '';
      if (pid) uniqPairIds.add(pid);
    }
    const pairCount = uniqPairIds.size;

    const key = String(selectedItem.key || '');
    const gidFromKey = (() => {
      const patterns = [
        /sentra:group:([^:]+)(:|$)/i,
        /sentra:conv:group:([^:]+)(:|$)/i,
        /sentra:conversation_group:([^:]+)(:|$)/i,
      ];
      for (const re of patterns) {
        const m = key.match(re);
        if (m && m[1]) return String(m[1]);
      }
      return '';
    })();
    const groupId = String(
      selectedItem.groupId ||
      (json as any).groupId ||
      (json as any).group_id ||
      (json as any).gid ||
      gidFromKey ||
      ''
    ).trim();

    return { ok: true as const, json, groupId, conversations: conv, pairCount };
  }, [inspect, selectedItem]);

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

    const renderDesktop = (title: string, language: string, text: string) => {
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>{title}</div>
          <div className={styles.editorBox} style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
            <Suspense fallback={<pre className={styles.previewPre}>{text}</pre>}>
              <MonacoEditor
                height="100%"
                language={language}
                value={text}
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
            </Suspense>
          </div>
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
      const text = isJson ? stringifyForPreview(json ?? {}) : normalizeMultilineText(v);
      return renderDesktop('文本预览', isJson ? 'json' : 'plaintext', text);
    }

    if (t === 'list') {
      const len = (inspect as any).len;
      const head = Array.isArray((inspect as any).head) ? (inspect as any).head : [];

      if (isCompact) {
        return renderMobilePre(`列表预览（共 ${len ?? '-'} 条）`, stringifyForPreview(head));
      }
      return renderDesktop(`列表预览（共 ${len ?? '-'} 条）`, 'json', stringifyForPreview(head));
    }

    if (t === 'hash') {
      const len = (inspect as any).len;
      const fields = (inspect as any).fields;

      if (isCompact) {
        return renderMobilePre(`字典预览（共 ${len ?? '-'} 个字段）`, stringifyForPreview(fields));
      }
      return renderDesktop(`字典预览（共 ${len ?? '-'} 个字段）`, 'json', stringifyForPreview(fields));
    }

    if (t === 'zset') {
      const len = (inspect as any).len;
      const top = (inspect as any).top;

      if (isCompact) {
        return renderMobilePre(`排序集预览（共 ${len ?? '-'} 条）`, stringifyForPreview(top));
      }
      return renderDesktop(`排序集预览（共 ${len ?? '-'} 条）`, 'json', stringifyForPreview(top));
    }

    if (t === 'set') {
      const len = (inspect as any).len;
      const sample = (inspect as any).sample;

      if (isCompact) {
        return renderMobilePre(`集合预览（共 ${len ?? '-'} 条）`, stringifyForPreview(sample));
      }
      return renderDesktop(`集合预览（共 ${len ?? '-'} 条）`, 'json', stringifyForPreview(sample));
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

  const keyTableColumnsAll = useMemo(() => {
    const sortOrderFor = (k: 'key' | 'ttl' | 'redisType' | 'len') => {
      const map: Record<string, 'key' | 'ttl' | 'len' | null> = {
        key: 'key',
        ttl: 'ttl',
        len: 'len',
        redisType: null,
      };
      const sb = map[k];
      if (!sb) return undefined;
      if (sortBy !== sb) return undefined;
      return sortDir === 'asc' ? 'ascend' : 'descend';
    };

    const cols: ColumnsType<RedisKeyItem> = [
      {
        title: 'Key',
        dataIndex: 'key',
        key: 'key',
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderFor('key'),
        render: (k: any) => (
          <Tooltip title={String(k || '')}>
            <div className={styles.keyCell}>{String(k || '')}</div>
          </Tooltip>
        ),
      },
      {
        title: '分类',
        dataIndex: 'category',
        key: 'category',
        width: 110,
        render: (v: any) => (
          <span className={styles.badge}>{String(v || '其他')}</span>
        ),
      },
      {
        title: 'TTL',
        dataIndex: 'ttl',
        key: 'ttl',
        width: 90,
        sorter: true,
        sortOrder: sortOrderFor('ttl'),
        render: (v: any) => (
          <span className={`${styles.badge} ${styles[`badgeTtl_${ttlTone(v as any)}`]}`}>{formatTtl(v as any)}</span>
        ),
      },
      {
        title: '类型',
        dataIndex: 'redisType',
        key: 'redisType',
        width: 90,
        render: (v: any) => (
          <span className={styles.badge}>{formatRedisType(v as any)}</span>
        ),
      },
      {
        title: '大小',
        dataIndex: 'len',
        key: 'len',
        width: 90,
        sorter: true,
        sortOrder: sortOrderFor('len'),
        render: (v: any) => (
          <span className={styles.badge}>{v == null ? '-' : String(v)}</span>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 120,
        render: (_v: any, r) => (
          <Space size={6}>
            <Tooltip title="复制 Key">
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  const k = String(r?.key || '');
                  if (!k) return;
                  navigator.clipboard?.writeText(k)
                    .then(() => addToast('success', '已复制 Key'))
                    .catch((err) => addToast('error', '复制失败', String((err as any)?.message || err)));
                }}
              />
            </Tooltip>
            <Tooltip title="查看详情">
              <Button
                size="small"
                type="text"
                icon={<EyeOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  openPreview(r.key);
                }}
              />
            </Tooltip>
          </Space>
        ),
      },
    ];
    return cols;
  }, [addToast, openPreview, sortBy, sortDir]);

  const keyTableColumnOptions = useMemo(() => {
    const base = [
      { key: 'key', label: 'Key', locked: true },
      { key: 'category', label: '分类', locked: false },
      { key: 'ttl', label: 'TTL', locked: false },
      { key: 'redisType', label: '类型', locked: false },
      { key: 'len', label: '大小', locked: false },
      { key: 'actions', label: '操作', locked: true },
    ];
    return base;
  }, []);

  const keyTableColumns = useMemo(() => {
    const visibleMap = keyTableColsVisible || {};
    return keyTableColumnsAll.filter((c) => {
      const k = String((c as any).key || '');
      if (k === 'key' || k === 'actions') return true;
      const v = visibleMap[k];
      return v !== false;
    });
  }, [keyTableColsVisible, keyTableColumnsAll]);

  const applyTableSort = useCallback((columnKey: string | number | undefined, order: 'ascend' | 'descend' | undefined) => {
    const ck = String(columnKey || '');
    if (!order) return;
    if (ck === 'key') {
      setSortBy('key');
      setSortDir(order === 'ascend' ? 'asc' : 'desc');
      return;
    }
    if (ck === 'ttl') {
      setSortBy('ttl');
      setSortDir(order === 'ascend' ? 'asc' : 'desc');
      return;
    }
    if (ck === 'len') {
      setSortBy('len');
      setSortDir(order === 'ascend' ? 'asc' : 'desc');
      return;
    }
  }, []);

  const copySelectedKeys = useCallback(async () => {
    const list = (keyTableSelectedKeys || []).map(String).filter(Boolean);
    if (!list.length) return;
    const text = list.join('\n');
    try {
      await navigator.clipboard?.writeText(text);
      addToast('success', '已复制选中 Keys', `count=${list.length}`);
    } catch (e: any) {
      addToast('error', '复制失败', String(e?.message || e));
    }
  }, [addToast, keyTableSelectedKeys]);

  return (
    <div className={`${styles.root} ${isCompact ? styles.mobileRoot : ''}`}>
      <Modal
        title="删除 Key"
        open={deleteKeyOpen}
        className={styles.deleteKeyModal}
        getContainer={false}
        onCancel={() => {
          setDeleteKeyOpen(false);
          setDeleteKeyConfirmText('');
          setDeleteKeyAcknowledge(false);
        }}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{
          danger: true,
          disabled:
            !selectedKey ||
            !deleteKeyAcknowledge ||
            String(deleteKeyConfirmText || '').trim() !== String(selectedKey || '').trim(),
          loading: busy,
        }}
        onOk={() => void confirmDeleteSelectedKey()}
      >
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <Alert
            type="error"
            showIcon
            title="危险操作：删除 Redis Key"
            description="该操作不可恢复，会永久删除这个 Key 及其对应的数据。请确认你删除的是精确 Key（不是 pattern 批量删除）。"
          />

          <Divider style={{ margin: '12px 0' }} />

          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Profile">{profile || '-'}</Descriptions.Item>
            <Descriptions.Item label="Key">
              <Typography.Text
                code
                copyable={selectedKey ? { text: String(selectedKey) } : false}
                style={{ wordBreak: 'break-all' }}
              >
                {selectedKey || '-'}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="删除预览(dry-run)">
              {deleteKeyPreview && deleteKeyPreview.key === selectedKey ? (
                <span>
                  requested={deleteKeyPreview.requested} deleted={deleteKeyPreview.deleted}
                </span>
              ) : (
                '-'
              )}
            </Descriptions.Item>
          </Descriptions>

          <div style={{ marginTop: 10 }}>
            <Alert
              type="warning"
              showIcon
              title="说明"
              description="这里显示的是 dry-run 结果，实际删除以最终执行为准。"
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <Checkbox checked={deleteKeyAcknowledge} onChange={(e) => setDeleteKeyAcknowledge(e.target.checked)}>
              我已理解该 Key 将被永久删除且无法恢复
            </Checkbox>
          </div>

          <div style={{ marginTop: 10, color: 'var(--redis-danger-text)' }}>
            为防误删，请在下方输入 <b>完整 Key</b> 以确认：
          </div>
          <Input
            value={deleteKeyConfirmText}
            onChange={(e) => setDeleteKeyConfirmText(e.target.value)}
            placeholder={selectedKey ? String(selectedKey) : '粘贴完整 Key'}
            size="middle"
            autoComplete="off"
            style={{ marginTop: 8 }}
          />
        </div>
      </Modal>

      <Modal
        open={pairValueEditorOpen && !!pairValueEditorCtx}
        onCancel={() => {
          setPairValueEditorOpen(false);
          setPairValueEditorTitle('');
          setPairValueEditorText('');
          setPairValueEditorCtx(null);
        }}
        footer={null}
        width="min(1100px, 96vw)"
        title={pairValueEditorTitle || '编辑值'}
        destroyOnHidden
        styles={{ body: { height: '70vh', overflow: 'hidden' } }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="对话对编辑：仅允许修改叶子值；保存时会校验结构不变，并禁止修改 @_ 属性字段。"
            description={pairValueEditorCtx ? `${pairValueEditorCtx.role} · ${pairValueEditorCtx.path || '-'}` : undefined}
          />

          <div style={{ flex: 1, minHeight: 0 }}>
            {isCompact ? (
              <Input.TextArea
                value={pairValueEditorText}
                onChange={(e) => setPairValueEditorText(e.target.value)}
                style={{ height: '100%' }}
              />
            ) : (
              <Suspense fallback={<pre className={styles.previewPre}>{pairValueEditorText || '-'}</pre>}>
                <MonacoEditor
                  height="100%"
                  language={pairValueEditorCtx?.leafType === 'number' ? 'plaintext' : 'plaintext'}
                  value={pairValueEditorText}
                  theme={uiTheme === 'dark' ? 'hc-black' : 'light'}
                  onChange={(v) => setPairValueEditorText(String(v ?? ''))}
                  options={{
                    readOnly: false,
                    minimap: { enabled: false },
                    fontSize: 12,
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    lineNumbers: 'on',
                    folding: false,
                    renderLineHighlight: 'none',
                    scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                    automaticLayout: true,
                    overviewRulerLanes: 0,
                  }}
                />
              </Suspense>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <Button
              size="small"
              onClick={() => {
                setPairValueEditorOpen(false);
                setPairValueEditorTitle('');
                setPairValueEditorText('');
                setPairValueEditorCtx(null);
              }}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={() => void savePairLeafEditor()}
              disabled={busy || !pairValueEditorCtx}
            >
              保存
            </Button>
          </div>
        </div>
      </Modal>

      <div className={styles.topBar}>
        <div className={styles.headerLeft}>
          <div className={styles.headerTitleRow}>
            <div className={styles.headerBadge}>{busy ? '加载中' : '可用'}</div>
          </div>
          <div className={styles.headerMetaRow}>
            <div className={styles.pill}><span className={styles.pillLabel}>Root</span>{sentraRoot || '-'}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>Profile</span>{profile}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>Pattern</span>{pattern.trim() || '-'}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>列表</span>{String(filteredItems.length)}</div>
          </div>
        </div>

        <div className={styles.headerActions}>
          <Button size="small" onClick={() => init()} disabled={busy}>刷新</Button>
        </div>
      </div>

      {isCompact ? (
        <div className={styles.mobileStepBar}>
          <Segmented
            size="small"
            className={styles.mobileStepSegmented}
            value={mobilePane}
            onChange={(v) => setMobilePane(v as any)}
            options={[
              { label: '筛选', value: 'filters' },
              { label: (<span>Keys <span className={styles.mobileStepCount}>{filteredItems.length}</span></span>), value: 'keys' },
              { label: '详情', value: 'detail' },
            ]}
          />
        </div>
      ) : null}

      <div className={`${styles.workspace} ${isCompact ? styles.workspaceMobile : ''}`}>
        <div className={`${styles.sidebar} ${isCompact && mobilePane !== 'filters' ? styles.mobileHidden : ''}`}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelTitle}>左侧筛选，中间列表，右侧详情</div>
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

              <Alert
                type="info"
                showIcon
                title="连接信息"
                description="这里展示当前 Redis Admin 连接来源与基础信息等等"
              />

              <Descriptions className={styles.sidebarDescriptions} size="small" column={1} bordered style={{ marginTop: 10 }}>
                <Descriptions.Item label="Profile">
                  <Segmented
                    size="small"
                    block
                    className={styles.profileSegmented}
                    value={profile}
                    options={[
                      { label: '主程序', value: 'main' },
                      { label: 'MCP', value: 'mcp' },
                    ]}
                    onChange={(v) => setProfile(String(v) as any)}
                  />
                </Descriptions.Item>
                <Descriptions.Item label="Root">
                  <Typography.Text
                    copyable={sentraRoot ? { text: String(sentraRoot) } : false}
                    style={{ wordBreak: 'break-all' }}
                  >
                    {sentraRoot || '-'}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="Env">
                  <Typography.Text
                    copyable={redisInfo?.envPath ? { text: String(redisInfo.envPath) } : false}
                    style={{ wordBreak: 'break-all' }}
                  >
                    {String(redisInfo?.envPath || '-')}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="Redis">
                  <Typography.Text
                    copyable={redisInfo?.host ? { text: `${redisInfo.host}:${redisInfo.port ?? ''}` } : false}
                    style={{ wordBreak: 'break-all' }}
                  >
                    {redisInfo?.host ? `${redisInfo.host}:${redisInfo.port ?? '-'}` : '-'}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="DB">{redisInfo?.db ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="密码">
                  {redisInfo?.hasPassword ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>}
                </Descriptions.Item>
              </Descriptions>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>Pattern</div>

              <div className={styles.patternNative}>
                <input
                  className={styles.patternNativeInput}
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="例如: sentra:group:* 或 sentra:memory:*"
                />
                <button
                  type="button"
                  className={styles.patternNativeBtn}
                  onClick={() => {
                    setRightTab('detail');
                    runList();
                    if (isCompact) setMobilePane('keys');
                  }}
                  disabled={busy || !pattern.trim()}
                >
                  列出
                </button>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className={styles.small} style={{ marginBottom: 8 }}>快捷分组（点击即可套用 pattern）</div>
                <div className={styles.quickTagsWrap}>
                  {(profile === 'main' ? quickPatternsByProfile.main : quickPatternsByProfile.mcp).map((x: QuickPatternItem) => (
                    <Tag.CheckableTag
                      key={x.value}
                      className={styles.quickCheckTag}
                      checked={pattern.trim() === x.value}
                      onChange={() => {
                        if (x.count === 0) return;
                        onPickQuickPattern(x.value, x.label, x.count);
                      }}
                    >
                      <span>{x.label}</span>
                      <span className={styles.quickTagCount}>{x.count == null ? '' : String(x.count)}</span>
                    </Tag.CheckableTag>
                  ))}
                </div>
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>过滤</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <Select
                  className={styles.antdSelect}
                  value={categoryFilter}
                  onChange={(v) => setCategoryFilter(String(v))}
                  options={allCategories.map((c) => ({ value: c, label: c }))}
                  size="small"
                  showSearch
                />
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <Select
                  className={styles.antdSelect}
                  value={typeFilter}
                  onChange={(v) => setTypeFilter(v as any)}
                  options={[
                    { value: 'all', label: '类型：全部' },
                    { value: 'string', label: '类型：文本' },
                    { value: 'list', label: '类型：列表' },
                    { value: 'hash', label: '类型：字典' },
                    { value: 'set', label: '类型：集合' },
                    { value: 'zset', label: '类型：排序集' },
                  ]}
                  size="small"
                />
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <Select
                  className={styles.antdSelect}
                  value={ttlFilter}
                  onChange={(v) => setTtlFilter(v as any)}
                  options={[
                    { value: 'all', label: 'TTL：全部' },
                    { value: 'permanent', label: 'TTL：永久' },
                    { value: 'expiring', label: 'TTL：即将过期(<60s)' },
                    { value: 'missing', label: 'TTL：不存在(-2)' },
                  ]}
                  size="small"
                />
              </div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none', marginTop: 10 }}>
                <Input
                  className={styles.antdInput}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索：key / 群号 / 用户 / 日期"
                  size="small"
                />
                <Button size="small" onClick={resetFilters} disabled={busy}>
                  重置
                </Button>
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>日期范围</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <Input className={styles.antdInput} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} size="small" />
                <Input className={styles.antdInput} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} size="small" />
              </div>
              <div className={styles.btnRowCompact} style={{ padding: 0, marginTop: 10 }}>
                <Button size="small" onClick={() => applyDatePreset(1)} disabled={busy}>今天</Button>
                <Button size="small" onClick={() => applyDatePreset(7)} disabled={busy}>近7天</Button>
                <Button size="small" onClick={() => applyDatePreset(30)} disabled={busy}>近30天</Button>
                <Button size="small" onClick={() => applyDatePreset(null)} disabled={busy}>清空</Button>
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>大小（len）</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <Input className={styles.antdInput} inputMode="numeric" value={sizeMin} onChange={(e) => setSizeMin(e.target.value)} placeholder="最小" size="small" />
                <Input className={styles.antdInput} inputMode="numeric" value={sizeMax} onChange={(e) => setSizeMax(e.target.value)} placeholder="最大" size="small" />
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>排序</div>
              <div className={styles.inputRow} style={{ padding: 0, borderBottom: 'none' }}>
                <Select
                  className={styles.antdSelect}
                  value={sortBy}
                  onChange={(v) => setSortBy(v as any)}
                  options={[
                    { value: 'ts', label: '按时间' },
                    { value: 'len', label: '按大小' },
                    { value: 'ttl', label: '按 TTL' },
                    { value: 'key', label: '按 Key' },
                  ]}
                  size="small"
                />
                <Select
                  className={styles.antdSelect}
                  value={sortDir}
                  onChange={(v) => setSortDir(v as any)}
                  options={[
                    { value: 'desc', label: '降序' },
                    { value: 'asc', label: '升序' },
                  ]}
                  size="small"
                />
              </div>
            </div>
          </div>
        </div>

        <div className={`${styles.main} ${isCompact && mobilePane !== 'keys' ? styles.mobileHidden : ''}`}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelTitle}>键值</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className={styles.small}>keys={filteredItems.length} / raw={items.length}</div>
              {!isCompact ? (
                <>
                  <Button size="small" onClick={copySelectedKeys} disabled={!keyTableSelectedKeys.length}>复制选中</Button>
                  <Button size="small" onClick={() => setKeyTableSelectedKeys([])} disabled={!keyTableSelectedKeys.length}>清空选择</Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => void openDeleteSelectedKey()}
                    disabled={busy || !selectedKey}
                  >
                    删除当前
                  </Button>
                  <Popover
                    placement="bottomRight"
                    trigger="click"
                    overlayClassName={styles.columnsPopover}
                    content={(
                      <div className={styles.columnsPopoverBody}>
                        <div className={styles.columnsPopoverTitle}>列显示</div>
                        <Checkbox.Group
                          value={keyTableColumnOptions
                            .filter(x => !x.locked)
                            .map(x => x.key)
                            .filter(k => (keyTableColsVisible?.[k] !== false))}
                          onChange={(vals) => {
                            const set = new Set((vals || []).map(String));
                            const next: Record<string, boolean> = { ...(keyTableColsVisible || {}) };
                            for (const opt of keyTableColumnOptions) {
                              if (opt.locked) continue;
                              next[opt.key] = set.has(opt.key);
                            }
                            setKeyTableColsVisible(next);
                          }}
                          options={keyTableColumnOptions.filter(x => !x.locked).map(x => ({ label: x.label, value: x.key }))}
                        />
                      </div>
                    )}
                  >
                    <Button size="small" icon={<SettingOutlined />} />
                  </Popover>
                </>
              ) : null}
            </div>
          </div>

          {isCompact ? (
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
                    <Button size="small" onClick={resetFilters}>一键重置筛选</Button>
                  </div>
                </div>
              ) : null}

              {filteredItems.map((it) => (
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
              ))}
            </div>
          ) : (
            <div className={styles.antdTableWrap} ref={keyTableWrapRef}>
              <Table
                className={styles.antdTable}
                columns={keyTableColumns}
                dataSource={filteredItems}
                rowKey={(r) => r.key}
                scroll={{ y: keyTableScrollY }}
                pagination={{
                  current: keyTablePage,
                  pageSize: keyTablePageSize,
                  showSizeChanger: true,
                  pageSizeOptions: [20, 50, 100, 200, 500],
                  onChange: (page, pageSize) => {
                    setKeyTablePage(page);
                    setKeyTablePageSize(pageSize);
                  },
                  showTotal: (total) => `共 ${total} 条`,
                }}
                size="small"
                sticky
                loading={busy}
                rowClassName={(r) => (r.key === selectedKey ? styles.antdRowActive : '')}
                rowSelection={{
                  selectedRowKeys: keyTableSelectedKeys,
                  onChange: (keys) => setKeyTableSelectedKeys(keys.map(String)),
                }}
                onRow={(r) => ({
                  onClick: () => openPreview(r.key),
                })}
                onChange={(_pagination, _filters, sorter) => {
                  const s = Array.isArray(sorter) ? sorter[0] : sorter;
                  const order = (s as any)?.order as ('ascend' | 'descend' | undefined);
                  const columnKey = (s as any)?.columnKey as (string | number | undefined);
                  applyTableSort(columnKey, order);
                }}
              />
              {!busy && items.length > 0 && filteredItems.length === 0 ? (
                <div className={styles.emptyHint}>
                  当前筛选条件导致列表为空（raw={items.length}）。
                  <div className={styles.btnRow}>
                    <Button size="small" onClick={resetFilters}>一键重置筛选</Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className={`${styles.inspector} ${isCompact && mobilePane !== 'detail' ? styles.mobileHidden : ''}`}>
          {isCompact ? (
            <div className={styles.mobileBackRow}>
              <Button size="small" onClick={() => setMobilePane('keys')}>返回</Button>
              <div className={styles.mobileBackTitle}>{selectedKey ? (selectedKey.length > 28 ? `${selectedKey.slice(0, 28)}…` : selectedKey) : '未选择'}</div>
            </div>
          ) : null}
          <Tabs
            className={styles.antdTabs}
            activeKey={rightTab}
            onChange={(k) => setRightTab(k as any)}
            items={[
              { key: 'detail', label: '详情' },
              { key: 'overview', label: '概览' },
              { key: 'related', label: '关联' },
              { key: 'danger', label: '危险' },
            ]}
            size="small"
          />

          <div className={styles.inspectorBody}>
            {rightTab === 'detail' ? (
              <>
                <div className={styles.panelHeader} style={{ borderBottom: 'none', padding: 0 }}>
                  <div>
                    <div className={styles.panelTitle}>键值详情</div>
                    <div className={styles.small}>{selectedItem ? (selectedItem.category || '其他') : '未选择 key'}</div>
                  </div>
                  <Space size={8}>
                    <Button
                      size="small"
                      onClick={() => openValueEditor()}
                      disabled={
                        busy ||
                        !selectedKey ||
                        !selectedItem ||
                        String(selectedItem.redisType || '').toLowerCase() !== 'string'
                      }
                    >
                      编辑值
                    </Button>
                    <Button
                      size="small"
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
                    >
                      复制 Key
                    </Button>
                    <Button
                      size="small"
                      danger
                      onClick={() => void openDeleteSelectedKey()}
                      disabled={busy || !selectedKey}
                    >
                      删除 Key
                    </Button>
                    <Button size="small" onClick={() => { setSelectedKey(''); setInspect(null); }} disabled={busy || !selectedKey}>
                      清空选择
                    </Button>
                  </Space>
                </div>

                {!selectedItem ? (
                  <div className={styles.emptyHint}>
                    <Alert
                      type="info"
                      showIcon
                      title="未选择 Key"
                      description="在中间 Keys 列表中点击一行，即可在这里查看内容预览、对话对信息、以及分屏详情。"
                    />
                  </div>
                ) : (
                  <>
                    <Descriptions
                      className={styles.detailDescriptions}
                      size="small"
                      column={1}
                      bordered
                    >
                      <Descriptions.Item label="Key">
                        <Typography.Text
                          code
                          copyable={selectedItem.key ? { text: String(selectedItem.key) } : false}
                          style={{ wordBreak: 'break-all' }}
                        >
                          {selectedItem.key}
                        </Typography.Text>
                      </Descriptions.Item>
                      <Descriptions.Item label="分类">
                        {selectedItem.category ? <Tag>{selectedItem.category}</Tag> : '-'}
                      </Descriptions.Item>
                      <Descriptions.Item label="TTL">
                        {(() => {
                          const tone = ttlTone(selectedItem.ttl);
                          const color = tone === 'warn' ? 'gold' : tone === 'missing' ? 'red' : tone === 'permanent' ? 'blue' : tone === 'ok' ? 'green' : 'default';
                          return <Tag color={color}>{formatTtl(selectedItem.ttl)}</Tag>;
                        })()}
                      </Descriptions.Item>
                      <Descriptions.Item label="类型">
                        <Tag>{formatRedisType(selectedItem.redisType)}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="大小">
                        {selectedItem.len == null ? '-' : String(selectedItem.len)}
                      </Descriptions.Item>
                      <Descriptions.Item label="群">
                        {selectedItem.groupId ? (
                          <Typography.Text copyable={{ text: String(selectedItem.groupId) }}>{selectedItem.groupId}</Typography.Text>
                        ) : (
                          '-'
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="用户">
                        {selectedItem.userId ? (
                          <Typography.Text copyable={{ text: String(selectedItem.userId) }}>{selectedItem.userId}</Typography.Text>
                        ) : (
                          '-'
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="日期">
                        {selectedItem.date || '-'}
                      </Descriptions.Item>
                    </Descriptions>

                    <div className={styles.detailModeRow}>
                      <Segmented
                        size="small"
                        block
                        className={styles.detailModeSegmented}
                        value={detailFocus}
                        options={[
                          { label: '预览', value: 'preview' },
                          { label: `对话对${pairContext.ok ? ` (${pairContext.pairCount})` : ''}`, value: 'pairs', disabled: !pairContext.ok },
                        ]}
                        onChange={(v) => {
                          const next = String(v || 'preview');
                          if (next === 'pairs' && !pairContext.ok) return;
                          setDetailFocus(next as any);
                          if (next === 'pairs') setPairSectionCollapsed(false);
                        }}
                      />
                    </div>

                    {pairContext.ok ? (
                      (() => {
                        const conv = Array.isArray(pairContext.conversations) ? pairContext.conversations : [];
                        const effectiveGroupId = String(pairContext.groupId || '').trim();
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
                              <div className={styles.pairSection} style={{ maxHeight: detailFocus === 'pairs' ? 680 : 360 }}>
                              <div className={styles.pairHeader}>
                                <div className={styles.pairHeaderTop}>
                                  <div className={styles.pairHeaderLeft}>
                                    <div className={styles.small}>
                                      显示 {rows.length} / {matchedAllRows.length}（总 {totalPairs}）
                                      {selectedIds.length ? ` · 已选 ${selectedIds.length}` : ''}
                                    </div>
                                    {!effectiveGroupId ? (
                                      <div className={styles.small} style={{ marginTop: 6, color: 'var(--redis-danger-text)' }}>
                                        未能从 key / JSON 推导 groupId：批量移除功能将不可用。
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className={styles.pairHeaderRight}>
                                    <Select
                                      className={styles.antdSelect}
                                      value={pairSearchMode}
                                      onChange={(v) => setPairSearchMode(v as any)}
                                      options={[
                                        { value: 'auto', label: '自动' },
                                        { value: 'pairId', label: 'pairId' },
                                        { value: 'keyword', label: '关键词' },
                                      ]}
                                      size="small"
                                    />
                                    <Input
                                      className={styles.antdInput}
                                      value={pairSearchText}
                                      onChange={(e) => setPairSearchText(e.target.value)}
                                      placeholder="检索：pairId 或关键词（U/A 文本）"
                                      size="small"
                                    />
                                    <Select
                                      className={styles.antdSelect}
                                      value={String(pairListLimit)}
                                      onChange={(v) => setPairListLimit(Number(v) || 0)}
                                      options={[
                                        { value: '24', label: '24' },
                                        { value: '100', label: '100' },
                                        { value: '200', label: '200' },
                                        { value: '500', label: '500' },
                                        { value: '0', label: '全部' },
                                      ]}
                                      size="small"
                                    />
                                  </div>
                                </div>

                                <div className={styles.pairHeaderBottom}>
                                  <div className={styles.pairHeaderGroup}>
                                    <Button
                                      size="small"
                                      onClick={() => {
                                        const next: Record<string, boolean> = {};
                                        for (const r of matchedAllRows) next[r.pairId] = true;
                                        setPairSelectedMap(next);
                                      }}
                                    >
                                      全选筛选
                                    </Button>
                                    <Button size="small" onClick={() => setPairSelectedMap({})}>清空选择</Button>
                                  </div>

                                  <div className={styles.pairHeaderGroupRight}>
                                    <Button
                                      size="small"
                                      danger
                                      type="primary"
                                      onClick={() => {
                                        if (!effectiveGroupId) return;
                                        openPairBulkConfirm(effectiveGroupId, selectedIds);
                                      }}
                                      disabled={!effectiveGroupId || !selectedIds.length}
                                    >
                                      批量确认移除
                                    </Button>
                                    <div className={styles.pairHeaderDivider} />
                                    <Button size="small" onClick={() => setPairSectionCollapsed((v) => !v)}>
                                      {pairSectionCollapsed ? '展开' : '收起'}
                                    </Button>
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
                                    const isActive = pairSelectedId === r.pairId;
                                    const isChecked = !!pairSelectedMap[r.pairId];
                                    const sn = snippetByPair.get(r.pairId) || { user: '', assistant: '' };
                                    const userLine = sn.user;
                                    const assistantLine = sn.assistant;
                                    const full = fullByPair.get(r.pairId);
                                    return (
                                      <div
                                        key={r.pairId}
                                        className={`${styles.pairRow} ${isActive ? styles.pairRowActive : ''}`}
                                        onClick={() => {
                                          setPairSelectedId(r.pairId);
                                          setPairViewerData({
                                            groupId: effectiveGroupId,
                                            pairId: r.pairId,
                                            shortId,
                                            count: r.count,
                                            ts: r.ts,
                                            userText: String(full?.userText || ''),
                                            assistantText: String(full?.assistantText || ''),
                                            userTs: (full as any)?.userTs ?? null,
                                            assistantTs: (full as any)?.assistantTs ?? null,
                                          });
                                          setPairViewerOpen(true);
                                        }}
                                      >
                                        <div className={styles.pairRowTop}>
                                          <div style={{ minWidth: 0, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                            <label
                                              className={styles.pairCheck}
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <Tooltip title={isChecked ? '取消选择' : '选择'}>
                                              <Checkbox
                                                checked={isChecked}
                                                onChange={(e) => {
                                                  const checked = (e as any)?.target?.checked;
                                                  setPairSelectedMap((prev) => ({
                                                    ...prev,
                                                    [r.pairId]: !!checked,
                                                  }));
                                                }}
                                              />
                                              </Tooltip>
                                            </label>
                                            <div>
                                              <Tooltip title={r.pairId}>
                                                <div className={styles.pairId}>{shortId}</div>
                                              </Tooltip>
                                              <div className={styles.pairMeta}>messages={r.count}{r.ts ? ` · ${new Date(r.ts).toLocaleString()}` : ''}</div>
                                            </div>
                                          </div>
                                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                            <Button
                                              size="small"
                                              danger
                                              type="primary"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (!effectiveGroupId) return;
                                                openPairConfirm(effectiveGroupId, r.pairId);
                                              }}
                                              disabled={!effectiveGroupId}
                                            >
                                              确认移除
                                            </Button>
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
                    ) : (
                      <div className={styles.emptyHint}>
                        当前 key 不包含可管理的对话对数据（缺少 conversations/pairId）。
                      </div>
                    )}

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
                  <Button size="small" onClick={() => loadOverview()} disabled={busy}>刷新</Button>
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
                        <Button size="small" onClick={() => { setPattern(r.ptn); setRightTab('detail'); runListFor(r.ptn); }} disabled={busy}>列出</Button>
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
                    <div className={styles.small}>按群/用户快速定位关联 key（点击结果可跳转到详情）</div>
                  </div>
                </div>

                <Alert
                  type="info"
                  showIcon
                  title="使用说明"
                  description={
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        <li>输入 groupId / userId（至少一个）</li>
                        <li>点击“查询”获取关联 Keys 列表</li>
                        <li>点击任意一行可打开右侧 Key 详情；也可一键复制 Key</li>
                      </ul>
                    </div>
                  }
                  style={{ marginTop: 10 }}
                />

                <Space style={{ width: '100%', marginTop: 10 }} size={8}>
                  <Input
                    className={styles.antdInput}
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    placeholder="groupId（可选）"
                    size="small"
                  />
                  <Input
                    className={styles.antdInput}
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    placeholder="userId（可选）"
                    size="small"
                  />
                  <Button size="small" onClick={() => runRelated()} disabled={busy || (!groupId.trim() && !userId.trim())}>
                    查询
                  </Button>
                </Space>

                {relatedItems && relatedItems.length ? (
                  <div style={{ marginTop: 10 }}>
                    <div className={styles.small} style={{ marginBottom: 8 }}>
                      共 {relatedItems.length} 条
                    </div>
                    <List
                      className={styles.relatedAntdList}
                      size="small"
                      bordered
                      dataSource={relatedItems}
                      pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
                      renderItem={(it) => (
                        <List.Item
                          onClick={() => { setSelectedKey(it.key); setRightTab('detail'); setDetailFocus('preview'); setPairSelectedId(''); }}
                          style={{ cursor: 'pointer' }}
                          actions={[
                            <Tooltip key="copy" title="复制 Key">
                              <Button
                                size="small"
                                type="text"
                                icon={<CopyOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const k = String(it.key || '');
                                  if (!k) return;
                                  navigator.clipboard?.writeText(k)
                                    .then(() => addToast('success', '已复制 Key'))
                                    .catch((err) => addToast('error', '复制失败', String((err as any)?.message || err)));
                                }}
                              />
                            </Tooltip>,
                          ]}
                        >
                          <List.Item.Meta
                            title={
                              <Typography.Text style={{ fontWeight: 900 }}>
                                {it.key}
                              </Typography.Text>
                            }
                            description={
                              <span className={styles.small}>
                                {it.category || '其他'} · {formatRedisType(it.redisType)} · {formatTtl(it.ttl)}
                              </span>
                            }
                          />
                        </List.Item>
                      )}
                    />
                  </div>
                ) : (
                  <div className={styles.emptyHint}>
                    <Alert type="info" showIcon title="暂无结果" description="请输入 groupId / userId 后点击查询。" />
                  </div>
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
                  <Input className={styles.antdInput} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="例如: sentra:memory:*" size="small" />
                </div>
                <div className={styles.btnRow}>
                  <Button size="small" type="primary" onClick={() => runDeleteDry()} disabled={busy || !pattern.trim()}>预览删除</Button>
                  <Button
                    size="small"
                    danger
                    type="primary"
                    onClick={() => openDangerConfirm()}
                    disabled={
                      busy ||
                      !pattern.trim() ||
                      !deletePreview ||
                      deletePreview.pattern !== pattern.trim()
                    }
                  >
                    确认删除
                  </Button>
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
                <Button size="small" onClick={() => setConfirmOpen(false)}>关闭</Button>
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
                <Input className={styles.antdInput} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={pattern.trim()} size="small" />
                <Button
                  size="small"
                  danger
                  type="primary"
                  disabled={
                    busy ||
                    !pattern.trim() ||
                    !deletePreview ||
                    deletePreview.pattern !== pattern.trim() ||
                    confirmText.trim() !== pattern.trim()
                  }
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
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={pairViewerOpen && !!pairViewerData}
        onCancel={() => { setPairViewerOpen(false); setPairViewerData(null); }}
        footer={null}
        width="min(1200px, 98vw)"
        title={pairViewerData ? `对话对详情 · ${pairViewerData.shortId}` : '对话对详情'}
        destroyOnHidden
        styles={{ body: { paddingTop: 8, height: '78vh', overflow: 'auto' } }}
      >
        {pairViewerData ? (
          (() => {
            const userParsed = parseXmlToJson(pairViewerData.userText);
            const assistantParsed = parseXmlToJson(pairViewerData.assistantText);
            const userTree = userParsed.ok ? buildJsonTreeRows(userParsed.json, { maxNodes: 2200, maxDepth: 24 }) : [];
            const assistantTree = assistantParsed.ok ? buildJsonTreeRows(assistantParsed.json, { maxNodes: 2200, maxDepth: 24 }) : [];
            const userRefs = userParsed.ok ? extractRedisKeyRefs(userParsed.json, { maxRefs: 120 }) : [];
            const assistantRefs = assistantParsed.ok ? extractRedisKeyRefs(assistantParsed.json, { maxRefs: 120 }) : [];

            const makeCols = (role: 'user' | 'assistant', messageJson: any): ColumnsType<JsonTreeRow> => [
              {
                title: '节点',
                dataIndex: 'name',
                key: 'name',
                width: 240,
                ellipsis: true,
                render: (v: any) => <Typography.Text style={{ fontSize: 12, fontWeight: 800 }}>{String(v || '')}</Typography.Text>,
              },
              {
                title: '路径',
                dataIndex: 'path',
                key: 'path',
                width: 420,
                ellipsis: true,
                render: (v: any) => (
                  <Typography.Text code copyable={{ text: String(v || '') }} style={{ fontSize: 12 }}>
                    {String(v || '')}
                  </Typography.Text>
                ),
              },
              {
                title: '值',
                dataIndex: 'value',
                key: 'value',
                ellipsis: true,
                render: (_: any, r: JsonTreeRow) => {
                  const txt = formatPreviewValue(r?.raw);
                  const short = txt.length > 220 ? `${txt.slice(0, 220)}…` : txt;
                  const isLeaf = r?.type && String(r.type) !== 'object' && String(r.type) !== 'array' && String(r.type) !== 'limit';
                  const forbidAttr = typeof r?.path === 'string' && r.path.split('.').some((seg) => seg.startsWith('@_'));
                  return (
                    <Tooltip title={txt.length > 220 ? '点击查看完整内容' : null}>
                      <span style={{ display: 'inline-block', maxWidth: '100%' }}>
                        <Typography.Text
                          copyable={{ text: txt }}
                          style={{ fontSize: 12, wordBreak: 'break-word', cursor: 'pointer' }}
                          onClick={() => {
                            if (forbidAttr) {
                              addToast('error', '禁止编辑', '不允许修改 @_ 属性字段');
                              return;
                            }
                            if (isLeaf) {
                              openPairLeafEditor({
                                role,
                                path: String(r?.path || ''),
                                leafType: String(r?.type || ''),
                                leafRaw: r?.raw,
                                messageJson,
                              });
                              return;
                            }
                            setPairValuePreviewTitle(r?.path ? `值详情：${r.path}` : '值详情');
                            setPairValuePreviewText(txt);
                            setPairValuePreviewCtx({
                              role,
                              basePath: String(r?.path || ''),
                              messageJson,
                              raw: r?.raw,
                            });
                            setPairValuePreviewOpen(true);
                          }}
                        >
                          {short}
                        </Typography.Text>
                      </span>
                    </Tooltip>
                  );
                },
              },
              {
                title: '类型',
                dataIndex: 'type',
                key: 'type',
                width: 100,
                render: (v: any) => <Tag>{String(v || '')}</Tag>,
              },
            ];

            return (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', marginBottom: 10 }}>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={async () => {
                      try {
                        await navigator.clipboard?.writeText(pairViewerData.pairId);
                        addToast('success', '已复制 pairId');
                      } catch (e: any) {
                        addToast('error', '复制失败', String(e?.message || e));
                      }
                    }}
                  >
                    复制 pairId
                  </Button>
                  <Button
                    size="small"
                    danger
                    type="primary"
                    onClick={() => {
                      if (!pairViewerData.groupId) return;
                      openPairConfirm(pairViewerData.groupId, pairViewerData.pairId);
                    }}
                    disabled={!pairViewerData.groupId}
                  >
                    移除该对话对
                  </Button>
                </div>

                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="groupId">{pairViewerData.groupId || '-'}</Descriptions.Item>
                  <Descriptions.Item label="messages">{pairViewerData.count}</Descriptions.Item>
                  <Descriptions.Item label="pairId" span={2}>
                    <Typography.Text copyable={{ text: pairViewerData.pairId }} code style={{ wordBreak: 'break-all' }}>
                      {pairViewerData.pairId}
                    </Typography.Text>
                  </Descriptions.Item>
                </Descriptions>

                <Divider style={{ margin: '12px 0' }} />

                <Tabs
                  size="small"
                  items={[
                    {
                      key: 'user-json',
                      label: `User 结构化${userParsed.ok ? '' : ''}`,
                      children: userParsed.ok ? (
                        <>
                          {userRefs.length ? (
                            <div style={{ marginBottom: 10 }}>
                              <div className={styles.small} style={{ marginBottom: 6, fontWeight: 900 }}>关联键值（从结构中提取）</div>
                              <List
                                size="small"
                                bordered
                                dataSource={userRefs}
                                pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50] }}
                                renderItem={(it) => (
                                  <List.Item
                                    actions={[
                                      <Tooltip key="open" title="打开该 key">
                                        <Button
                                          size="small"
                                          type="text"
                                          icon={<EyeOutlined />}
                                          onClick={() => {
                                            const k = String(it?.key || '').trim();
                                            if (!k) return;
                                            setPairViewerOpen(false);
                                            setPairViewerData(null);
                                            setPairValuePreviewOpen(false);
                                            setPairValuePreviewTitle('');
                                            setPairValuePreviewText('');
                                            openPreview(k);
                                          }}
                                        />
                                      </Tooltip>,
                                    ]}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <div className={styles.small} style={{ marginBottom: 2 }}>
                                        <Typography.Text code copyable={{ text: it.path }} style={{ fontSize: 12 }}>{it.path || '-'}</Typography.Text>
                                      </div>
                                      <Typography.Text copyable={{ text: it.key }} style={{ fontWeight: 900 }}>{it.key}</Typography.Text>
                                    </div>
                                  </List.Item>
                                )}
                              />
                            </div>
                          ) : null}
                          <Table<JsonTreeRow>
                            size="small"
                            columns={makeCols('user', userParsed.json)}
                            dataSource={userTree}
                            pagination={false}
                            scroll={{ y: 520, x: 980 }}
                            expandable={{ defaultExpandAllRows: false, indentSize: 18 }}
                          />
                        </>
                      ) : (
                        <Alert type="warning" showIcon title="User XML 解析失败" description={userParsed.error} />
                      ),
                    },
                    {
                      key: 'assistant-json',
                      label: `Assistant 结构化${assistantParsed.ok ? '' : ''}`,
                      children: assistantParsed.ok ? (
                        <>
                          {assistantRefs.length ? (
                            <div style={{ marginBottom: 10 }}>
                              <div className={styles.small} style={{ marginBottom: 6, fontWeight: 900 }}>关联键值（从结构中提取）</div>
                              <List
                                size="small"
                                bordered
                                dataSource={assistantRefs}
                                pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50] }}
                                renderItem={(it) => (
                                  <List.Item
                                    actions={[
                                      <Tooltip key="open" title="打开该 key">
                                        <Button
                                          size="small"
                                          type="text"
                                          icon={<EyeOutlined />}
                                          onClick={() => {
                                            const k = String(it?.key || '').trim();
                                            if (!k) return;
                                            setPairViewerOpen(false);
                                            setPairViewerData(null);
                                            setPairValuePreviewOpen(false);
                                            setPairValuePreviewTitle('');
                                            setPairValuePreviewText('');
                                            openPreview(k);
                                          }}
                                        />
                                      </Tooltip>,
                                    ]}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <div className={styles.small} style={{ marginBottom: 2 }}>
                                        <Typography.Text code copyable={{ text: it.path }} style={{ fontSize: 12 }}>{it.path || '-'}</Typography.Text>
                                      </div>
                                      <Typography.Text copyable={{ text: it.key }} style={{ fontWeight: 900 }}>{it.key}</Typography.Text>
                                    </div>
                                  </List.Item>
                                )}
                              />
                            </div>
                          ) : null}
                          <Table<JsonTreeRow>
                            size="small"
                            columns={makeCols('assistant', assistantParsed.json)}
                            dataSource={assistantTree}
                            pagination={false}
                            scroll={{ y: 520, x: 980 }}
                            expandable={{ defaultExpandAllRows: false, indentSize: 18 }}
                          />
                        </>
                      ) : (
                        <Alert type="warning" showIcon title="Assistant XML 解析失败" description={assistantParsed.error} />
                      ),
                    },
                  ]}
                />
              </>
            );
          })()
        ) : null}
      </Modal>

      <Modal
        open={pairValuePreviewOpen}
        onCancel={() => { setPairValuePreviewOpen(false); setPairValuePreviewTitle(''); setPairValuePreviewText(''); setPairValuePreviewCtx(null); }}
        footer={null}
        width="min(1100px, 96vw)"
        title={pairValuePreviewTitle || '值详情'}
        destroyOnHidden
        styles={{ body: { height: '70vh', overflow: 'hidden' } }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={async () => {
                try {
                  await navigator.clipboard?.writeText(pairValuePreviewText);
                  addToast('success', '已复制');
                } catch (e: any) {
                  addToast('error', '复制失败', String(e?.message || e));
                }
              }}
            >
              复制
            </Button>
          </div>

          {pairValuePreviewCtx && pairValuePreviewCtx.raw && typeof pairValuePreviewCtx.raw === 'object' ? (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10 }}
                message="值详情：可继续点击叶子值进行编辑（仅允许修改叶子；禁止修改 @_ 属性字段；保存会回写对话对）"
              />
              <Table<any>
                size="small"
                columns={makePairValuePreviewCols(pairValuePreviewCtx)}
                dataSource={prefixJsonTreeRows(buildJsonTreeRows(pairValuePreviewCtx.raw, { maxNodes: 1200, maxDepth: 24 }), pairValuePreviewCtx.basePath)}
                pagination={false}
                scroll={{ y: 360, x: 980 }}
                expandable={{ defaultExpandAllRows: false, indentSize: 18 }}
              />
              <Divider style={{ margin: '12px 0' }} />
            </>
          ) : null}

          {isCompact || performanceMode ? (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.6, overflow: 'auto', flex: 1 }}>
              {pairValuePreviewText || '-'}
            </pre>
          ) : (
            <div style={{ flex: 1, minHeight: 0 }}>
              <Suspense fallback={<pre className={styles.previewPre}>{pairValuePreviewText || '-'}</pre>}>
                <MonacoEditor
                  height="100%"
                  language={(() => {
                    const raw = String(pairValuePreviewText || '').trim();
                    if (!raw) return 'plaintext';
                    if (raw.startsWith('{') || raw.startsWith('[')) {
                      try {
                        JSON.parse(raw);
                        return 'json';
                      } catch {
                        return 'plaintext';
                      }
                    }
                    if (raw.startsWith('<')) return 'xml';
                    return 'plaintext';
                  })()}
                  value={pairValuePreviewText || ''}
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
              </Suspense>
            </div>
          )}
        </div>
      </Modal>

      {pairConfirmOpen && pairConfirmTarget ? (
        <div className={styles.modalOverlay} onClick={() => { setPairConfirmOpen(false); setPairConfirmText(''); setPairConfirmAcknowledge(false); setPairConfirmTarget(null); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 96vw)' }}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalTitle}>确认移除对话对</div>
                <div className={styles.small}>此操作会修改群会话状态 JSON，仅移除指定 pairId 的历史消息。</div>
              </div>
              <div className={styles.modalActions}>
                <Button size="small" onClick={() => { setPairConfirmOpen(false); setPairConfirmText(''); setPairConfirmAcknowledge(false); setPairConfirmTarget(null); }}>关闭</Button>
              </div>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.warning} style={{ margin: 0 }}>
                groupId={pairConfirmTarget.groupId}，pairId={pairConfirmTarget.shortId}
              </div>
              <div className={styles.small} style={{ marginTop: 10 }}>
                请输入 pairId 前 8 位以确认：
              </div>
              <div className={styles.small} style={{ marginTop: 10 }}>
                <Checkbox checked={pairConfirmAcknowledge} onChange={(e) => setPairConfirmAcknowledge(!!(e as any)?.target?.checked)}>
                  我已确认要移除该对话对（不可恢复）
                </Checkbox>
              </div>
              <div className={styles.inputRow} style={{ padding: '10px 0', borderBottom: 'none' }}>
                <Input className={styles.antdInput} value={pairConfirmText} onChange={(e) => setPairConfirmText(e.target.value)} placeholder={pairConfirmTarget.shortId} size="small" />
                <Button
                  size="small"
                  danger
                  type="primary"
                  disabled={busy || !pairConfirmAcknowledge || pairConfirmText.trim() !== pairConfirmTarget.shortId}
                  onClick={async () => {
                    try {
                      await runPairDeleteConfirm();
                    } catch (e: any) {
                      addToast('error', '移除失败', String(e?.message || e));
                    }
                  }}
                >
                  移除
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {pairBulkConfirmOpen && pairBulkConfirmTarget ? (
        <div className={styles.modalOverlay} onClick={() => { setPairBulkConfirmOpen(false); setPairBulkConfirmText(''); setPairBulkConfirmAcknowledge(false); setPairBulkConfirmTarget(null); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 96vw)' }}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalTitle}>确认批量移除对话对</div>
                <div className={styles.small}>此操作会修改群会话状态 JSON，仅移除选中的 pairId 历史消息。</div>
              </div>
              <div className={styles.modalActions}>
                <Button size="small" onClick={() => { setPairBulkConfirmOpen(false); setPairBulkConfirmText(''); setPairBulkConfirmAcknowledge(false); setPairBulkConfirmTarget(null); }}>关闭</Button>
              </div>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.warning} style={{ margin: 0 }}>
                groupId={pairBulkConfirmTarget.groupId}，pairs={pairBulkConfirmTarget.count}
              </div>
              <div className={styles.small} style={{ marginTop: 10 }}>
                请输入移除数量以确认：
              </div>
              <div className={styles.small} style={{ marginTop: 10 }}>
                <Checkbox checked={pairBulkConfirmAcknowledge} onChange={(e) => setPairBulkConfirmAcknowledge(!!(e as any)?.target?.checked)}>
                  我已确认要批量移除这些对话对（不可恢复）
                </Checkbox>
              </div>
              <div className={styles.inputRow} style={{ padding: '10px 0', borderBottom: 'none' }}>
                <Input
                  className={styles.antdInput}
                  value={pairBulkConfirmText}
                  onChange={(e) => setPairBulkConfirmText(e.target.value)}
                  placeholder={String(pairBulkConfirmTarget.count)}
                  size="small"
                />
                <Button
                  size="small"
                  danger
                  type="primary"
                  disabled={busy || !pairBulkConfirmAcknowledge || pairBulkConfirmText.trim() !== String(pairBulkConfirmTarget.count)}
                  onClick={async () => {
                    try {
                      await runPairBulkDeleteConfirm();
                    } catch (e: any) {
                      addToast('error', '批量移除失败', String(e?.message || e));
                    }
                  }}
                >
                  批量移除
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={valueEditorOpen}
        onCancel={() => { setValueEditorOpen(false); setValueEditorText(''); setValueEditorBaseline(null); }}
        footer={null}
        width="min(1200px, 98vw)"
        title={selectedKey ? `编辑值 · ${selectedKey}` : '编辑值'}
        destroyOnHidden
        styles={{ body: { height: '78vh', overflow: 'hidden' } }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          {valueEditorBaseline?.isJson ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 10 }}
              message={`JSON 保护模式：禁止修改结构/键名/数组长度/类型，禁止修改 @_ 字段；仅允许修改叶子值（如 string 内容）。key=${valueEditorBaseline.keyCount}`}
              description={valueEditorBaseline.keySamples.length ? `示例路径：${valueEditorBaseline.keySamples.join(', ')}` : undefined}
            />
          ) : (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 10 }}
              message="自由编辑模式：原值不是 JSON（或无法解析为 JSON），可直接编辑全文。"
            />
          )}

          <div style={{ flex: 1, minHeight: 0, border: '1px solid rgba(0,0,0,0.08)' }}>
            <Suspense fallback={<pre className={styles.previewPre}>{valueEditorText || '-'}</pre>}>
              <MonacoEditor
                height="100%"
                language={valueEditorBaseline?.isJson ? 'json' : 'plaintext'}
                value={valueEditorText}
                theme={uiTheme === 'dark' ? 'hc-black' : 'light'}
                onChange={(v) => setValueEditorText(String(v ?? ''))}
                options={{
                  readOnly: false,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  folding: true,
                  renderLineHighlight: 'none',
                  scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                  automaticLayout: true,
                }}
              />
            </Suspense>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <Button
              size="small"
              onClick={() => { setValueEditorOpen(false); setValueEditorText(''); setValueEditorBaseline(null); }}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={() => void saveValueEditor()}
              disabled={busy || !selectedKey}
            >
              保存并写回 Redis
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
