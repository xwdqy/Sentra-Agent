import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './PresetImporter.module.css';
import type { PresetsEditorState } from '../hooks/usePresetsEditor';
import { convertPresetText, convertPresetTextStream, fetchPresetFile, savePresetFile } from '../services/api';
import { Button, Drawer, Input, InputNumber, Select, Switch, Upload } from 'antd';
import { storage } from '../utils/storage';
import {
  CloseOutlined,
  InboxOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons';

type ToastFn = (type: 'success' | 'error', title: string, message?: string) => void;

function normalizeJsonPreset(obj: any, fileBaseName: string) {
  const safeName = fileBaseName || 'AgentPreset';
  const base = obj && typeof obj === 'object' ? { ...obj } : {};

  if (!base.meta || typeof base.meta !== 'object') base.meta = {};
  const meta = base.meta as any;

  if (!meta.node_name && typeof base.node_name === 'string') meta.node_name = base.node_name;
  if (!meta.category && typeof base.category === 'string') meta.category = base.category;
  if (!meta.description && typeof base.description === 'string') meta.description = base.description;
  if (!meta.version && typeof base.version === 'string') meta.version = base.version;
  if (!meta.author && typeof base.author === 'string') meta.author = base.author;

  if (!meta.node_name) meta.node_name = safeName;
  if (!meta.category) meta.category = 'agent_preset';
  if (!meta.description) meta.description = 'Agent preset imported from JSON';

  if (!base.parameters || typeof base.parameters !== 'object' || Array.isArray(base.parameters)) {
    base.parameters = {};
  }

  if (!Array.isArray(base.rules)) {
    if (base.rules && typeof base.rules === 'object') {
      base.rules = [base.rules];
    } else {
      base.rules = [];
    }
  }

  return base;
}

function splitFileName(name: string) {
  const safe = String(name || '').replace(/[/\\]/g, '_');
  const dot = safe.lastIndexOf('.');
  if (dot <= 0 || dot === safe.length - 1) {
    return { base: safe, ext: '' };
  }
  return { base: safe.slice(0, dot), ext: safe.slice(dot) };
}

function buildTargetName(inputName: string, existingNames: Set<string>) {
  const { base, ext } = splitFileName(inputName);
  const normalized = `${base}${ext}`;
  if (!existingNames.has(normalized)) return normalized;
  const ts = Date.now();
  return `${base}_${ts}${ext}`;
}

export interface PresetImporterProps {
  onClose: () => void;
  theme: 'light' | 'dark';
  addToast: ToastFn;
  state: PresetsEditorState;
  embedded?: boolean;
}

export const PresetImporter: React.FC<PresetImporterProps> = ({ onClose, addToast, state, theme, embedded }) => {
  const [sourceMode, setSourceMode] = useState<'upload' | 'presets' | 'text'>(() => {
    const v = storage.getString('preset_importer.sourceMode', { fallback: '' }) as any;
    return v === 'presets' || v === 'text' || v === 'upload' ? v : 'upload';
  });
  const [file, setFile] = useState<File | null>(null);
  const [inputFileName, setInputFileName] = useState<string>(() => storage.getString('preset_importer.inputFileName', { fallback: 'pasted.txt' }));
  const [selectedPresetPath, setSelectedPresetPath] = useState<string>('');
  const [rawText, setRawText] = useState<string>('');
  const [targetName, setTargetName] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [activePreview, setActivePreview] = useState<'raw' | 'json' | 'xml'>('raw');
  const [convertedJson, setConvertedJson] = useState<any | null>(null);
  const [convertedXml, setConvertedXml] = useState<string>('');
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    const v = storage.getString('preset_importer.streamEnabled', { fallback: '' });
    return v === null ? true : v !== 'false';
  });
  const [streamText, setStreamText] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamTextRef = useRef<string>('');
  const flushRafRef = useRef<number | null>(null);

  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => storage.getString('preset_importer.apiBaseUrl', { fallback: '' }));
  const [apiKey, setApiKey] = useState<string>(() => storage.getString('preset_importer.apiKey', { fallback: '' }));
  const [model, setModel] = useState<string>(() => storage.getString('preset_importer.model', { fallback: '' }));
  const [temperature, setTemperature] = useState<string>(() => storage.getString('preset_importer.temperature', { fallback: '0' }));
  const [maxTokens, setMaxTokens] = useState<string>(() => storage.getString('preset_importer.maxTokens', { fallback: '-1' }));
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(() => storage.getBool('preset_importer.advancedOpen', { fallback: false }));
  const chatRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    // Migrate older defaults:
    // - streaming: default should be enabled unless user explicitly turned it off
    // - maxTokens: default should be -1 (omit max_tokens), instead of old 8192
    try {
      const userOverride = storage.getBool('preset_importer.streamEnabledUserOverride', { fallback: false });
      const storedStream = storage.getString('preset_importer.streamEnabled', { fallback: '' });
      if (!userOverride && storedStream === 'false') {
        storage.setString('preset_importer.streamEnabled', 'true');
        setStreamEnabled(true);
      }

      const storedMaxTokens = storage.getString('preset_importer.maxTokens', { fallback: '' });
      if (storedMaxTokens === null || storedMaxTokens === '8192') {
        storage.setString('preset_importer.maxTokens', '-1');
        setMaxTokens('-1');
      }
    } catch {
      // ignore
    }
  }, []);

  const effectiveFileName = useMemo(() => {
    if (sourceMode === 'upload') return file?.name || '';
    if (sourceMode === 'presets') return inputFileName || '';
    return inputFileName || '';
  }, [file, inputFileName, sourceMode]);

  const existingNames = useMemo(() => {
    const set = new Set<string>();
    for (const f of state.files || []) {
      if (f && typeof f.path === 'string' && !f.path.includes('/')) {
        set.add(f.path);
      }
      if (f && typeof f.name === 'string') {
        set.add(f.name);
      }
    }
    return set;
  }, [state.files]);

  useEffect(() => {
    storage.setString('preset_importer.sourceMode', sourceMode);
  }, [sourceMode]);

  useEffect(() => {
    storage.setString('preset_importer.inputFileName', inputFileName);
  }, [inputFileName]);

  useEffect(() => {
    if (!effectiveFileName) return;
    const name = effectiveFileName || 'preset.txt';
    const base = splitFileName(name).base || 'preset';
    const ext = splitFileName(name).ext || (name.includes('.') ? splitFileName(name).ext : '.txt');
    const lowerExt = String(ext || '').toLowerCase();
    setTargetName(lowerExt === '.json' ? `${base}.json` : `${base}.json`);
    setConvertedJson(null);
    setConvertedXml('');
    setStreamText('');
    streamTextRef.current = '';
    setIsStreaming(false);
    setActivePreview(ext.toLowerCase() === '.json' ? 'json' : 'raw');
  }, [effectiveFileName]);

  useEffect(() => {
    storage.setString('preset_importer.streamEnabled', String(streamEnabled));
  }, [streamEnabled]);

  useEffect(() => {
    storage.setString('preset_importer.apiBaseUrl', apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    storage.setString('preset_importer.apiKey', apiKey);
  }, [apiKey]);

  useEffect(() => {
    storage.setString('preset_importer.model', model);
  }, [model]);

  useEffect(() => {
    storage.setString('preset_importer.temperature', temperature);
  }, [temperature]);

  useEffect(() => {
    storage.setString('preset_importer.maxTokens', maxTokens);
  }, [maxTokens]);

  useEffect(() => {
    storage.setBool('preset_importer.advancedOpen', advancedOpen);
  }, [advancedOpen]);

  const handlePickFile = useCallback(async (f: File | null) => {
    setFile(f);
    setRawText('');
    setConvertedJson(null);
    setConvertedXml('');
    if (!f) return;

    try {
      const text = await f.text();
      setRawText(text);
      setInputFileName(f.name || 'preset.txt');
      setSourceMode('upload');
    } catch (e: any) {
      addToast('error', '读取失败', e?.message || String(e));
    }
  }, [addToast]);

  const isJsonFile = useMemo(() => {
    return !!effectiveFileName && String(effectiveFileName || '').toLowerCase().endsWith('.json');
  }, [effectiveFileName]);

  const isTextPresetFile = useMemo(() => {
    if (!effectiveFileName) return false;
    const lower = String(effectiveFileName || '').toLowerCase();
    return lower.endsWith('.txt') || lower.endsWith('.md') || (!lower.endsWith('.json'));
  }, [effectiveFileName]);

  const preparedContent = useMemo(() => {
    if (!effectiveFileName) return '';
    const name = String(effectiveFileName || '').toLowerCase();
    const trimmed = String(rawText || '');

    if (name.endsWith('.json')) {
      try {
        const obj = JSON.parse(trimmed);
        const baseName = splitFileName(effectiveFileName).base;
        const normalized = normalizeJsonPreset(obj, baseName);
        return JSON.stringify(normalized, null, 2);
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }, [effectiveFileName, rawText]);

  const preparedJsonPreview = useMemo(() => {
    if (convertedJson) {
      try {
        return JSON.stringify(convertedJson, null, 2);
      } catch {
        return String(convertedJson);
      }
    }

    if (!effectiveFileName) return '';
    if (!isJsonFile) return '';
    try {
      const obj = JSON.parse(String(rawText || '').trim());
      const baseName = splitFileName(effectiveFileName).base;
      const normalized = normalizeJsonPreset(obj, baseName);
      return JSON.stringify(normalized, null, 2);
    } catch {
      return '';
    }
  }, [convertedJson, effectiveFileName, isJsonFile, rawText]);

  useEffect(() => {
    const scrollToBottom = (el: HTMLElement | null) => {
      if (!el) return;
      // If user manually scrolled up, avoid fighting them unless they are near the bottom.
      const threshold = 40;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
      if (!atBottom && !isStreaming) return;
      el.scrollTop = el.scrollHeight;
    };

    // Defer to next frame so DOM has the latest content.
    requestAnimationFrame(() => {
      if (activePreview === 'raw') {
        scrollToBottom(chatRef.current);
      } else {
        scrollToBottom(previewRef.current);
      }
    });
  }, [activePreview, preparedContent, preparedJsonPreview, convertedXml, streamText, isStreaming, effectiveFileName]);

  const inferredTargetName = useMemo(() => {
    const name = targetName || effectiveFileName || 'preset.txt';
    return buildTargetName(name, existingNames);
  }, [effectiveFileName, existingNames, targetName]);

  const inferredJsonTargetName = useMemo(() => {
    const base = splitFileName(inferredTargetName).base || 'preset';
    const jsonName = `${base}.json`;
    return buildTargetName(jsonName, existingNames);
  }, [existingNames, inferredTargetName]);

  const handleConvert = useCallback(async () => {
    if (!effectiveFileName) {
      addToast('error', '转换失败', '请先选择文件或填写文件名');
      return;
    }
    if (!rawText.trim()) {
      addToast('error', '转换失败', '文件内容为空');
      return;
    }

    const apiBaseUrlTrimmed = apiBaseUrl.trim();
    const apiKeyTrimmed = apiKey.trim();
    if (!apiBaseUrlTrimmed) {
      addToast('error', '转换失败', '请填写 API Base URL');
      return;
    }
    if (!apiKeyTrimmed) {
      addToast('error', '转换失败', '请填写 API Key');
      return;
    }

    try {
      setSaving(true);
      const tempNum = Number(temperature);

      if (abortRef.current) {
        try { abortRef.current.abort(); } catch { }
      }
      abortRef.current = null;
      if (flushRafRef.current) {
        try { cancelAnimationFrame(flushRafRef.current); } catch { }
        flushRafRef.current = null;
      }
      streamTextRef.current = '';
      setStreamText('');
      setIsStreaming(false);

      const temperatureNum = Number.isFinite(tempNum) ? tempNum : 0;
      const maxTokensNum = Number(maxTokens);
      const maxTokensValue = Number.isFinite(maxTokensNum) && maxTokensNum > 0 ? maxTokensNum : undefined;

      if (streamEnabled) {
        setActivePreview('raw');
        const controller = new AbortController();
        abortRef.current = controller;
        setIsStreaming(true);

        const result = await convertPresetTextStream({
          text: rawText,
          fileName: effectiveFileName,
          apiBaseUrl: apiBaseUrlTrimmed,
          apiKey: apiKeyTrimmed,
          model: model.trim() || undefined,
          temperature: temperatureNum,
          maxTokens: maxTokensValue,
          signal: controller.signal,
          onToken: (delta) => {
            streamTextRef.current += delta;
            if (flushRafRef.current) return;
            flushRafRef.current = requestAnimationFrame(() => {
              flushRafRef.current = null;
              setStreamText(streamTextRef.current);
            });
          },
        });

        abortRef.current = null;
        setIsStreaming(false);
        setStreamText(streamTextRef.current);
        setConvertedJson(result.presetJson || null);
        setConvertedXml(result.presetXml || '');
        setActivePreview('raw');
        addToast('success', '转换成功', '已生成结构化预设，可直接保存为 .json');
        return;
      }

      const result = await convertPresetText({
        text: rawText,
        fileName: effectiveFileName,
        apiBaseUrl: apiBaseUrlTrimmed,
        apiKey: apiKeyTrimmed,
        model: model.trim() || undefined,
        temperature: temperatureNum,
        maxTokens: maxTokensValue,
      });

      setConvertedJson(result.presetJson || null);
      setConvertedXml(result.presetXml || '');
      setActivePreview('json');
      addToast('success', '转换成功', '已生成结构化预设，可直接保存为 .json');
    } catch (e: any) {
      if (String(e?.name || '') === 'AbortError') {
        addToast('error', '已停止', '已中止流式转换');
      } else {
        addToast('error', '转换失败', e?.message || String(e));
      }
    } finally {
      setIsStreaming(false);
      setSaving(false);
    }
  }, [addToast, apiBaseUrl, apiKey, effectiveFileName, maxTokens, model, rawText, streamEnabled, temperature]);

  const handleStop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    try { controller.abort(); } catch { }
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const presetOptions = useMemo(() => {
    const opts: { label: string; path: string }[] = [];
    for (const folder of state.folders || []) {
      for (const f of folder.files || []) {
        const label = folder.name === '根目录' ? f.name : `${folder.name}/${f.name}`;
        opts.push({ label, path: f.path });
      }
    }
    return opts;
  }, [state.folders]);

  const handlePickPreset = useCallback(async (path: string) => {
    setSelectedPresetPath(path);
    if (!path) return;
    try {
      setSaving(true);
      const res = await fetchPresetFile(path);
      setFile(null);
      setSourceMode('presets');
      setInputFileName(path.split('/').pop() || path);
      setRawText(res.content || '');
      setConvertedJson(null);
      setConvertedXml('');
      setStreamText('');
      streamTextRef.current = '';
      setIsStreaming(false);
    } catch (e: any) {
      addToast('error', '读取失败', e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [addToast]);

  const handleImport = useCallback(async () => {
    if (!effectiveFileName) {
      addToast('error', '保存失败', '请先选择文件或填写文件名');
      return;
    }

    const lower = String(effectiveFileName || '').toLowerCase();

    // txt/md: prefer structured conversion -> save as json
    if (!lower.endsWith('.json')) {
      if (!convertedJson) {
        addToast('error', '请先转换', 'txt/md 预设需要先转换为结构化预设，然后再保存。');
        return;
      }
      const content = JSON.stringify(convertedJson, null, 2);
      const actualTarget = inferredJsonTargetName;
      try {
        setSaving(true);
        await savePresetFile(actualTarget, content);
        addToast('success', '导入成功', `已保存到 agent-presets/${actualTarget}`);
        await state.refreshFiles();
      } catch (e: any) {
        addToast('error', '导入失败', e?.message || String(e));
      } finally {
        setSaving(false);
      }
      return;
    }

    // json: normalize + save
    const content = preparedContent;
    if (!content.trim()) {
      addToast('error', '导入失败', '文件内容为空');
      return;
    }

    const actualTarget = inferredTargetName;
    try {
      JSON.parse(String(rawText || '').trim());
    } catch {
      addToast('error', 'JSON 无法解析', '将按原始文本导入（未格式化/规范化）。');
    }

    try {
      setSaving(true);
      await savePresetFile(actualTarget, content);
      addToast('success', '导入成功', `已保存到 agent-presets/${actualTarget}`);
      await state.refreshFiles();
    } catch (e: any) {
      addToast('error', '导入失败', e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [addToast, convertedJson, effectiveFileName, inferredJsonTargetName, inferredTargetName, preparedContent, rawText, state]);

  return (
    <div
      className={embedded ? `${styles.container} ${styles.embedded}` : styles.container}
      style={{
        ['--pi-bg' as any]: theme === 'dark' ? '#0b0f14' : 'rgba(248, 250, 252, 0.96)',
        ['--pi-fg' as any]: theme === 'dark' ? 'rgba(226, 232, 240, 0.92)' : '#0f172a',
        ['--pi-muted' as any]: theme === 'dark' ? 'rgba(226, 232, 240, 0.62)' : 'rgba(15, 23, 42, 0.62)',
        ['--pi-border' as any]: theme === 'dark' ? 'rgba(148, 163, 184, 0.18)' : 'rgba(15, 23, 42, 0.12)',
        ['--pi-panel' as any]: theme === 'dark' ? 'rgba(2, 6, 23, 0.52)' : 'rgba(255, 255, 255, 0.72)',
        ['--pi-input-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.90)',
        ['--pi-preview-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.82)',
        ['--pi-btn-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.86)',
        ['--pi-primary-bg' as any]: theme === 'dark' ? '#ffffff' : '#111827',
        ['--pi-primary-fg' as any]: theme === 'dark' ? '#0b0f14' : '#ffffff',
        ['--pi-accent' as any]: 'var(--sentra-accent)',
        ['--pi-focus' as any]: 'rgba(var(--sentra-accent-rgb), 0.26)',
        ['--pi-seg-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.06)',
        ['--pi-seg-active-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.92)',
        ['--pi-seg-active-fg' as any]: theme === 'dark' ? 'rgba(226, 232, 240, 0.92)' : '#0f172a',
      }}
    >

      <div className={styles.topbar}>
        <div className={styles.topbarLeft}>
          <div className={styles.title}>预设导入</div>

          <div className={styles.segment} role="tablist" aria-label="导入来源">
            <button
              type="button"
              className={`${styles.segmentBtn} ${sourceMode === 'upload' ? styles.segmentBtnActive : ''}`}
              aria-selected={sourceMode === 'upload'}
              disabled={saving}
              onClick={() => setSourceMode('upload')}
            >
              上传
            </button>
            <button
              type="button"
              className={`${styles.segmentBtn} ${sourceMode === 'presets' ? styles.segmentBtnActive : ''}`}
              aria-selected={sourceMode === 'presets'}
              disabled={saving}
              onClick={() => {
                setSourceMode('presets');
                void state.refreshFiles();
              }}
            >
              预设库
            </button>
            <button
              type="button"
              className={`${styles.segmentBtn} ${sourceMode === 'text' ? styles.segmentBtnActive : ''}`}
              aria-selected={sourceMode === 'text'}
              disabled={saving}
              onClick={() => setSourceMode('text')}
            >
              文本
            </button>
          </div>

          <div className={styles.segment} role="tablist" aria-label="预览类型">
            <button
              type="button"
              className={`${styles.segmentBtn} ${activePreview === 'raw' ? styles.segmentBtnActive : ''}`}
              aria-selected={activePreview === 'raw'}
              onClick={() => setActivePreview('raw')}
            >
              文本
            </button>
            <button
              type="button"
              className={`${styles.segmentBtn} ${activePreview === 'json' ? styles.segmentBtnActive : ''}`}
              aria-selected={activePreview === 'json'}
              disabled={!effectiveFileName || (!isJsonFile && !convertedJson)}
              onClick={() => setActivePreview('json')}
            >
              JSON
            </button>
            <button
              type="button"
              className={`${styles.segmentBtn} ${activePreview === 'xml' ? styles.segmentBtnActive : ''}`}
              aria-selected={activePreview === 'xml'}
              disabled={!effectiveFileName || (!convertedXml)}
              onClick={() => setActivePreview('xml')}
            >
              XML
            </button>
          </div>
        </div>

        <div className={styles.topbarRight}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            onClick={() => setAdvancedOpen(true)}
          >
            高级设置
          </Button>
          {!embedded ? (
            <Button size="small" icon={<CloseOutlined />} onClick={onClose}>关闭</Button>
          ) : null}
        </div>
      </div>

      <div className={styles.workspace}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>输入</div>
          </div>

          <div className={styles.panelBody}>
            <div className={styles.subbar}>
              {sourceMode === 'upload' ? (
                <>
                  <Upload.Dragger
                    className={`${styles.uploadDragger} ${styles.uploadDraggerInline}`}
                    multiple={false}
                    showUploadList={false}
                    accept=".txt,.md,.json,.yaml,.yml,.toml,.ini,.conf,.prompt,.preset,.text"
                    disabled={saving}
                    beforeUpload={(f) => {
                      void handlePickFile(f as any);
                      return false;
                    }}
                  >
                    <div className={styles.uploadInlineContent}>
                      <InboxOutlined />
                      <div className={styles.uploadInlineText}>
                        {file ? `已选择：${file.name}` : '拖拽文件到这里，或点击选择'}
                      </div>
                    </div>
                  </Upload.Dragger>

                  {file ? (
                    <Button
                      size="small"
                      icon={<CloseOutlined />}
                      onClick={() => void handlePickFile(null)}
                      disabled={saving}
                    >
                      清除
                    </Button>
                  ) : null}
                </>
              ) : null}

              {sourceMode === 'presets' ? (
                <Select
                  size="small"
                  className={styles.compactControl}
                  value={selectedPresetPath || undefined}
                  onChange={(v) => void handlePickPreset(v || '')}
                  disabled={saving}
                  allowClear
                  placeholder="从预设库选择..."
                  options={presetOptions.map((o) => ({ label: o.label, value: o.path }))}
                />
              ) : null}

              {sourceMode !== 'upload' ? (
                <Input
                  size="small"
                  className={styles.compactControl}
                  value={inputFileName}
                  onChange={(e) => setInputFileName(e.target.value)}
                  placeholder="文件名（用于识别类型）例如: preset.txt / preset.json"
                  disabled={saving}
                />
              ) : null}
            </div>

            <div className={styles.editorPane}>
              <div className={styles.editorTextAreaWrap}>
                <Input.TextArea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder={effectiveFileName ? '在这里编辑输入内容…' : '请选择文件/预设，或直接输入文本…'}
                  disabled={saving}
                  autoSize={false}
                />
              </div>
            </div>
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>输出</div>
          </div>

          <div className={styles.panelBody}>
            {activePreview === 'raw' ? (
              <div className={styles.outputScroll} ref={chatRef}>
                <pre className={styles.code}><code>
                  {(() => {
                    if (!effectiveFileName) return '等待输入...';
                    if (isJsonFile) return 'JSON 文件不需要转换。你可以直接保存。';
                    const live = streamText || convertedXml;
                    if (saving && streamEnabled) return (live || '') + '\n';
                    return live || '点击“转换”开始生成（支持流式/非流式）。';
                  })()}
                </code></pre>
                {isStreaming ? <div className={styles.cursor} /> : null}
              </div>
            ) : (
              <pre className={styles.preview} ref={previewRef}><code>
                {!effectiveFileName ? '请选择文件/预设，或直接输入文本...' : (
                  activePreview === 'json'
                    ? (preparedJsonPreview || '暂无 JSON（txt/md 需要先点击“转换”）')
                    : (convertedXml || '暂无 XML（txt/md 需要先点击“转换”）')
                )}
              </code></pre>
            )}
          </div>
        </div>
      </div>

      <div className={styles.bottomBar}>
        <div className={styles.bottomBarLeft}>
          <div className={styles.bottomField}>
            <div className={styles.bottomFieldLabel}>保存文件名</div>
            <Input
              size="small"
              value={targetName}
              onChange={(e) => setTargetName(e.target.value)}
              placeholder="例如: my_preset.json"
              disabled={saving || isStreaming}
            />
          </div>
          <div className={styles.bottomHint}>
            保存到：agent-presets/{effectiveFileName ? (isJsonFile ? inferredTargetName : inferredJsonTargetName) : '-'}
          </div>
        </div>

        <div className={styles.bottomBarRight}>
          <div className={styles.inlineToggle}>
            <div className={styles.inlineToggleLabel}>流式</div>
            <Switch
              size="small"
              checked={streamEnabled}
              onChange={(checked) => {
                storage.setBool('preset_importer.streamEnabledUserOverride', true);
                setStreamEnabled(checked);
              }}
              disabled={saving}
            />
          </div>

          <Button
            size="small"
            onClick={() => {
              setFile(null);
              setSelectedPresetPath('');
              setRawText('');
              setTargetName('');
              setConvertedJson(null);
              setConvertedXml('');
              setStreamText('');
              streamTextRef.current = '';
              setIsStreaming(false);
            }}
            disabled={saving || isStreaming}
          >
            清空
          </Button>

          <Button
            size="small"
            icon={<PlayCircleOutlined />}
            onClick={() => void handleConvert()}
            disabled={!effectiveFileName || saving || isJsonFile || !isTextPresetFile}
            loading={saving && !isJsonFile && !isStreaming}
          >
            转换
          </Button>
          <Button
            size="small"
            icon={<PauseOutlined />}
            onClick={handleStop}
            disabled={!isStreaming}
          >
            停止
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            onClick={() => void handleImport()}
            disabled={!effectiveFileName || saving || isStreaming}
          >
            保存
          </Button>
        </div>
      </div>

      <Drawer
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        title={(
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <SettingOutlined />
            高级设置
          </span>
        )}
        placement="right"
        width={440}
        className={styles.advancedDrawer}
      >
        <div className={styles.advanced}>
          <div className={styles.cardTitle}>转换设置</div>

          <div className={styles.field} style={{ marginTop: 10 }}>
            <div className={styles.fieldLabel}>API Base URL</div>
            <Input size="small" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://xxx 或 https://xxx/v1" />
          </div>

          <div className={styles.field}>
            <div className={styles.fieldLabel}>API Key</div>
            <Input.Password size="small" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
          </div>

          <div className={styles.field}>
            <div className={styles.fieldLabel}>模型</div>
            <Input size="small" value={model} onChange={(e) => setModel(e.target.value)} placeholder="留空默认 gpt-4o-mini" />
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field} style={{ marginTop: 0 }}>
              <div className={styles.fieldLabel}>温度（number）</div>
              <InputNumber
                size="small"
                style={{ width: '100%' }}
                step={0.1}
                value={Number.isFinite(Number(temperature)) ? Number(temperature) : 0}
                onChange={(v) => setTemperature(String(v ?? ''))}
                placeholder="0"
              />
            </div>
            <div className={styles.field} style={{ marginTop: 0 }}>
              <div className={styles.fieldLabel}>max_tokens（number）</div>
              <InputNumber
                size="small"
                style={{ width: '100%' }}
                step={1}
                value={Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : -1}
                onChange={(v) => setMaxTokens(String(v ?? ''))}
                placeholder="-1"
              />
            </div>
          </div>

          <div className={styles.miniHint}>
            max_tokens 过小会导致内容被截断。
          </div>
        </div>
      </Drawer>
    </div>
  );
};
