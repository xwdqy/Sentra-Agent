import React, { useId, useState, useEffect, useMemo, useDeferredValue, useRef } from 'react';
import { EnvVariable } from '../types/config';
import styles from './EnvEditor.module.css';
import { ExclamationCircleOutlined, InfoCircleOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SearchOutlined, DeleteOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Empty, Input, InputNumber, Modal, Select, Switch, Table, Tag, Tooltip } from 'antd';

type EnvValueType = 'string' | 'number' | 'boolean' | 'enum' | 'array';

const typeLabelMap: Record<EnvValueType, string> = {
  string: '文本',
  number: '数字',
  boolean: '开关',
  enum: '枚举',
  array: '数组'
};

interface EnvFieldMeta {
  type: EnvValueType;
  description: string;
  range?: { min?: number; max?: number };
  options?: string[];
}

function parseEnvMeta(comment?: string): EnvFieldMeta | null {
  if (!comment) return null;
  const lines = comment.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let type: EnvValueType | undefined;
  let options: string[] | undefined;
  let range: { min?: number; max?: number } | undefined;
  const descLines: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, '');
    const lower = line.toLowerCase();

    if (lower.startsWith('type:')) {
      const val = line.slice(line.indexOf(':') + 1).trim().toLowerCase();
      if (val === 'number' || val === 'int' || val === 'integer') type = 'number';
      else if (val === 'boolean' || val === 'bool') type = 'boolean';
      else if (val === 'enum') type = 'enum';
      else if (val === 'array' || val === 'list') type = 'array';
      else type = 'string';
      continue;
    }

    if (lower.startsWith('options:')) {
      const val = line.slice(line.indexOf(':') + 1).trim();
      const parsed = val.split(/[|,]/).map(s => s.trim()).filter(Boolean);
      if (parsed.length > 0) {
        options = parsed;
        if (!type) type = 'enum';
      }
      continue;
    }

    if (lower.startsWith('range:')) {
      const val = line.slice(line.indexOf(':') + 1).trim();
      const m = val.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
      if (m) {
        const min = Number(m[1]);
        const max = Number(m[2]);
        range = { min, max };
      }
      continue;
    }

    descLines.push(line);
  }

  const description = descLines.join(' ');
  const resolvedType: EnvValueType = type || 'string';
  return { type: resolvedType, description, range, options };
}

function firstNonMetaLine(comment?: string): string {
  if (!comment) return '';
  const lines = comment.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, '').trim();
    const lower = line.toLowerCase();
    if (!line) continue;
    if (lower.startsWith('type:')) continue;
    if (lower.startsWith('options:')) continue;
    if (lower.startsWith('range:')) continue;
    return line;
  }
  return '';
}

function inferNumberStep(range?: { min?: number; max?: number }): number {
  if (!range) return 0.01;
  const max = range.max;
  if (typeof max !== 'number' || Number.isNaN(max)) return 0.01;
  if (max > 5) return 1;
  if (max >= 2) return 0.1;
  return 0.01;
}

interface EnvEditorProps {
  appName?: string;
  vars: EnvVariable[];
  onUpdate: (index: number, field: 'key' | 'value' | 'comment', val: string) => void;
  onAdd: () => void;
  onDelete: (index: number) => void;
  onSave: () => void;
  onRestore?: () => void;
  saving: boolean;
  isExample?: boolean;
  theme: 'light' | 'dark';
  isMobile?: boolean;
}

type EnvRow = {
  originalIndex: number;
};

export const EnvEditor: React.FC<EnvEditorProps> = ({
  appName,
  vars,
  onUpdate,
  onAdd,
  onDelete,
  onSave,
  onRestore,
  saving,
  isExample,
  theme,
  isMobile
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ index: number; key: string } | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState(false);

  const searchInputId = useId();
  const searchInputRef = useRef<any>(null);

  const [, forceLocalRerender] = useState(0);

  const deferredSearchTerm = useDeferredValue(searchTerm);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const [tableScrollY, setTableScrollY] = useState<number>(480);

  const metaCacheRef = useRef(new Map<number, {
    comment: string;
    keyUpper: string;
    meta: EnvFieldMeta | null;
    description: string;
    type: EnvValueType;
    isSecret: boolean;
    numberStep?: number;
    numberMin?: number;
    numberMax?: number;
  }>());

  const editingValuesRef = useRef<Record<number, string>>({});
  const valueDebounceTimersRef = useRef<Record<number, ReturnType<typeof setTimeout> | undefined>>({});

  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setTableScrollY(el.clientHeight);
    });
    ro.observe(el);
    setTableScrollY(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      const timers = valueDebounceTimersRef.current;
      Object.values(timers).forEach((t) => {
        if (t) clearTimeout(t);
      });
    };
  }, []);

  const filteredVars: EnvRow[] = useMemo(() => {
    const term = deferredSearchTerm.trim().toLowerCase();
    if (!term) {
      return vars.map((_, i) => ({ originalIndex: i }));
    }
    const out: EnvRow[] = [];
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      const key = String(v.key || '').toLowerCase();
      const displayName = String(v.displayName || '').toLowerCase();
      const value = String(v.value || '').toLowerCase();
      const comment = String(v.comment || '').toLowerCase();
      if (key.includes(term) || displayName.includes(term) || value.includes(term) || comment.includes(term)) {
        out.push({ originalIndex: i });
      }
    }
    return out;
  }, [deferredSearchTerm, vars]);

  const enableVirtual = true;

  const getDisplayValue = (idx: number, fallback: string) => {
    const obj = editingValuesRef.current;
    return Object.prototype.hasOwnProperty.call(obj, idx) ? obj[idx] : fallback;
  };

  const scheduleValueUpdate = (idx: number, nextVal: string) => {
    const timers = valueDebounceTimersRef.current;
    if (timers[idx]) clearTimeout(timers[idx]);
    timers[idx] = setTimeout(() => {
      onUpdate(idx, 'value', nextVal);
      timers[idx] = undefined;
    }, 80);
  };

  const handleValueChange = (idx: number, nextVal: string) => {
    editingValuesRef.current[idx] = nextVal;
    forceLocalRerender(v => v + 1);
    scheduleValueUpdate(idx, nextVal);
  };

  useEffect(() => {
    // When upstream values catch up with our debounced edits, clear local overrides.
    const obj = editingValuesRef.current;
    const keys = Object.keys(obj);
    if (keys.length === 0) return;
    for (const k of keys) {
      const idx = Number(k);
      const row = vars[idx];
      if (!row) continue;
      if (String(row.value ?? '') === obj[idx]) {
        delete obj[idx];
      }
    }
  }, [vars]);

  // Handle global Ctrl+F to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        try {
          searchInputRef.current?.focus?.();
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div
      className={`${styles.container} ${isMobile ? styles.mobileContainer : ''}`}
      data-theme={theme}
      onContextMenu={(e) => {
        e.stopPropagation();
      }}
    >
      {!isMobile && (
        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div className={styles.searchWrapper}>
              <SearchOutlined className={styles.searchIcon} />
              <Input
                id={searchInputId}
                placeholder="搜索配置..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className={styles.searchInput}
                allowClear
                ref={searchInputRef}
              />
            </div>
          </div>
          <div className={styles.sidebarContent}>
            <div className={styles.groupTitle}>通用设置</div>
            <div className={`${styles.sidebarItem} ${styles.active}`}>
              <span className="material-icons" style={{ fontSize: 16, marginRight: 8 }}>tune</span>
              环境变量
            </div>
          </div>
        </div>
      )}

      <div className={styles.mainContent}>
        <div className={styles.toolbar}>
          {isMobile ? (
            <>
              <div className={styles.mobileSearchInputBox}>
                <SearchOutlined className={styles.searchIcon} />
                <Input
                  placeholder="搜索配置..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className={styles.searchInput}
                  allowClear
                />
              </div>
              <div className={styles.actions}>
                <Button size="small" icon={<PlusOutlined />} onClick={onAdd}>
                  新增
                </Button>
                <Button type="primary" size="small" icon={<SaveOutlined />} onClick={onSave} loading={saving}>
                  保存
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.breadcrumb}>
                <span className={styles.badge}>{vars.length}</span> 配置项
                {appName && <span style={{ marginLeft: 8, opacity: 0.6 }}> • {appName}</span>}
              </div>
              <div className={styles.actions}>
                {onRestore && (
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => setRestoreConfirm(true)}>
                    重置
                  </Button>
                )}
                <Button size="small" icon={<PlusOutlined />} onClick={onAdd}>
                  新增
                </Button>
                <Button type="primary" size="small" icon={<SaveOutlined />} onClick={onSave} loading={saving}>
                  保存
                </Button>
              </div>
            </>
          )}
        </div>

        {isExample && (
          <div style={{
            background: '#3a3a10',
            color: '#dcdcaa',
            padding: '8px 20px',
            fontSize: '12px',
            borderBottom: '1px solid #4d4d18',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <InfoCircleOutlined />
            <span>当前正在预览默认配置 (.env.example)。保存后将创建新的 .env 配置文件。</span>
          </div>
        )}

        <div className={styles.scrollArea} ref={scrollAreaRef} style={enableVirtual ? { overflowY: 'hidden' } : undefined}>
          {vars.length === 0 ? (
            <div className={styles.emptyState}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="配置文件为空，点击右上角“新增”添加配置项" />
            </div>
          ) : (
            <Table
              className={styles.envListAntd}
              dataSource={filteredVars}
              rowKey={(v: any) => String(v.originalIndex)}
              pagination={false}
              size="small"
              showHeader={false}
              scroll={enableVirtual ? { y: tableScrollY } : undefined}
              {...(enableVirtual ? ({ virtual: true } as any) : {})}
              columns={[
                {
                  key: 'row',
                  render: (_: any, v: any) => {
                    const row = vars[v.originalIndex];
                    if (!row) return null;

                    const keyUpper = String(row.key || '').toUpperCase();
                    let cached = metaCacheRef.current.get(v.originalIndex);
                    if (!cached || cached.comment !== String(row.comment ?? '') || cached.keyUpper !== keyUpper) {
                      const meta = parseEnvMeta(row.comment);
                      const type: EnvValueType = meta?.type || 'string';
                      const description = meta?.description || firstNonMetaLine(row.comment) || '';
                      const isSecret = /KEY|TOKEN|SECRET|PASSWORD/.test(keyUpper);
                      const numberStep = type === 'number' ? inferNumberStep(meta?.range) : undefined;
                      const numberMin = type === 'number' && meta?.range?.min !== undefined ? meta.range.min : undefined;
                      const numberMax = type === 'number' && meta?.range?.max !== undefined ? meta.range.max : undefined;
                      cached = {
                        comment: String(row.comment ?? ''),
                        keyUpper,
                        meta,
                        description,
                        type,
                        isSecret,
                        numberStep,
                        numberMin,
                        numberMax,
                      };
                      metaCacheRef.current.set(v.originalIndex, cached);
                    }

                    const meta = cached.meta;
                    const type = cached.type;
                    const description = cached.description;
                    const displayName = String(row.displayName ?? '').trim();
                    const rawValue = getDisplayValue(v.originalIndex, String(row.value ?? ''));
                    const lowerValue = rawValue.toLowerCase();
                    const boolValue = rawValue === 'true' || rawValue === '1' || lowerValue === 'yes' || lowerValue === 'on';
                    const hasCnName = Boolean(displayName);

                    // 数字类型：允许直接输入，由浏览器原生 number 控件和后端校验负责约束
                    // 只有纯文本/数字使用带边框的编辑容器，其余类型使用更轻量的 inline 容器，避免“外面一个大文本框”的观感

                    const isSecret = cached.isSecret;
                    const numberStep = cached.numberStep;
                    const numberMin = cached.numberMin;
                    const numberMax = cached.numberMax;

                    const control = (
                      type === 'boolean' ? (
                        <Switch
                          checked={boolValue}
                          onChange={(next) => onUpdate(v.originalIndex, 'value', next ? 'true' : 'false')}
                          size="small"
                        />
                      ) : type === 'enum' && meta?.options && meta.options.length > 0 ? (
                        <Select
                          value={rawValue || undefined}
                          onChange={(next) => onUpdate(v.originalIndex, 'value', String(next ?? ''))}
                          options={meta.options.map(opt => ({ value: opt, label: opt }))}
                          showSearch
                          allowClear
                          styles={{ popup: { root: { minWidth: 240 } } }}
                          popupMatchSelectWidth={false}
                          style={{ width: '100%' }}
                        />
                      ) : type === 'array' ? (
                        <Input.TextArea
                          value={rawValue}
                          onChange={(e) => handleValueChange(v.originalIndex, e.target.value)}
                          placeholder="输入数组或 JSON..."
                          autoSize={{ minRows: 2, maxRows: 6 }}
                          spellCheck={false}
                          style={{ width: '100%' }}
                        />
                      ) : type === 'number' ? (
                        <InputNumber
                          value={Number.isFinite(Number(rawValue)) ? Number(rawValue) : null}
                          onChange={(next) => handleValueChange(v.originalIndex, next == null ? '' : String(next))}
                          placeholder="输入数字..."
                          step={numberStep}
                          min={numberMin}
                          max={numberMax}
                          style={{ width: '100%' }}
                        />
                      ) : isSecret ? (
                        <Input.Password
                          value={rawValue}
                          onChange={(e) => handleValueChange(v.originalIndex, e.target.value)}
                          placeholder="输入密钥..."
                          allowClear
                          style={{ width: '100%' }}
                          autoComplete="new-password"
                          iconRender={(visible) => (visible ? <EyeOutlined /> : <EyeInvisibleOutlined />)}
                        />
                      ) : (
                        <Input
                          value={rawValue}
                          onChange={(e) => handleValueChange(v.originalIndex, e.target.value)}
                          placeholder="输入值..."
                          allowClear
                          style={{ width: '100%' }}
                          type="text"
                        />
                      )
                    );

                    return (
                      <div className={styles.envListItem}>
                        <div className={styles.envMetaTitle}>
                          <div className={styles.envMetaName}>
                            {row.isNew ? (
                              <Input
                                value={row.key}
                                onChange={(e) => onUpdate(v.originalIndex, 'key', e.target.value)}
                                placeholder="NEW_KEY"
                                autoFocus
                                style={{ width: '100%' }}
                              />
                            ) : (
                              <Tooltip
                                trigger={isMobile ? ['click'] : ['hover']}
                                placement="topLeft"
                                title={<span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>{row.key}</span>}
                              >
                                <div className={styles.envMetaCnName}>{hasCnName ? displayName : '未提供中文名称'}</div>
                              </Tooltip>
                            )}

                            {!row.isNew ? (
                              <div className={styles.envMetaKeyMuted}>{String(row.key || '')}</div>
                            ) : null}
                          </div>
                          <div className={styles.envMetaTags}>
                            <Tag color="blue">{typeLabelMap[type]}</Tag>
                            {type === 'number' && meta?.range ? (
                              <Tag color="gold">范围 {meta.range.min ?? '−∞'} ~ {meta.range.max ?? '∞'}</Tag>
                            ) : null}
                            {type === 'enum' && meta?.options?.length ? (
                              <Tag color="purple">{meta.options.length} 选项</Tag>
                            ) : null}
                            {type === 'array' ? <Tag color="cyan">数组/JSON</Tag> : null}
                            {isSecret ? <Tag color="volcano">敏感</Tag> : null}
                          </div>
                        </div>

                        <div className={styles.envMetaDesc}>
                          <div className={styles.envMetaHelp}>{description || '未填写说明'}</div>
                        </div>

                        <div className={styles.envListAction}>
                          <div className={styles.envControlRow}>{control}</div>
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => setDeleteConfirm({ index: v.originalIndex, key: row.key })}
                            aria-label="删除"
                            title="删除"
                          />
                        </div>
                      </div>
                    );
                  },
                },
              ]}
            />
          )}
        </div>
      </div>

      <Modal
        title="确认删除"
        open={!!deleteConfirm}
        onCancel={() => setDeleteConfirm(null)}
        onOk={() => {
          if (!deleteConfirm) return;
          onDelete(deleteConfirm.index);
          setDeleteConfirm(null);
        }}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        destroyOnHidden
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <ExclamationCircleOutlined style={{ color: '#ff4d4f', marginTop: 2 }} />
          <div>
            确定要删除配置项 <span className={styles.highlight}>{deleteConfirm?.key || '未命名'}</span> 吗？此操作无法撤销。
          </div>
        </div>
      </Modal>

      <Modal
        title="确认重置"
        open={restoreConfirm}
        onCancel={() => setRestoreConfirm(false)}
        onOk={() => {
          if (onRestore) onRestore();
          setRestoreConfirm(false);
        }}
        okText="确认重置"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        destroyOnHidden
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <InfoCircleOutlined style={{ color: '#faad14', marginTop: 2 }} />
          <div>
            您确定要将当前配置重置为默认值 (.env.example) 吗？
            <div style={{ color: '#ff4d4f', fontWeight: 700, marginTop: 8 }}>当前的所有修改都将丢失！</div>
          </div>
        </div>
      </Modal>
    </div>
  );
};