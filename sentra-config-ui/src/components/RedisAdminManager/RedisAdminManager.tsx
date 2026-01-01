import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './RedisAdminManager.module.css';
import {
  fetchRedisAdminHealth,
  fetchRedisAdminOverview,
  fetchRedisAdminGroups,
  fetchRedisAdminList,
  fetchRedisAdminInspect,
  fetchRedisAdminRelated,
  deleteRedisAdminByPattern,
} from '../../services/redisAdminApi';

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

export function RedisAdminManager(props: { addToast: ToastFn }) {
  const { addToast } = props;
  const [sentraRoot, setSentraRoot] = useState<string>('');

  const [errorText, setErrorText] = useState<string>('');

  const [groups, setGroups] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  const [pattern, setPattern] = useState('sentra:');
  const [items, setItems] = useState<RedisKeyItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [inspect, setInspect] = useState<any>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [categoryFilter, setCategoryFilter] = useState<string>('全部');
  const [keyword, setKeyword] = useState<string>('');

  const [groupId, setGroupId] = useState('');
  const [userId, setUserId] = useState('');
  const [related, setRelated] = useState<any>(null);
  const [relatedItems, setRelatedItems] = useState<RedisKeyItem[]>([]);

  const [busy, setBusy] = useState(false);

  const loadHealth = useCallback(async () => {
    const h = await fetchRedisAdminHealth();
    setSentraRoot(String(h.sentraRoot || ''));
  }, []);

  const loadOverview = useCallback(async () => {
    const payload = await fetchRedisAdminOverview({ count: 500 });
    setCounts(payload?.counts || {});
  }, []);

  const loadGroups = useCallback(async () => {
    const payload = await fetchRedisAdminGroups();
    setGroups(payload?.groups || {});
  }, []);

  const groupNameCn = useMemo(() => {
    return {
      conversation_private: '会话（私聊）',
      conversation_group: '会话（群聊）',
      group_history: '群历史',
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
    const payload = await fetchRedisAdminList({ pattern: p, count: 800, withMeta: true });
    const list = Array.isArray(payload?.items) ? payload.items : [];
    setItems(list);
    setSelectedKey('');
    setInspect(null);
    setPreviewOpen(false);
  }, [pattern]);

  const runListFor = useCallback(async (p: string) => {
    const ptn = String(p || '').trim();
    if (!ptn) return;
    setBusy(true);
    setErrorText('');
    setPattern(ptn);
    try {
      const payload = await fetchRedisAdminList({ pattern: ptn, count: 800, withMeta: true });
      const list = Array.isArray(payload?.items) ? payload.items : [];
      setItems(list);
      setSelectedKey('');
      setInspect(null);
      setPreviewOpen(false);
      addToast('success', '已列出', `keys=${list.length}`);
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', '列出失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast]);

  const runInspect = useCallback(async (k: string) => {
    const key = String(k || '').trim();
    if (!key) return;
    const payload = await fetchRedisAdminInspect({ key, preview: 1200, head: 5, tail: 5, sample: 12, top: 20 });
    setInspect(payload);
  }, []);

  const runRelated = useCallback(async () => {
    const gid = groupId.trim();
    const uid = userId.trim();
    const payload = await fetchRedisAdminRelated({
      groupId: gid || undefined,
      userId: uid || undefined,
      count: 800,
      withMeta: true,
    });
    setRelated(payload);
    const list = Array.isArray(payload?.items) ? payload.items : [];
    setRelatedItems(list);
  }, [groupId, userId]);

  const runDeleteDry = useCallback(async () => {
    const p = pattern.trim();
    if (!p) return;
    const payload = await deleteRedisAdminByPattern({ pattern: p, dryRun: true, count: 1200 });
    addToast('info', 'Dry-run 删除预览', `requested=${payload.requested}, deleted=${payload.deleted}`);
  }, [addToast, pattern]);

  const runDeleteDryFor = useCallback(async (p: string) => {
    const ptn = String(p || '').trim();
    if (!ptn) return;
    setBusy(true);
    setErrorText('');
    setPattern(ptn);
    try {
      const payload = await deleteRedisAdminByPattern({ pattern: ptn, dryRun: true, count: 1200 });
      addToast('info', 'Dry-run 删除预览', `requested=${payload.requested}, deleted=${payload.deleted}`);
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', 'Dry-run 失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast]);

  const runDeleteConfirm = useCallback(async () => {
    const p = pattern.trim();
    if (!p) return;
    const payload = await deleteRedisAdminByPattern({
      pattern: p,
      dryRun: false,
      count: 1500,
    });
    addToast('success', '删除完成', `requested=${payload.requested}, deleted=${payload.deleted}`);
    await loadOverview();
    await runList();
  }, [addToast, loadOverview, pattern, runList]);

  const runDeleteFor = useCallback(async (p: string) => {
    const ptn = String(p || '').trim();
    if (!ptn) return;
    setBusy(true);
    setErrorText('');
    setPattern(ptn);
    try {
      const payload = await deleteRedisAdminByPattern({ pattern: ptn, dryRun: false, count: 1500 });
      addToast('success', '删除完成', `requested=${payload.requested}, deleted=${payload.deleted}`);
      await loadOverview();
      await runListFor(ptn);
    } catch (e: any) {
      setErrorText(String(e?.message || e));
      addToast('error', '删除失败', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [addToast, loadOverview, runListFor]);

  const init = useCallback(async () => {
    setBusy(true);
    setErrorText('');
    try {
      await loadHealth();
      await loadGroups();
      await loadOverview();
    } finally {
      setBusy(false);
    }
  }, [loadGroups, loadHealth, loadOverview]);

  useEffect(() => {
    init().catch((e) => {
      setErrorText(String(e));
      addToast('error', '初始化失败', String(e));
    });
  }, [init, addToast]);

  useEffect(() => {
    if (selectedKey) {
      runInspect(selectedKey).catch((e) => addToast('error', 'Inspect 失败', String(e)));
    }
  }, [selectedKey, runInspect, addToast]);

  const openPreview = useCallback((k: string) => {
    const key = String(k || '').trim();
    if (!key) return;
    setSelectedKey(key);
    setPreviewOpen(true);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setSelectedKey('');
    setInspect(null);
  }, []);

  const quickPatterns = useMemo(() => {
    return [
      { label: '会话(私聊)', value: 'sentra:conv:private:*' },
      { label: '会话(群聊)', value: 'sentra:conv:group:*' },
      { label: '群历史', value: 'sentra:group:*' },
      { label: '意愿/主动', value: 'sentra:desire:*' },
      { label: '记忆(摘要)', value: 'sentra:memory:*' },
      { label: 'MCP ctx', value: 'sentra:mcp:ctx*' },
      { label: 'MCP mem', value: 'sentra:mcp:mem*' },
      { label: '全部 sentra:*', value: 'sentra:*' },
    ];
  }, []);

  const quickCards = useMemo(() => {
    return [
      {
        title: '清理会话（私聊）',
        desc: '私聊上下文/对话缓存相关 key。',
        pattern: 'sentra:conv:private:*',
      },
      {
        title: '清理会话（群聊）',
        desc: '群聊上下文/对话缓存相关 key。',
        pattern: 'sentra:conv:group:*',
      },
      {
        title: '清理群历史',
        desc: '群聊历史管理相关 key。',
        pattern: 'sentra:group:*',
      },
      {
        title: '清理记忆（摘要）',
        desc: 'memory 相关 key（通常体积较大）。',
        pattern: 'sentra:memory:*',
      },
      {
        title: '清理 MCP ctx',
        desc: 'MCP 上下文缓存 key。',
        pattern: 'sentra:mcp:ctx*',
      },
      {
        title: '清理 MCP mem',
        desc: 'MCP 记忆/索引相关 key。',
        pattern: 'sentra:mcp:mem*',
      },
      {
        title: '清理意愿/主动',
        desc: 'desire/主动行为状态相关 key。',
        pattern: 'sentra:desire:*',
      },
      {
        title: '清理全部 sentra:*',
        desc: '只建议在你确认需要“全清”时使用。',
        pattern: 'sentra:*',
      },
    ];
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
    return items.filter((it) => {
      const cat = it.category || '其他';
      if (categoryFilter !== '全部' && cat !== categoryFilter) return false;
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
  }, [items, categoryFilter, keyword]);

  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    return filteredItems.find((x) => x.key === selectedKey) || items.find((x) => x.key === selectedKey) || null;
  }, [filteredItems, items, selectedKey]);

  const inspectPreview = useMemo(() => {
    if (!inspect || typeof inspect !== 'object') return null;

    const t = String((inspect as any).type || '').toLowerCase();
    if (!t) return null;

    if (t === 'string') {
      const v = (inspect as any).valuePreview;
      const isJson = !!(inspect as any).isJson;
      const json = (inspect as any).json;
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>文本预览</div>
          <pre className={styles.pre} style={{ marginTop: 8 }}>{String(v ?? '')}</pre>
          {isJson ? (
            <details>
              <summary className={styles.small}>查看 JSON（调试用）</summary>
              <pre className={styles.pre}>{JSON.stringify(json, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      );
    }

    if (t === 'list') {
      const len = (inspect as any).len;
      const head = Array.isArray((inspect as any).head) ? (inspect as any).head : [];
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>列表预览（共 {len ?? '-'} 条）</div>
          <pre className={styles.pre} style={{ marginTop: 8 }}>{JSON.stringify(head, null, 2)}</pre>
        </div>
      );
    }

    if (t === 'hash') {
      const len = (inspect as any).len;
      const fields = (inspect as any).fields;
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>字典预览（共 {len ?? '-'} 个字段）</div>
          <pre className={styles.pre} style={{ marginTop: 8 }}>{JSON.stringify(fields, null, 2)}</pre>
        </div>
      );
    }

    if (t === 'zset') {
      const len = (inspect as any).len;
      const top = (inspect as any).top;
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>排序集预览（共 {len ?? '-'} 条）</div>
          <pre className={styles.pre} style={{ marginTop: 8 }}>{JSON.stringify(top, null, 2)}</pre>
        </div>
      );
    }

    if (t === 'set') {
      const len = (inspect as any).len;
      const sample = (inspect as any).sample;
      return (
        <div className={styles.previewBox}>
          <div className={styles.previewTitle}>集合预览（共 {len ?? '-'} 条）</div>
          <pre className={styles.pre} style={{ marginTop: 8 }}>{JSON.stringify(sample, null, 2)}</pre>
        </div>
      );
    }

    return null;
  }, [inspect]);

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
            <div className={styles.pill}><span className={styles.pillLabel}>Pattern</span>{pattern.trim() || '-'}</div>
            <div className={styles.pill}><span className={styles.pillLabel}>列表</span>{String(filteredItems.length)}</div>
          </div>
        </div>

        <div className={styles.headerActions}>
          <button className={styles.btn} onClick={() => init()} disabled={busy}>刷新</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => runDeleteDry()} disabled={busy || !pattern.trim()}>先预览(Dry-run)</button>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => runDeleteConfirm()} disabled={busy || !pattern.trim()}>直接删除</button>
        </div>
      </div>

      {errorText ? (
        <div className={styles.warning}>
          {errorText}
        </div>
      ) : null}

      <div className={styles.quickGrid}>
        {quickCards.map((c) => (
          <div key={c.title} className={styles.card}>
            <div className={styles.cardTitle}>{c.title}</div>
            <div className={styles.cardDesc}>{c.desc}</div>
            <details>
              <summary className={styles.small}>查看匹配规则</summary>
              <div className={styles.cardPattern}>{c.pattern}</div>
            </details>
            <div className={styles.cardActions}>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => runListFor(c.pattern)} disabled={busy}>查看</button>
              <button className={styles.btn} onClick={() => runDeleteDryFor(c.pattern)} disabled={busy}>Dry-run</button>
              <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => runDeleteFor(c.pattern)} disabled={busy}>清理</button>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.body}>
        <div className={styles.left}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelTitle}>数据列表</div>
              <div className={styles.small}>点一行查看详情（原始 key / JSON 默认隐藏）</div>
            </div>
            <div className={styles.small}>keys={filteredItems.length}</div>
          </div>

          <div className={styles.inputRow}>
            <input
              className={styles.input}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="例如: sentra:memory:* 或 sentra:mcp:ctx*"
            />
            <button className={styles.btn} onClick={() => runList()} disabled={busy || !pattern.trim()}>列出</button>
          </div>

          <div className={styles.inputRow}>
            <select className={styles.input} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              {allCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              className={styles.input}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索：群号 / 用户 / 日期 / 类型"
            />
            <button className={styles.btn} onClick={() => { setCategoryFilter('全部'); setKeyword(''); }} disabled={busy}>清空</button>
          </div>

          <div className={styles.tagRow}>
            {quickPatterns.map((x) => (
              <div
                key={x.value}
                className={`${styles.tag} ${pattern.trim() === x.value ? styles.tagActive : ''}`}
                onClick={() => setPattern(x.value)}
              >
                {x.label}
              </div>
            ))}
          </div>

          <div className={styles.list}>
            <div className={styles.tableHeader}>
              <div>分类</div>
              <div>类型</div>
              <div>群号</div>
              <div>用户</div>
              <div>日期</div>
              <div>TTL</div>
              <div>数据类型</div>
              <div>大小</div>
            </div>
            {busy && !filteredItems.length ? (
              <div className={styles.skeletonList}>
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className={styles.skeletonRow} />
                ))}
              </div>
            ) : null}
            {filteredItems.map((it) => (
              <div
                key={it.key}
                className={`${styles.tableRow} ${selectedKey === it.key ? styles.rowActive : ''}`}
                onClick={() => openPreview(it.key)}
              >
                <div>{it.category || '其他'}</div>
                <div>{it.chatType || '-'}</div>
                <div>{it.groupId || '-'}</div>
                <div>{it.userId || '-'}</div>
                <div>{it.date || '-'}</div>
                <div>{formatTtl(it.ttl)}</div>
                <div>{formatRedisType(it.redisType)}</div>
                <div>{it.len == null ? '-' : String(it.len)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.right}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelTitle}>Overview</div>
              <div className={styles.small}>按 key group 统计数量</div>
            </div>
            <button className={styles.btn} onClick={() => loadOverview()} disabled={busy}>刷新</button>
          </div>
          <div className={styles.detail}>
            <div className={styles.overviewGrid}>
              {Object.entries(groups).map(([name, ptn]) => (
                <div key={name} className={styles.overviewCard}>
                  <div className={styles.overviewTitle}>{groupNameCn[name] || name}</div>
                  <div className={styles.overviewCount}>{counts[name] == null ? '-' : String(counts[name])}</div>
                  <details>
                    <summary className={styles.small}>查看规则</summary>
                    <div className={styles.keyText}>{ptn}</div>
                  </details>
                </div>
              ))}
            </div>

            <div style={{ height: 10 }} />

            <div className={styles.panelHeader} style={{ border: 'none', padding: 0, marginTop: 8 }}>
              <div>
                <div className={styles.panelTitle}>Related（按群/用户）</div>
                <div className={styles.small}>快速定位关联 key（含 context_memory/attention_stats 等）</div>
              </div>
            </div>
            <div className={styles.inputRow}>
              <input className={styles.input} value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="groupId (可选)" />
              <input className={styles.input} value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="userId (可选)" />
              <button className={styles.btn} onClick={() => runRelated()} disabled={busy || (!groupId.trim() && !userId.trim())}>查询</button>
            </div>
            {relatedItems && relatedItems.length ? (
              <div className={styles.relatedBox}>
                <div className={styles.tableHeader}>
                  <div>分类</div>
                  <div>类型</div>
                  <div>群号</div>
                  <div>用户</div>
                  <div>日期</div>
                  <div>TTL</div>
                  <div>数据类型</div>
                  <div>大小</div>
                </div>
                {relatedItems.map((it) => (
                  <div key={it.key} className={styles.tableRow} onClick={() => openPreview(it.key)}>
                    <div>{it.category || '其他'}</div>
                    <div>{it.chatType || '-'}</div>
                    <div>{it.groupId || '-'}</div>
                    <div>{it.userId || '-'}</div>
                    <div>{it.date || '-'}</div>
                    <div>{formatTtl(it.ttl)}</div>
                    <div>{formatRedisType(it.redisType)}</div>
                    <div>{it.len == null ? '-' : String(it.len)}</div>
                  </div>
                ))}
                {related ? (
                  <details>
                    <summary className={styles.small}>查看原始数据（调试用）</summary>
                    <pre className={styles.pre}>{JSON.stringify(related, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className={styles.small} style={{ marginTop: 10 }}>
              点击列表的一行即可打开“外显预览”。
            </div>
          </div>
        </div>
      </div>

      {previewOpen && selectedItem ? (
        <div className={styles.modalOverlay} onClick={closePreview}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalTitle}>内容预览</div>
                <div className={styles.small}>
                  {selectedItem.category || '其他'} / {selectedItem.chatType || '-'}
                  {selectedItem.groupId ? ` / 群 ${selectedItem.groupId}` : ''}
                  {selectedItem.userId ? ` / 用户 ${selectedItem.userId}` : ''}
                </div>
              </div>
              <div className={styles.modalActions}>
                <button className={styles.btn} onClick={closePreview}>关闭</button>
              </div>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.modalStats}>
                <div className={styles.modalStat}><div className={styles.small}>日期</div><div className={styles.modalStatValue}>{selectedItem.date || '-'}</div></div>
                <div className={styles.modalStat}><div className={styles.small}>TTL</div><div className={styles.modalStatValue}>{formatTtl(selectedItem.ttl)}</div></div>
                <div className={styles.modalStat}><div className={styles.small}>数据类型</div><div className={styles.modalStatValue}>{formatRedisType(selectedItem.redisType)}</div></div>
                <div className={styles.modalStat}><div className={styles.small}>大小</div><div className={styles.modalStatValue}>{selectedItem.len == null ? '-' : String(selectedItem.len)}</div></div>
              </div>

              {inspectPreview ? inspectPreview : <div className={styles.skeletonRow} style={{ height: 160 }} />}

              <details>
                <summary className={styles.small}>查看原始 Key / JSON（调试用）</summary>
                <div className={styles.keyText} style={{ marginTop: 8 }}>{selectedItem.key}</div>
                <pre className={styles.pre} style={{ marginTop: 10 }}>{JSON.stringify(inspect, null, 2)}</pre>
              </details>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
