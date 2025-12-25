import React, { useState, useEffect, useMemo } from 'react';
import { EnvVariable } from '../types/config';
import styles from './EnvEditor.module.css';
import { IoAdd, IoSave, IoTrash, IoInformationCircle, IoSearch, IoWarning, IoRefresh } from 'react-icons/io5';
import { motion, AnimatePresence } from 'framer-motion';
import { SafeInput } from './SafeInput';

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
  const [openEnumIndex, setOpenEnumIndex] = useState<number | null>(null);

  const filteredVars = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return vars
      .map((v, i) => ({ ...v, originalIndex: i }))
      .filter(v =>
        v.key.toLowerCase().includes(term) ||
        (v.value && v.value.toLowerCase().includes(term)) ||
        (v.comment && v.comment.toLowerCase().includes(term))
      );
  }, [vars, searchTerm]);

  // Handle global Ctrl+F to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('env-search-input')?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 点击页面其他位置时关闭当前打开的枚举下拉菜单
  useEffect(() => {
    if (openEnumIndex === null) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // 如果点击在任意 macSelect 容器内部，则不关闭
      if (target.closest(`.${styles.macSelect}`)) return;
      setOpenEnumIndex(null);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openEnumIndex]);

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
              <IoSearch className={styles.searchIcon} />
              <SafeInput
                id="env-search-input"
                type="text"
                placeholder="搜索配置..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className={styles.searchInput}
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
                <IoSearch className={styles.searchIcon} />
                <SafeInput
                  type="text"
                  placeholder="搜索配置..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className={styles.searchInput}
                />
              </div>
              <div className={styles.actions}>
                <button className={styles.macBtn} onClick={onAdd}>
                  <IoAdd size={14} style={{ marginRight: 4 }} />
                  新增
                </button>
                <button className={`${styles.macBtn} ${styles.primary}`} onClick={onSave} disabled={saving}>
                  <IoSave size={14} style={{ marginRight: 4 }} />
                  {saving ? '...' : '保存'}
                </button>
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
                  <button className={styles.macBtn} onClick={() => setRestoreConfirm(true)} title="重置为默认配置">
                    <IoRefresh size={14} style={{ marginRight: 4 }} />
                    重置
                  </button>
                )}
                <button className={styles.macBtn} onClick={onAdd}>
                  <IoAdd size={14} style={{ marginRight: 4 }} />
                  新增
                </button>
                <button className={`${styles.macBtn} ${styles.primary}`} onClick={onSave} disabled={saving}>
                  <IoSave size={14} style={{ marginRight: 4 }} />
                  {saving ? '...' : '保存'}
                </button>
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
            <IoInformationCircle size={16} />
            <span>当前正在预览默认配置 (.env.example)。保存后将创建新的 .env 配置文件。</span>
          </div>
        )}

        <div className={styles.scrollArea}>
          {vars.length === 0 ? (
            <div className={styles.emptyState}>
              <IoInformationCircle size={48} style={{ marginBottom: 16 }} />
              <div style={{ fontWeight: 500 }}>配置文件为空</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>点击右上角"新增"按钮添加配置项</div>
            </div>
          ) : (
            <div className={styles.settingsGroup}>
              {filteredVars.map((v) => {
                const meta = parseEnvMeta(v.comment);
                const type: EnvValueType = meta?.type || 'string';
                const description = meta?.description || firstNonMetaLine(v.comment) || '';
                const rawValue = v.value ?? '';
                const lowerValue = rawValue.toLowerCase();
                const boolValue = rawValue === 'true' || rawValue === '1' || lowerValue === 'yes' || lowerValue === 'on';
                const handleBooleanChange = (next: boolean) => {
                  onUpdate(v.originalIndex, 'value', next ? 'true' : 'false');
                };

                // 数字类型：允许直接输入，由浏览器原生 number 控件和后端校验负责约束
                const handleNumberChange = (raw: string) => {
                  onUpdate(v.originalIndex, 'value', raw);
                };

                // 只有纯文本/数字使用带边框的编辑容器，其余类型使用更轻量的 inline 容器，避免“外面一个大文本框”的观感
                const wrapperClassName =
                  type === 'string' || type === 'number'
                    ? styles.editorWrapper
                    : styles.inlineEditorBody;

                const isEnumOpen = openEnumIndex === v.originalIndex;
                const numberStep = type === 'number' ? inferNumberStep(meta?.range) : undefined;

                return (
                  <div key={v.originalIndex} className={styles.settingsRow}>
                    <div className={styles.rowTop}>
                      <div className={styles.keyBlock}>
                        <div className={styles.keyLine}>
                          {v.isNew ? (
                            <SafeInput
                              className={styles.newKeyInput}
                              value={v.key}
                              onChange={(e) => onUpdate(v.originalIndex, 'key', e.target.value)}
                              placeholder="NEW_KEY"
                              autoFocus
                            />
                          ) : (
                            <div className={styles.keyName}>{v.key}</div>
                          )}
                          <div className={styles.typeTag}>{typeLabelMap[type]}</div>
                        </div>
                        <div className={styles.descLine}>{description || '未填写说明'}</div>
                        <div className={styles.metaLine}>
                          {type === 'number' && meta?.range && (
                            <span className={`${styles.chip} ${styles.chipSoft}`}>
                              范围 {meta.range.min ?? '−∞'} ~ {meta.range.max ?? '∞'}
                            </span>
                          )}
                          {type === 'enum' && meta?.options && (
                            <div className={styles.optionChips}>
                              {meta.options.map(opt => (
                                <span key={opt} className={styles.optionChip}>{opt}</span>
                              ))}
                            </div>
                          )}
                          {type === 'array' && (
                            <span className={`${styles.chip} ${styles.chipSoft}`}>数组 / JSON</span>
                          )}
                        </div>
                      </div>
                      <button
                        className={styles.deleteBtn}
                        onClick={() => setDeleteConfirm({ index: v.originalIndex, key: v.key })}
                        title="删除"
                      >
                        <IoTrash size={16} />
                      </button>
                    </div>

                    <div className={wrapperClassName}>
                      {type === 'boolean' ? (
                        <div className={styles.booleanRow}>
                          <button
                            type="button"
                            className={styles.toggle}
                            data-checked={boolValue}
                            onClick={() => handleBooleanChange(!boolValue)}
                          >
                            <span className={styles.toggleKnob} />
                          </button>
                          <span className={styles.toggleLabel}>{boolValue ? '已启用' : '已关闭'}</span>
                        </div>
                      ) : type === 'enum' && meta?.options && meta.options.length > 0 ? (
                        <div className={styles.macSelect}>
                          <button
                            type="button"
                            className={styles.macSelectButton}
                            onClick={() => setOpenEnumIndex(isEnumOpen ? null : v.originalIndex)}
                          >
                            <span className={styles.macSelectLabel}>{v.value || meta.options[0] || '请选择'}</span>
                            <span className={styles.macSelectArrow}>▾</span>
                          </button>
                          {isEnumOpen && (
                            <div className={styles.macSelectMenu}>
                              {meta.options.map(opt => (
                                <div
                                  key={opt}
                                  className={`${styles.macSelectOption} ${v.value === opt ? styles.macSelectOptionActive : ''}`}
                                  onClick={() => {
                                    onUpdate(v.originalIndex, 'value', opt);
                                    setOpenEnumIndex(null);
                                  }}
                                >
                                  {opt}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : type === 'array' ? (
                        <textarea
                          className={styles.valueTextarea}
                          value={v.value}
                          onChange={(e) => onUpdate(v.originalIndex, 'value', e.target.value)}
                          placeholder="输入数组或 JSON..."
                          spellCheck={false}
                        />
                      ) : (
                        <input
                          type={type === 'number' ? 'number' : 'text'}
                          className={type === 'number' ? styles.valueInputNumber : styles.valueInput}
                          value={v.value}
                          onChange={(e) => {
                            if (type === 'number') {
                              handleNumberChange(e.target.value);
                            } else {
                              onUpdate(v.originalIndex, 'value', e.target.value);
                            }
                          }}
                          placeholder={type === 'number' ? '输入数字...' : '输入值...'}
                          spellCheck={false}
                          min={type === 'number' && meta?.range?.min !== undefined ? meta.range.min : undefined}
                          max={type === 'number' && meta?.range?.max !== undefined ? meta.range.max : undefined}
                          step={numberStep}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {deleteConfirm && (
          <div className={styles.modalOverlay} onClick={() => setDeleteConfirm(null)}>
            <motion.div
              className={styles.modalContent}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={e => e.stopPropagation()}
            >
              <div className={styles.modalIcon}>
                <IoWarning size={48} color="#FF3B30" />
              </div>
              <h3 className={styles.modalTitle}>确认删除?</h3>
              <p className={styles.modalText}>
                您确定要删除配置项 <span className={styles.highlight}>{deleteConfirm.key || '未命名'}</span> 吗？此操作无法撤销。
              </p>
              <div className={styles.modalActions}>
                <button
                  className={styles.cancelBtn}
                  onClick={() => setDeleteConfirm(null)}
                >
                  取消
                </button>
                <button
                  className={styles.confirmBtn}
                  onClick={() => {
                    onDelete(deleteConfirm.index);
                    setDeleteConfirm(null);
                  }}
                >
                  删除
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {restoreConfirm && (
          <div className={styles.modalOverlay} onClick={() => setRestoreConfirm(false)}>
            <motion.div
              className={styles.modalContent}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={e => e.stopPropagation()}
            >
              <div className={styles.modalIcon}>
                <IoWarning size={48} color="#FF3B30" />
              </div>
              <h3 className={styles.modalTitle}>确认重置?</h3>
              <p className={styles.modalText}>
                您确定要将当前配置重置为默认值 (.env.example) 吗？<br />
                <span style={{ color: '#FF3B30', fontWeight: 500 }}>当前的所有修改都将丢失！</span>
              </p>
              <div className={styles.modalActions}>
                <button
                  className={styles.cancelBtn}
                  onClick={() => setRestoreConfirm(false)}
                >
                  取消
                </button>
                <button
                  className={styles.confirmBtn}
                  onClick={() => {
                    if (onRestore) onRestore();
                    setRestoreConfirm(false);
                  }}
                >
                  确认重置
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};