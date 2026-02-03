import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Tooltip, Typography, Upload } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  LaptopOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  UploadOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import { ensureMcpServersFile, fetchMcpServers, getMcpServersStatus, saveMcpServers, testMcpServer, type McpServerDef, type McpServerType } from '../../services/mcpServersApi';
import styles from './McpServersManager.module.css';

type Props = {
  addToast?: (type: 'success' | 'error' | 'info' | 'warning', title: string, message?: string) => void;
};

type EditorForm = {
  id: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headersPairs?: { key: string; value: string }[];
};

function safeString(v: any) {
  return v == null ? '' : String(v);
}

function normalizeArgsInput(args: any): string[] {
  if (Array.isArray(args)) {
    return args.map((x) => safeString(x).trim()).filter(Boolean);
  }
  if (typeof args === 'string') {
    const raw = args.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => safeString(x).trim()).filter(Boolean);
      if (typeof parsed === 'string') return [parsed.trim()].filter(Boolean);
    } catch {
      // ignore
    }
    return [raw];
  }
  return [];
}

function toHeadersPairsForEdit(headers: any): { key: string; value: string }[] {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return [];
  return Object.entries(headers).map(([k, v]) => ({ key: safeString(k).trim(), value: safeString(v).trim() }));
}

function parseHeadersPairs(pairs: any): Record<string, string> {
  const arr = Array.isArray(pairs) ? pairs : [];
  const out: Record<string, string> = {};
  for (const it of arr) {
    const k = safeString(it?.key).trim();
    const v = safeString(it?.value).trim();
    if (!k) continue;
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      throw new Error(`headers 存在重复 key: ${k}`);
    }
    out[k] = v;
  }
  return out;
}

function isPlainObject(v: any) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function slugifyId(input: any) {
  const s = safeString(input).trim().toLowerCase();
  const cleaned = s
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
  return cleaned;
}

function guessType(def: any): McpServerType {
  const t = safeString(def?.type).trim() as McpServerType;
  if (t === 'streamable_http') return 'http';
  if (t === 'stdio' || t === 'websocket' || t === 'http') return t;
  const cmd = safeString(def?.command).trim();
  const url = safeString(def?.url).trim();
  if (cmd) return 'stdio';
  if (url && /^wss?:/i.test(url)) return 'websocket';
  if (url) return 'http';
  return 'stdio';
}

function flattenImportPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload.flatMap((x) => flattenImportPayload(x));
  return [payload];
}

function extractDefsFromLegacyMcpServers(obj: any) {
  const mcpServers = obj?.mcpServers;
  if (!isPlainObject(mcpServers)) return [];
  const out: any[] = [];
  for (const [name, def] of Object.entries(mcpServers)) {
    if (!isPlainObject(def)) continue;
    const id = safeString((def as any).id).trim() || slugifyId(name) || 'imported';
    out.push({
      id,
      type: guessType(def),
      command: (def as any).command,
      args: (def as any).args,
      url: (def as any).url,
      headers: (def as any).headers,
    });
  }
  return out;
}

function extractDefsFromAnyPayload(payload: any) {
  const blocks = flattenImportPayload(payload);
  const out: any[] = [];
  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    if (isPlainObject((b as any).mcpServers)) {
      out.push(...extractDefsFromLegacyMcpServers(b));
      continue;
    }
    if ((b as any).id || (b as any).type || (b as any).command || (b as any).url) {
      out.push(b);
    }
  }
  return out;
}

function ensureUniqueId(baseId: string, existing: Set<string>) {
  let id = baseId;
  if (!id) id = 'imported';
  if (!existing.has(id)) {
    existing.add(id);
    return id;
  }
  for (let i = 2; i < 9999; i += 1) {
    const next = `${id}-${i}`;
    if (!existing.has(next)) {
      existing.add(next);
      return next;
    }
  }
  const fallback = `${id}-${Date.now()}`;
  existing.add(fallback);
  return fallback;
}

function downloadTextFile(filename: string, content: string, mime = 'application/json') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text: string) {
  const v = safeString(text);
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    return;
  } catch {
    // ignore
  }
  const ta = document.createElement('textarea');
  ta.value = v;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
}

export default function McpServersManager(props: Props) {
  const addToast = props.addToast;
  const [status, setStatus] = useState<any>(null);
  const [items, setItems] = useState<McpServerDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [testLoadingId, setTestLoadingId] = useState<string | null>(null);
  const [drawerPasteText, setDrawerPasteText] = useState('');
  const [marketOpen, setMarketOpen] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm<EditorForm>();
  const [pendingEditorValues, setPendingEditorValues] = useState<Partial<EditorForm> | null>(null);

  const normalizeItemOrThrow = useCallback((it: any, index: number): McpServerDef => {
    const id = safeString(it?.id).trim();
    const rawType = safeString(it?.type).trim() as McpServerType;
    const type = rawType === 'streamable_http' ? 'http' : rawType;
    if (!id) throw new Error(`第 ${index + 1} 项：id 不能为空`);
    if (!['stdio', 'websocket', 'http'].includes(type)) {
      throw new Error(`第 ${index + 1} 项（${id}）：type 非法: ${safeString(it?.type)}`);
    }

    const out: McpServerDef = { id, type };
    if (type === 'stdio') {
      const command = safeString(it?.command).trim();
      if (!command) throw new Error(`项（${id}）：stdio 类型需要 command`);
      out.command = command;
      const args = normalizeArgsInput((it as any)?.args);
      if (args.length) out.args = args;
      return out;
    }

    const url = safeString(it?.url).trim();
    if (!url) throw new Error(`项（${id}）：${type} 类型需要 url`);
    out.url = url;

    const headersRaw = (it as any)?.headers;
    if (headersRaw != null) {
      if (!headersRaw || typeof headersRaw !== 'object' || Array.isArray(headersRaw)) {
        throw new Error(`项（${id}）：headers 必须是 JSON 对象`);
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(headersRaw)) {
        const kk = safeString(k).trim();
        if (!kk) continue;
        headers[kk] = safeString(v).trim();
      }
      if (Object.keys(headers).length) out.headers = headers;
    }

    return out;
  }, []);

  const reloadAll = useCallback(async () => {
    setLoading(true);
    try {
      await ensureMcpServersFile();
      const st = await getMcpServersStatus();
      setStatus(st);
      const res = await fetchMcpServers();
      const rawItems = Array.isArray(res?.items) ? res.items : [];
      const normalized = rawItems.map((it, i) => {
        try {
          return normalizeItemOrThrow(it, i);
        } catch {
          return it as any;
        }
      });
      setItems(normalized as any);
      if (res?.parseError) {
        addToast?.('error', '配置文件解析失败', safeString(res.parseError));
      }
    } catch (e: any) {
      addToast?.('error', '加载失败', e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [addToast, normalizeItemOrThrow]);

  const applyPastedToForm = useCallback(async () => {
    const rawText = safeString(drawerPasteText).trim();
    if (!rawText) {
      addToast?.('warning', '未填写', '请先粘贴 JSON');
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch (e: any) {
      addToast?.('error', 'JSON 解析失败', e?.message || String(e));
      return;
    }
    const defs = extractDefsFromAnyPayload(parsed);
    if (!defs.length) {
      addToast?.('error', '未识别到配置', '请粘贴包含 mcpServers 或 server 定义的 JSON');
      return;
    }
    const first = defs[0] as any;

    const t = guessType(first);
    const next: Partial<EditorForm> = {
      type: t,
      command: safeString(first?.command).trim(),
      args: normalizeArgsInput(first?.args),
      url: safeString(first?.url).trim(),
      headersPairs: toHeadersPairsForEdit(first?.headers),
    };

    const currentId = safeString(form.getFieldValue('id')).trim();
    const pastedId = safeString(first?.id).trim() || safeString(first?.name).trim() || safeString(first?.title).trim();
    if (!currentId && pastedId) {
      next.id = slugifyId(pastedId) || pastedId;
    }

    setPendingEditorValues((prev) => ({ ...(prev || {}), ...next }));
    if (defs.length > 1) {
      addToast?.('warning', '已填充第 1 项', `检测到 ${defs.length} 项；如需全部导入请点“导入到列表”`);
    } else {
      addToast?.('success', '已填充', '已将 JSON 内容填充到表单');
    }
  }, [addToast, drawerPasteText, form]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    if (!editorOpen) return;
    if (!pendingEditorValues) return;
    const t = window.setTimeout(() => {
      try {
        form.setFieldsValue(pendingEditorValues as any);
      } finally {
        setPendingEditorValues(null);
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [editorOpen, form, pendingEditorValues]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    form.resetFields();
    const nextValues: Partial<EditorForm> = {
      id: '',
      type: 'stdio',
      command: 'cmd',
      args: ['/c'],
      url: '',
      headersPairs: [],
    };
    setPendingEditorValues(nextValues);
    setEditorOpen(true);
  }, [form]);

  const openEdit = useCallback((row: McpServerDef) => {
    setEditingId(row.id);
    form.resetFields();
    const nextValues: Partial<EditorForm> = {
      id: row.id,
      type: row.type,
      command: row.command || '',
      args: normalizeArgsInput((row as any).args),
      url: row.url || '',
      headersPairs: toHeadersPairsForEdit((row as any).headers),
    };
    setPendingEditorValues(nextValues);
    setEditorOpen(true);
  }, [form]);

  const deleteOne = useCallback((id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const handleTest = useCallback(async (row: McpServerDef) => {
    setTestLoadingId(row.id);
    try {
      const res = await testMcpServer(row);
      if (res && (res as any).success) {
        Modal.success({
          title: '测试通过',
          content: (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {JSON.stringify(res, null, 2)}
            </div>
          ),
          okText: '确定',
        });
      } else {
        Modal.error({
          title: '测试失败',
          content: (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {JSON.stringify(res, null, 2)}
            </div>
          ),
          okText: '确定',
        });
      }
    } catch (e: any) {
      Modal.error({
        title: '测试失败',
        content: safeString(e?.message || e),
        okText: '确定',
      });
    } finally {
      setTestLoadingId(null);
    }
  }, []);

  const saveAll = useCallback(async () => {
    setSaving(true);
    try {
      const normalized = (items || []).map((it, i) => normalizeItemOrThrow(it, i));
      const ids = normalized.map((x) => x.id);
      const unique = new Set(ids);
      if (unique.size !== ids.length) {
        throw new Error('存在重复 id，请先修复后再保存');
      }

      const res = await saveMcpServers(normalized);
      if (res?.success) {
        addToast?.('success', '保存成功', `已保存 ${res.count ?? normalized.length} 项`);
        await reloadAll();
      } else {
        addToast?.('error', '保存失败', 'Unknown error');
      }
    } catch (e: any) {
      addToast?.('error', '保存失败', e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [addToast, items, normalizeItemOrThrow, reloadAll]);

  const mergeImported = useCallback((payload: any) => {
    const raw = extractDefsFromAnyPayload(payload);
    if (!raw.length) {
      addToast?.('error', '导入失败', '未识别到可导入的配置（支持数组/对象，以及 mcpServers 格式）');
      return;
    }

    let summary: { added: number; updated: number; failed: number } | null = null;
    setItems((prev) => {
      const existingIds = new Set((prev || []).map((x) => safeString(x.id).trim()).filter(Boolean));
      const nextMap = new Map<string, McpServerDef>();
      for (const it of (prev || [])) {
        const id = safeString(it.id).trim();
        if (id) nextMap.set(id, it);
      }

      let added = 0;
      let updated = 0;
      let failed = 0;

      // 用于保证“导入过程中自动生成 id”的唯一性（不会影响已有 id 的更新语义）
      const generatedIds = new Set(existingIds);

      for (let i = 0; i < raw.length; i += 1) {
        try {
          const src = raw[i] as any;
          const explicitId = safeString(src?.id).trim();

          // 如果导入数据明确提供 id：
          // - id 已存在 => 更新
          // - id 不存在 => 新增
          // 不要自动改成 id-2（否则会破坏“更新”语义）
          const id = explicitId || ensureUniqueId(
            slugifyId(src?.name) || slugifyId(src?.title) || 'imported',
            generatedIds
          );

          const candidate = { ...src, id, type: guessType(src) };
          const normalized = normalizeItemOrThrow(candidate, i);
          if (nextMap.has(normalized.id)) updated += 1;
          else added += 1;
          nextMap.set(normalized.id, normalized);
        } catch {
          failed += 1;
        }
      }

      summary = { added, updated, failed };
      return Array.from(nextMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    });

    // 避免在 setState updater 里做副作用
    if (summary) {
      const { added, updated, failed } = summary;
      if (failed) addToast?.('warning', '导入完成（部分失败）', `新增 ${added}，更新 ${updated}，失败 ${failed}`);
      else addToast?.('success', '导入成功', `新增 ${added}，更新 ${updated}`);
    }
  }, [addToast, normalizeItemOrThrow]);

  const importPastedToList = useCallback(async () => {
    const rawText = safeString(drawerPasteText).trim();
    if (!rawText) {
      addToast?.('warning', '未填写', '请先粘贴 JSON');
      return;
    }
    try {
      const parsed = JSON.parse(rawText);
      mergeImported(parsed);
    } catch (e: any) {
      addToast?.('error', '导入失败', e?.message || String(e));
    }
  }, [addToast, drawerPasteText, mergeImported]);

  const handleEditorOk = useCallback(async () => {
    try {
      const v = await form.validateFields();
      const id = safeString(v.id).trim();
      const type = v.type;

      if (!id) throw new Error('id 不能为空');

      const existsOther = items.some((x) => x.id === id && x.id !== editingId);
      if (existsOther) throw new Error(`id 已存在: ${id}`);

      const next: McpServerDef = { id, type };

      if (type === 'stdio') {
        const command = safeString(v.command).trim();
        if (!command) throw new Error('stdio 类型需要 command');
        next.command = command;
        const args = normalizeArgsInput(v.args);
        if (args.length) next.args = args;
      } else {
        const url = safeString(v.url).trim();
        if (!url) throw new Error(`${type} 类型需要 url`);
        next.url = url;
        const headers = parseHeadersPairs(v.headersPairs);
        if (Object.keys(headers).length) next.headers = headers;
      }

      setItems((prev) => {
        const filtered = prev.filter((x) => x.id !== editingId);
        return [...filtered, next].sort((a, b) => a.id.localeCompare(b.id));
      });

      setEditorOpen(false);
      addToast?.('success', '已更新', id);
    } catch (e: any) {
      addToast?.('error', '校验失败', e?.message || String(e));
    }
  }, [addToast, editingId, form, items]);

  const columns: ColumnsType<McpServerDef> = useMemo(() => {
    return [
      {
        title: 'ID',
        dataIndex: 'id',
        key: 'id',
        width: 180,
        render: (v: any) => (
          <div className={styles.idCell}>
            <ApiOutlined />
            <Tooltip title={safeString(v)} placement="topLeft">
              <Typography.Text code ellipsis>{safeString(v)}</Typography.Text>
            </Tooltip>
          </div>
        ),
      },
      {
        title: '类型',
        dataIndex: 'type',
        key: 'type',
        width: 110,
        render: (v: any) => <Tag color="blue">{safeString(v)}</Tag>,
      },
      {
        title: '启动/地址',
        key: 'target',
        render: (_: any, row: McpServerDef) => {
          if (row.type === 'stdio') {
            const cmd = safeString(row.command);
            const args = normalizeArgsInput((row as any).args).join(' ');
            const text = (cmd + (args ? ` ${args}` : '')).trim();
            const t = text || '-';
            return (
              <div className={styles.targetCell}>
                <Tooltip title={<div className={styles.tooltipPre}>{t}</div>} placement="topLeft">
                  <Typography.Text ellipsis>{t}</Typography.Text>
                </Tooltip>
                {text ? (
                  <Button
                    size="small"
                    type="text"
                    icon={<CopyOutlined />}
                    onClick={async () => {
                      await copyToClipboard(text);
                      addToast?.('success', '已复制', '已复制启动命令');
                    }}
                  />
                ) : null}
              </div>
            );
          }
          const url = safeString(row.url) || '-';
          const copyText = safeString(row.url);
          return (
            <div className={styles.targetCell}>
              <Tooltip title={<div className={styles.tooltipPre}>{url}</div>} placement="topLeft">
                <Typography.Text ellipsis>{url}</Typography.Text>
              </Tooltip>
              {copyText ? (
                <Button
                  size="small"
                  type="text"
                  icon={<CopyOutlined />}
                  onClick={async () => {
                    await copyToClipboard(copyText);
                    addToast?.('success', '已复制', '已复制 URL');
                  }}
                />
              ) : null}
            </div>
          );
        },
      },
      {
        title: '操作',
        key: 'actions',
        width: 130,
        render: (_: any, row: McpServerDef) => {
          return (
            <Space size={4}>
              <Button icon={<EditOutlined />} onClick={() => openEdit(row)} />
              <Tooltip title="测试连接" placement="top">
                <Button
                  icon={<ApiOutlined />}
                  onClick={() => void handleTest(row)}
                  loading={testLoadingId === row.id}
                />
              </Tooltip>
              <Popconfirm
                title="确认删除?"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteOne(row.id)}
              >
                <Button danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          );
        },
      },
    ];
  }, [deleteOne, handleTest, openEdit, testLoadingId]);

  const rawJson = useMemo(() => {
    return JSON.stringify(items, null, 2);
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = safeString(search).trim().toLowerCase();
    if (!q) return items;
    return (items || []).filter((it) => {
      const id = safeString(it.id).toLowerCase();
      const url = safeString(it.url).toLowerCase();
      const cmd = safeString(it.command).toLowerCase();
      return id.includes(q) || url.includes(q) || cmd.includes(q);
    });
  }, [items, search]);

  const templates = useMemo(() => {
    const t: { key: string; group: 'local' | 'remote'; title: string; desc: string; preset: Partial<EditorForm> }[] = [
      {
        key: 'chrome-devtools',
        group: 'local',
        title: 'Chrome DevTools（stdio）',
        desc: '推荐给新手：本地启动一个 MCP 进程（npx）。',
        preset: {
          id: 'chrome-devtools',
          type: 'stdio',
          command: 'cmd',
          args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@latest'],
          headersPairs: [],
        },
      },
      {
        key: 'http',
        group: 'remote',
        title: 'HTTP / Streamable HTTP',
        desc: '连接远端 HTTP MCP 服务（支持一键测试）。',
        preset: {
          id: 'my-http-mcp',
          type: 'http',
          url: 'http://127.0.0.1:8000/mcp',
          headersPairs: [{ key: 'Authorization', value: 'Bearer <token>' }],
        },
      },
      {
        key: 'ws',
        group: 'remote',
        title: 'WebSocket',
        desc: '连接 WS MCP 服务（测试将提示暂不支持）。',
        preset: {
          id: 'my-ws-mcp',
          type: 'websocket',
          url: 'ws://127.0.0.1:8000/mcp',
          headersPairs: [],
        },
      },
    ];
    return t;
  }, []);

  const templateGroups = useMemo(() => {
    const local = templates.filter((t) => t.group === 'local');
    const remote = templates.filter((t) => t.group === 'remote');
    return [
      { key: 'local', title: '本机启动', icon: <LaptopOutlined />, items: local },
      { key: 'remote', title: '远端连接', icon: <CloudOutlined />, items: remote },
    ].filter((g) => g.items.length);
  }, [templates]);

  const handleUseTemplate = useCallback((tpl: { preset: Partial<EditorForm> }) => {
    setEditingId(null);
    form.resetFields();
    setPendingEditorValues(tpl.preset);
    setEditorOpen(true);
  }, [form]);

  const handleAddTemplate = useCallback((tpl: { key: string; preset: Partial<EditorForm> }) => {
    setItems((prev) => {
      let headers: Record<string, string> | undefined;
      try {
        headers = parseHeadersPairs((tpl.preset as any).headersPairs);
      } catch {
        headers = undefined;
      }

      const next: McpServerDef = {
        id: safeString((tpl.preset as any).id).trim() || `tpl-${tpl.key}`,
        type: (tpl.preset as any).type as any,
        command: (tpl.preset as any).command,
        args: normalizeArgsInput((tpl.preset as any).args),
        url: (tpl.preset as any).url,
        headers,
      };
      const filtered = (prev || []).filter((x) => x.id !== next.id);
      return [...filtered, next].sort((a, b) => a.id.localeCompare(b.id));
    });
    addToast?.('success', '已添加到列表', safeString((tpl.preset as any).id).trim() || tpl.key);
  }, [addToast]);

  const marketItems = useMemo(() => {
    return [
      {
        key: 'mcp-so',
        title: 'mcp.so',
        desc: 'MCP 服务发现平台',
        href: 'https://mcp.so/',
      },
      {
        key: 'smithery',
        title: 'smithery.ai',
        desc: 'Smithery MCP 工具',
        href: 'https://smithery.ai/',
      },
      {
        key: 'glama',
        title: 'glama.ai',
        desc: 'Glama MCP 服务器目录',
        href: 'https://glama.ai/mcp',
      },
      {
        key: 'pulsemcp',
        title: 'pulsemcp.com',
        desc: 'Pulse MCP 服务器',
        href: 'https://pulsemcp.com/',
      },
      {
        key: 'composio',
        title: 'mcp.composio.dev',
        desc: 'Composio MCP 开发工具',
        href: 'https://mcp.composio.dev/',
      },
      {
        key: 'official',
        title: 'Model Context Protocol Servers',
        desc: '官方 MCP 服务器集合',
        href: 'https://modelcontextprotocol.io/',
      },
      {
        key: 'awesome',
        title: 'Awesome MCP Servers',
        desc: '精选的 MCP 服务器列表（GitHub）',
        href: 'https://github.com/punkpeye/awesome-mcp-servers',
      },
      {
        key: 'import-chrome-devtools',
        title: 'Chrome DevTools MCP（本机）',
        desc: '免费常用：npx 拉起 chrome-devtools-mcp',
        href: 'https://github.com/modelcontextprotocol/servers',
        importPayload: {
          id: 'chrome-devtools',
          type: 'stdio',
          command: 'cmd',
          args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@latest'],
        },
      },
    ] as const;
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.shell}>
        <div className={styles.topbar}>
          <Space wrap style={{ width: '100%' }}>
            <Input
              placeholder="搜索：id / url / command"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 260 }}
              allowClear
            />
            <Button icon={<ReloadOutlined />} onClick={reloadAll} loading={loading}>刷新</Button>
            <Button icon={<PlusOutlined />} type="primary" onClick={openCreate}>新增</Button>
            <Button icon={<SaveOutlined />} onClick={saveAll} loading={saving} type="primary">保存</Button>
            <Upload
              accept="application/json"
              showUploadList={false}
              beforeUpload={async (file) => {
                try {
                  const text = await file.text();
                  const parsed = JSON.parse(text);
                  mergeImported(parsed);
                  return false;
                } catch (e: any) {
                  addToast?.('error', '导入失败', e?.message || String(e));
                  return false;
                }
              }}
            >
              <Button icon={<UploadOutlined />}>导入</Button>
            </Upload>
            <Button icon={<DownloadOutlined />} onClick={() => downloadTextFile('servers.json', rawJson)}>导出</Button>
            <Button icon={<AppstoreOutlined />} onClick={() => setMarketOpen(true)}>MCP 市场</Button>
          </Space>
        </div>

        {status?.parseError ? (
          <Alert
            type="error"
            showIcon
            message="servers.json 解析失败（请修复 JSON 格式）"
            description={<Typography.Text type="danger">{safeString(status?.parseError)}</Typography.Text>}
          />
        ) : null}

        <div className={styles.main}>
          <div className={styles.sidebar}>
            <div className={styles.templateList}>
              {templateGroups.map((g) => (
                <div key={g.key} className={styles.folderGroup}>
                  <div className={styles.folderHeader}>
                    <span className={styles.folderIcon}>{g.icon}</span>
                    <span className={styles.folderName}>{g.title}</span>
                    <span className={styles.fileCount}>({g.items.length})</span>
                  </div>

                  <div className={styles.folderFiles}>
                    {g.items.map((tpl) => (
                      <div key={tpl.key} className={styles.templateRow}>
                        <div className={styles.templateMain}>
                          <div className={styles.templateTitle}>{tpl.title}</div>
                          <div className={styles.templateDesc}>{tpl.desc}</div>
                        </div>
                        <div className={styles.templateActions}>
                          <Button size="small" type="primary" onClick={() => handleUseTemplate(tpl)}>使用</Button>
                          <Button size="small" onClick={() => handleAddTemplate(tpl)}>加入</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.content}>
            <Tabs
              items={[
                {
                  key: 'table',
                  label: '列表',
                  children: (
                    <Table
                      rowKey={(r) => r.id}
                      size="middle"
                      columns={columns}
                      dataSource={filteredItems}
                      loading={loading}
                      pagination={{ pageSize: 8, showSizeChanger: true }}
                      tableLayout="fixed"
                      locale={{
                        emptyText: (
                          <Empty description="还没有配置外部 MCP 服务器">
                            <Space wrap>
                              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增</Button>
                              <Button icon={<ReloadOutlined />} onClick={reloadAll} loading={loading}>刷新</Button>
                            </Space>
                          </Empty>
                        ),
                      }}
                    />
                  ),
                },
                {
                  key: 'raw',
                  label: 'Raw JSON',
                  children: (
                    <div className={styles.raw}>
                      <Input.TextArea
                        value={rawJson}
                        onChange={(e) => {
                          try {
                            const parsed = JSON.parse(e.target.value || '[]');
                            const defs = extractDefsFromAnyPayload(parsed);
                            if (!defs.length) return;
                            const used = new Set<string>();
                            const normalized = defs.map((it, i) => {
                              try {
                                const explicitId = safeString((it as any)?.id).trim();
                                const baseId = explicitId || slugifyId((it as any)?.name) || 'raw';
                                const id = explicitId || ensureUniqueId(baseId || `raw-${i + 1}`, used);
                                return normalizeItemOrThrow({ ...(it as any), id, type: guessType(it) }, i);
                              } catch {
                                return it as any;
                              }
                            });
                            setItems(normalized as any);
                          } catch {
                            // keep editing
                          }
                        }}
                        autoSize={{ minRows: 16, maxRows: 28 }}
                      />
                      <Typography.Text type="secondary">
                        说明: Raw JSON 支持数组/对象，以及 mcpServers 格式；仅在 JSON 可解析并能识别出配置时会同步到列表。
                      </Typography.Text>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </div>

      <Drawer
        open={editorOpen}
        title={editingId ? '编辑外部 MCP' : '新增外部 MCP'}
        onClose={() => setEditorOpen(false)}
        width={520}
        destroyOnHidden
        extra={(
          <Space>
            <Button onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => void handleEditorOk()}>保存到列表</Button>
          </Space>
        )}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item label="粘贴 JSON 一键填充（可选）">
            <Input.TextArea
              value={drawerPasteText}
              onChange={(e) => setDrawerPasteText(e.target.value)}
              autoSize={{ minRows: 4, maxRows: 10 }}
              placeholder='支持：mcpServers 格式 / 单对象 / 数组。粘贴后点“填充表单”。'
            />
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={() => void applyPastedToForm()}>填充表单</Button>
              <Button onClick={() => void importPastedToList()}>导入到列表</Button>
              <Button onClick={() => setDrawerPasteText('')}>清空</Button>
            </div>
          </Form.Item>

          <Form.Item
            name="id"
            label="ID"
            rules={[{ required: true, message: '请输入 id' }]}
          >
            <Input placeholder="例如: chrome-devtools" />
          </Form.Item>

          <Form.Item
            name="type"
            label="类型"
            rules={[{ required: true, message: '请选择 type' }]}
          >
            <Select
              options={[
                { label: 'stdio（由本机拉起进程）', value: 'stdio' },
                { label: 'websocket（连接远端）', value: 'websocket' },
                { label: 'http（Streamable HTTP）', value: 'http' },
              ]}
            />
          </Form.Item>

          <Form.Item shouldUpdate={(p, n) => p.type !== n.type} noStyle>
            {({ getFieldValue }) => {
              const t = getFieldValue('type') as McpServerType;
              if (t === 'stdio') {
                return (
                  <>
                    <Form.Item
                      name="command"
                      label="command"
                      rules={[{ required: true, message: 'stdio 需要 command' }]}
                    >
                      <Input placeholder="例如: cmd" />
                    </Form.Item>
                    <Form.List name="args">
                      {(fields, { add, remove }) => (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {fields.map((field) => (
                            <Space key={field.key} align="baseline" style={{ width: '100%' }}>
                              <Form.Item
                                {...field}
                                style={{ flex: 1, marginBottom: 0 }}
                                rules={[{ required: true, message: '参数不能为空' }]}
                              >
                                <Input placeholder="例如: npx" />
                              </Form.Item>
                              <Button type="text" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
                            </Space>
                          ))}
                          <Button type="dashed" icon={<PlusOutlined />} onClick={() => add('')}>添加参数</Button>
                        </div>
                      )}
                    </Form.List>
                  </>
                );
              }
              return (
                <>
                  <Form.Item
                    name="url"
                    label="url"
                    rules={[{ required: true, message: `${t} 需要 url` }]}
                  >
                    <Input placeholder="例如: http://127.0.0.1:3000/mcp" />
                  </Form.Item>
                  <Form.List name="headersPairs">
                    {(fields, { add, remove }) => (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {fields.map((field) => (
                          <Space key={field.key} align="baseline" style={{ width: '100%' }}>
                            <Form.Item
                              name={[field.name, 'key']}
                              style={{ flex: 1, marginBottom: 0 }}
                              rules={[{ required: true, message: 'key 不能为空' }]}
                            >
                              <Input placeholder="Header Key" />
                            </Form.Item>
                            <Form.Item
                              name={[field.name, 'value']}
                              style={{ flex: 1, marginBottom: 0 }}
                            >
                              <Input placeholder="Header Value" />
                            </Form.Item>
                            <Button type="text" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
                          </Space>
                        ))}
                        <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ key: '', value: '' })}>添加 Header</Button>
                      </div>
                    )}
                  </Form.List>
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        open={marketOpen}
        title="MCP 市场"
        onCancel={() => setMarketOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {marketItems.map((it) => (
            <div key={it.key} style={{ border: '1px solid rgba(0,0,0,0.06)', borderRadius: 12, padding: 12, background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Typography.Text style={{ fontWeight: 800 }}>{it.title}</Typography.Text>
                <div style={{ flex: '1 1 auto' }} />
                <Tooltip title="打开网站">
                  <Button
                    icon={<LinkOutlined />}
                    onClick={() => {
                      try { window.open(it.href, '_blank'); } catch { }
                    }}
                  />
                </Tooltip>
              </div>
              <Typography.Text type="secondary">{it.desc}</Typography.Text>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {'importPayload' in it ? (
                  <Button
                    type="primary"
                    onClick={() => {
                      mergeImported((it as any).importPayload);
                      addToast?.('success', '已导入到列表', it.title);
                    }}
                  >
                    一键导入
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
