import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Card, Collapse, Input, InputNumber, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tag, Tooltip, Upload } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, FileImageOutlined, PictureOutlined, ReloadOutlined, SaveOutlined, SearchOutlined, TagsOutlined, UploadOutlined, WarningOutlined } from '@ant-design/icons';
import styles from './EmojiStickersManager.module.css';
import { fetchFileContent } from '../../services/api';
import {
  deleteEmojiStickerFile,
  ensureEmojiStickers,
  fetchEmojiStickersItems,
  renameEmojiStickerFile,
  saveEmojiStickersItems,
  uploadEmojiSticker,
  type EmojiStickerItem,
} from '../../services/emojiStickersApi';

type Row = EmojiStickerItem & { key: string; hasFile: boolean };

type Props = {
  addToast: (type: 'success' | 'error' | 'warning' | 'info', title: string, message?: string) => void;
};

function isAllowedImageFilename(name: string) {
  const s = String(name || '').trim();
  if (!s) return false;
  if (s.includes('..')) return false;
  if (s.includes('/') || s.includes('\\')) return false;
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg|ico|tif|tiff|avif|heic|heif)$/i.test(s);
}

function uniqStrings(xs: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const s = String(x || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeTagList(vals: any) {
  const xs = Array.isArray(vals) ? vals : [];
  return uniqStrings(xs.map(v => String(v || '').trim()).filter(Boolean));
}

async function fileToDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export default function EmojiStickersManager(props: Props) {
  const addToast = props.addToast;
  const { modal } = App.useApp();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [tagChoices, setTagChoices] = useState<string[]>([]);

  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [filterQuery, setFilterQuery] = useState<string>('');

  const [autoCompress, setAutoCompress] = useState(true);
  const [compressMaxDim, setCompressMaxDim] = useState(160);
  const [compressQuality, setCompressQuality] = useState(80);

  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFilename, setPreviewFilename] = useState<string>('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameFrom, setRenameFrom] = useState<string>('');
  const [renameTo, setRenameTo] = useState<string>('');

  const loadAll = useCallback(async (ensureFirst = false) => {
    setLoading(true);
    try {
      if (ensureFirst) {
        await ensureEmojiStickers();
      }
      const data = await fetchEmojiStickersItems();
      const fileSet = new Set((data.files || []).map(f => String(f.filename)));
      const nextRows: Row[] = (data.items || []).map((it) => ({
        key: String(it.filename),
        filename: String(it.filename),
        description: String(it.description || ''),
        category: it.category ? String(it.category) : undefined,
        tags: Array.isArray((it as any).tags) ? (it as any).tags.map((t: any) => String(t)) : undefined,
        enabled: it.enabled !== false,
        hasFile: fileSet.has(String(it.filename)),
      }));
      setRows(nextRows);
      setTagChoices(uniqStrings(nextRows.flatMap(r => Array.isArray((r as any).tags) ? (r as any).tags : [])));

      // Best-effort preload a limited number of thumbs.
      const maxThumbs = 80;
      const need = nextRows
        .filter(r => r.hasFile)
        .map(r => r.filename)
        .filter(fn => !thumbsRef.current[fn])
        .slice(0, maxThumbs);

      if (need.length) {
        const concurrency = 6;
        let idx = 0;
        const worker = async () => {
          while (idx < need.length) {
            const current = need[idx++];
            try {
              const p = `utils/emoji-stickers/emoji/${current}`;
              const file = await fetchFileContent(p);
              if (file?.isBinary && typeof file.content === 'string' && file.content.startsWith('data:')) {
                setThumbs(prev => ({ ...prev, [current]: file.content }));
              }
            } catch {
              // ignore
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      }
    } catch (e: any) {
      addToast('error', '加载表情包失败', e?.message ? String(e.message) : String(e));
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadAll(true);
  }, [loadAll]);

  const hasDirty = useMemo(() => {
    // Very simple dirty heuristic: if any row has empty description while enabled, or category missing.
    // We still allow saving; this only affects the button state.
    return rows.length > 0;
  }, [rows.length]);

  const stats = useMemo(() => {
    const total = rows.length;
    const files = rows.filter(r => r.hasFile).length;
    const enabled = rows.filter(r => r.enabled !== false).length;
    const configured = rows.filter(r => String(r.description || '').trim()).length;
    const missingDesc = rows.filter(r => r.hasFile && r.enabled !== false && !String(r.description || '').trim()).length;
    const tagsCount = uniqStrings(rows.flatMap(r => Array.isArray((r as any).tags) ? (r as any).tags : [])).length;
    return { total, files, enabled, configured, missingDesc, tagsCount };
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = String(filterQuery || '').trim().toLowerCase();
    const tags = normalizeTagList(filterTags);
    return rows.filter(r => {
      if (q) {
        const hay = `${r.filename} ${r.description || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (tags.length) {
        const rt = normalizeTagList((r as any).tags);
        if (!rt.some(t => tags.includes(t))) return false;
      }
      return true;
    });
  }, [filterQuery, filterTags, rows]);

  const tagDist = useMemo(() => {
    const counts = new Map<string, number>();
    const base = filteredRows;
    for (const r of base) {
      const rt = normalizeTagList((r as any).tags);
      if (!rt.length) continue;
      for (const t of rt) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const arr = Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }));
    arr.sort((a, b) => b.count - a.count);
    return arr;
  }, [filteredRows]);

  const handleRowChange = useCallback((key: string, patch: Partial<Row>) => {
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
    if ((patch as any)?.tags) {
      const normalized = normalizeTagList((patch as any).tags);
      setTagChoices(prev => uniqStrings([...prev, ...normalized]));
    }
  }, []);

  const handleSaveAll = useCallback(async () => {
    setSaving(true);
    try {
      const items = rows.map(r => ({
        filename: r.filename,
        description: r.description,
        category: r.category,
        tags: Array.isArray((r as any).tags) ? (r as any).tags : undefined,
        enabled: r.enabled,
      }));
      await saveEmojiStickersItems({ items, applyEnv: true });
      addToast('success', '已保存', '表情包配置已同步');
      await loadAll(false);
    } catch (e: any) {
      addToast('error', '保存失败', e?.message ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  }, [addToast, loadAll, rows]);

  const handleDeleteFile = useCallback(async (filename: string) => {
    try {
      await deleteEmojiStickerFile(filename);
      addToast('success', '已删除文件', filename);
      await loadAll(false);
    } catch (e: any) {
      addToast('error', '删除失败', e?.message ? String(e.message) : String(e));
    }
  }, [addToast, loadAll]);

  const openPreview = useCallback(async (filename: string) => {
    const fn = String(filename || '').trim();
    if (!fn) return;
    try {
      if (!thumbsRef.current[fn]) {
        const p = `utils/emoji-stickers/emoji/${fn}`;
        const file = await fetchFileContent(p);
        if (file?.isBinary && typeof file.content === 'string' && file.content.startsWith('data:')) {
          setThumbs(prev => ({ ...prev, [fn]: file.content }));
        }
      }
    } catch {
      // ignore
    }
    setPreviewFilename(fn);
    setPreviewOpen(true);
  }, []);

  const handleStartRename = useCallback((filename: string) => {
    const fn = String(filename || '').trim();
    if (!fn) return;
    setRenameFrom(fn);
    setRenameTo(fn);
    setRenameOpen(true);
  }, []);

  const handleConfirmRename = useCallback(async () => {
    const from = String(renameFrom || '').trim();
    const to = String(renameTo || '').trim();
    if (!from || !to) {
      addToast('warning', '文件名不能为空');
      return;
    }
    if (!isAllowedImageFilename(to)) {
      addToast('warning', '文件名不合法', '请勿包含 .. 或路径分隔符（/ \\），并且扩展名必须是图片格式');
      return;
    }

    setSaving(true);
    try {
      await renameEmojiStickerFile({ from, to });
      setThumbs(prev => {
        const next = { ...prev };
        if (next[from]) {
          next[to] = next[from];
          delete next[from];
        }
        return next;
      });
      addToast('success', '已重命名', `${from} -> ${to}`);
      setRenameOpen(false);
      await loadAll(false);
    } catch (e: any) {
      addToast('error', '重命名失败', e?.message ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  }, [addToast, loadAll, renameFrom, renameTo]);

  const columns: ColumnsType<Row> = useMemo(() => {
    return [
      {
        title: '预览',
        dataIndex: 'filename',
        width: 80,
        render: (_v: any, row: Row) => {
          const src = thumbs[row.filename];
          return (
            <div
              className={`${styles.thumb} ${styles.thumbClickable}`}
              role="button"
              tabIndex={0}
              onClick={() => openPreview(row.filename)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') openPreview(row.filename);
              }}
            >
              {src ? <img src={src} alt={row.filename} /> : <PictureOutlined style={{ color: 'var(--sentra-muted-fg)' }} />}
            </div>
          );
        }
      },
      {
        title: '文件',
        dataIndex: 'filename',
        width: 220,
        render: (v: any, row: Row) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className={styles.monoEllipsis} title={String(v)}>{String(v)}</div>
            {!row.hasFile && <Tag color="warning">缺少文件</Tag>}
          </div>
        )
      },
      {
        title: '描述',
        dataIndex: 'description',
        render: (v: any, row: Row) => (
          <Input
            value={String(v || '')}
            placeholder="例如：虎鲸猫-探头"
            onChange={(e) => handleRowChange(row.key, { description: e.target.value })}
          />
        )
      },
      {
        title: '标签',
        dataIndex: 'tags',
        width: 260,
        render: (v: any, row: Row) => {
          const value = normalizeTagList(v);
          return (
            <Select
              className={styles.tagSelect}
              mode="tags"
              value={value}
              placeholder="添加标签（如：高兴/委屈/生气）"
              options={tagChoices.map(t => ({ value: t, label: t }))}
              onChange={(vals) => handleRowChange(row.key, { tags: normalizeTagList(vals) } as any)}
              maxTagCount="responsive"
              style={{ width: '100%' }}
              styles={{ popup: { root: { minWidth: 320 } } }}
            />
          );
        }
      },
      {
        title: '启用',
        dataIndex: 'enabled',
        width: 90,
        render: (v: any, row: Row) => (
          <Switch checked={v !== false} onChange={(checked) => handleRowChange(row.key, { enabled: checked })} />
        )
      },
      {
        title: '操作',
        width: 170,
        render: (_v: any, row: Row) => (
          <Space>
            <Button size="small" onClick={() => handleStartRename(row.filename)} disabled={!row.hasFile}>
              重命名
            </Button>
            <Popconfirm
              title="删除文件"
              description={`确定删除 ${row.filename} 吗？这会从 emoji 文件夹中移除图片。`}
              okText="删除"
              cancelText="取消"
              onConfirm={() => handleDeleteFile(row.filename)}
              disabled={!row.hasFile}
            >
              <Button danger size="small" disabled={!row.hasFile}>删除文件</Button>
            </Popconfirm>
          </Space>
        )
      }
    ];
  }, [handleDeleteFile, handleRowChange, openPreview, tagChoices, thumbs]);

  const uploadProps = useMemo(() => {
    return {
      multiple: true,
      showUploadList: false,
      accept: 'image/*',
      beforeUpload: async (file: any) => {
        try {
          const f = file as File;
          const filename = f.name;
          if (!isAllowedImageFilename(filename)) {
            addToast('warning', '仅允许图片文件', '支持 png/jpg/jpeg/gif/webp/bmp/svg/ico/tif/tiff/avif/heic/heif');
            return false;
          }
          if (f.type && !String(f.type).startsWith('image/')) {
            addToast('warning', '仅允许图片文件');
            return false;
          }
          const dataUrl = await fileToDataUrl(f);
          await uploadEmojiSticker({
            filename,
            dataUrl,
            compress: autoCompress,
            maxDim: compressMaxDim,
            quality: compressQuality,
          });
          addToast('success', '上传成功', filename);
          await loadAll(false);
        } catch (e: any) {
          addToast('error', '上传失败', e?.message ? String(e.message) : String(e));
        }
        return false;
      }
    };
  }, [addToast, autoCompress, compressMaxDim, compressQuality, loadAll]);

  const handleEnsureDirs = useCallback(async () => {
    setLoading(true);
    try {
      await ensureEmojiStickers();
      addToast('success', '目录已就绪', '已确保 emoji-stickers 与 emoji 文件夹存在');
      await loadAll(false);
    } catch (e: any) {
      addToast('error', '创建目录失败', e?.message ? String(e.message) : String(e));
    } finally {
      setLoading(false);
    }
  }, [addToast, loadAll]);

  const showHelp = useCallback(() => {
    modal.info({
      title: '使用说明',
      content: (
        <div style={{ lineHeight: 1.7 }}>
          <div>1. 上传图片到 <code>utils/emoji-stickers/emoji</code>。</div>
          <div>2. 给每个文件填写“描述”（建议简短，便于 AI 理解）。</div>
          <div>3. 给图片打“标签”（支持多标签、可新增），便于检索与分组。</div>
          <div>4. 点击“保存并写入 .env”，运行时会从 <code>utils/emoji-stickers/.env</code> 加载。</div>
        </div>
      ),
      okText: '知道了',
    });
  }, [modal]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <PictureOutlined />
            </div>
            <div className={styles.title}>上传/分类/压缩</div>
          </div>
        </div>

        <div className={styles.actions}>
          <Button onClick={showHelp}>说明</Button>
          <Button icon={<ReloadOutlined />} onClick={() => loadAll(false)} loading={loading}>刷新</Button>
          <Button onClick={handleEnsureDirs} loading={loading}>自动创建目录</Button>
          <Tooltip
            title={
              <div style={{ lineHeight: 1.6 }}>
                <div>上传时按比例缩小，直到长边 ≤ 最大边长</div>
                <div>建议：最大边长 80~128，更符合表情包</div>
              </div>
            }
          >
            <Space size={6} style={{ padding: '0 6px' }}>
              <span style={{ fontSize: 12, color: 'var(--sentra-muted-fg)' }}>自动压缩</span>
              <Switch size="small" checked={autoCompress} onChange={setAutoCompress} />
              <InputNumber
                size="small"
                min={32}
                max={2048}
                value={compressMaxDim}
                onChange={(v) => setCompressMaxDim(Number(v) || 160)}
                controls={false}
                style={{ width: 76 }}
                disabled={!autoCompress}
              />
              <InputNumber
                size="small"
                min={1}
                max={100}
                value={compressQuality}
                onChange={(v) => setCompressQuality(Number(v) || 80)}
                controls={false}
                style={{ width: 68 }}
                disabled={!autoCompress}
              />
            </Space>
          </Tooltip>
          <Upload {...(uploadProps as any)}>
            <Button icon={<UploadOutlined />} loading={loading}>上传文件</Button>
          </Upload>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSaveAll}
            loading={saving}
            disabled={!hasDirty}
          >
            保存
          </Button>
        </div>
      </div>

      <div className={styles.dashboard}>
        <Card size="small" styles={{ body: { padding: 12 } }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileImageOutlined style={{ color: '#1677ff' }} />
              <div style={{ fontWeight: 600 }}>图片文件</div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{stats.files}</div>
          </div>
          <Progress percent={stats.total ? Math.round((stats.files / stats.total) * 100) : 0} strokeColor="#1677ff" size="small" />
        </Card>

        <Card size="small" styles={{ body: { padding: 12 } }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <PictureOutlined style={{ color: '#52c41a' }} />
              <div style={{ fontWeight: 600 }}>已配置描述</div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{stats.configured}</div>
          </div>
          <Progress percent={stats.total ? Math.round((stats.configured / stats.total) * 100) : 0} strokeColor="#52c41a" size="small" />
        </Card>

        <Card size="small" styles={{ body: { padding: 12 } }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircleOutlined style={{ color: '#722ed1' }} />
              <div style={{ fontWeight: 600 }}>启用</div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{stats.enabled}</div>
          </div>
          <Progress percent={stats.total ? Math.round((stats.enabled / stats.total) * 100) : 0} strokeColor="#722ed1" size="small" />
        </Card>

        <Card size="small" styles={{ body: { padding: 12 } }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <WarningOutlined style={{ color: stats.missingDesc ? '#ff4d4f' : 'var(--sentra-muted-fg)' }} />
              <div style={{ fontWeight: 600 }}>缺描述</div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: stats.missingDesc ? '#ff4d4f' : 'inherit' }}>{stats.missingDesc}</div>
          </div>
          <Progress percent={stats.total ? Math.round((stats.missingDesc / stats.total) * 100) : 0} strokeColor={stats.missingDesc ? '#ff4d4f' : '#d9d9d9'} size="small" />
        </Card>
      </div>

      <Card size="small" styles={{ body: { padding: 12 } }}>
        <div className={styles.filters}>
          <Select
            className={styles.tagSelect}
            mode="multiple"
            allowClear
            placeholder="按标签过滤"
            value={filterTags}
            style={{ minWidth: 220 }}
            options={tagChoices.map(t => ({ value: t, label: t }))}
            onChange={(vals) => setFilterTags(normalizeTagList(vals))}
            maxTagCount="responsive"
          />
          <Input
            allowClear
            placeholder="搜索文件名/描述"
            prefix={<SearchOutlined />}
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            style={{ minWidth: 240 }}
          />
          <Button onClick={() => { setFilterTags([]); setFilterQuery(''); }}>清空筛选</Button>
          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--sentra-muted-fg)' }}>
            共 {stats.total} 条，筛选后 {filteredRows.length} 条
          </div>
        </div>
      </Card>

      <Collapse
        size="small"
        items={[{
          key: 'tags',
          label: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TagsOutlined />
              <div>标签分布</div>
            </div>
          ),
          children: (
            <div className={styles.tagDist}>
              {(tagDist.length ? tagDist : []).slice(0, 12).map(({ tag, count }) => {
                const base = Math.max(filteredRows.length, 1);
                const percent = Math.round((count / base) * 100);
                return (
                  <div className={styles.tagRow} key={tag}>
                    <Tooltip title={tag}>
                      <Button
                        type={normalizeTagList(filterTags).includes(tag) ? 'primary' : 'default'}
                        size="small"
                        onClick={() => {
                          const cur = new Set(normalizeTagList(filterTags));
                          if (cur.has(tag)) cur.delete(tag);
                          else cur.add(tag);
                          setFilterTags(Array.from(cur));
                        }}
                        style={{ justifyContent: 'flex-start' }}
                        block
                      >
                        <span className={styles.tagName}>{tag}</span>
                      </Button>
                    </Tooltip>
                    <Progress percent={percent} size="small" strokeColor="#faad14" />
                    <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{count}</div>
                  </div>
                );
              })}
              {tagDist.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--sentra-muted-fg)' }}>
                  当前筛选结果里还没有标签数据。
                </div>
              )}
            </div>
          )
        }]}
      />

      <div className={styles.content}>
        <div className={styles.tableWrap}>
          <Table
            size="middle"
            rowKey="key"
            loading={loading}
            dataSource={filteredRows}
            columns={columns}
            tableLayout="fixed"
            pagination={{ pageSize: 12, showSizeChanger: true }}
          />
        </div>
      </div>

      <Modal
        open={previewOpen}
        title={previewFilename || '预览'}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width={560}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {previewFilename && thumbs[previewFilename] ? (
            <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
              <img
                src={thumbs[previewFilename]}
                alt={previewFilename}
                style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 12, border: '1px solid var(--sentra-border-strong)' }}
              />
            </div>
          ) : (
            <div style={{ color: 'var(--sentra-muted-fg)' }}>无预览</div>
          )}
          <div style={{ fontSize: 12, color: 'var(--sentra-muted-fg)' }}>
            路径：<code>utils/emoji-stickers/emoji/{previewFilename || '-'}</code>
          </div>
        </div>
      </Modal>

      <Modal
        open={renameOpen}
        title="重命名文件"
        onCancel={() => setRenameOpen(false)}
        onOk={handleConfirmRename}
        okText="确认"
        cancelText="取消"
        confirmLoading={saving}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--sentra-muted-fg)' }}>
            原文件名：<code>{renameFrom || '-'}</code>
          </div>
          <Input
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            placeholder="例如：cat_001.png"
          />
          <div style={{ fontSize: 12, color: 'var(--sentra-muted-fg)' }}>
            请勿包含 .. 或路径分隔符（/ \\），且扩展名必须是图片（png/jpg/jpeg/gif/webp/bmp/svg/ico/tif/tiff/avif/heic/heif）。
          </div>
        </div>
      </Modal>
    </div>
  );
}
