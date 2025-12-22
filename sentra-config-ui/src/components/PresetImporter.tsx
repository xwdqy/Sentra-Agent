import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './PresetImporter.module.css';
import type { PresetsEditorState } from '../hooks/usePresetsEditor';
import { convertPresetText, convertPresetTextStream, fetchPresetFile, savePresetFile } from '../services/api';

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
    const v = localStorage.getItem('preset_importer.sourceMode') as any;
    return v === 'presets' || v === 'text' || v === 'upload' ? v : 'upload';
  });
  const [file, setFile] = useState<File | null>(null);
  const [inputFileName, setInputFileName] = useState<string>(() => localStorage.getItem('preset_importer.inputFileName') || 'pasted.txt');
  const [selectedPresetPath, setSelectedPresetPath] = useState<string>('');
  const [rawText, setRawText] = useState<string>('');
  const [targetName, setTargetName] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [activePreview, setActivePreview] = useState<'raw' | 'json' | 'xml'>('raw');
  const [convertedJson, setConvertedJson] = useState<any | null>(null);
  const [convertedXml, setConvertedXml] = useState<string>('');
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    const v = localStorage.getItem('preset_importer.streamEnabled');
    return v === null ? true : v !== 'false';
  });
  const [streamText, setStreamText] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamTextRef = useRef<string>('');
  const flushRafRef = useRef<number | null>(null);

  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => localStorage.getItem('preset_importer.apiBaseUrl') || '');
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('preset_importer.apiKey') || '');
  const [model, setModel] = useState<string>(() => localStorage.getItem('preset_importer.model') || '');
  const [temperature, setTemperature] = useState<string>(() => localStorage.getItem('preset_importer.temperature') || '0');
  const [maxTokens, setMaxTokens] = useState<string>(() => localStorage.getItem('preset_importer.maxTokens') || '-1');
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(() => (localStorage.getItem('preset_importer.advancedOpen') || 'false') === 'true');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);

  const [streamDebugOpen, setStreamDebugOpen] = useState<boolean>(() => (localStorage.getItem('preset_importer.streamDebugOpen') || 'false') === 'true');
  const [streamDebugEvents, setStreamDebugEvents] = useState<Array<{ type: string; at: number; message?: string }>>([]);
  const [streamDebugMeta, setStreamDebugMeta] = useState<{ status?: number; contentType?: string; bytes?: number; frames?: number; tokens?: number; lastAt?: number }>({});
  const [liveOutputOpen, setLiveOutputOpen] = useState<boolean>(() => (localStorage.getItem('preset_importer.liveOutputOpen') || 'true') === 'true');

  const liveBoxRef = useRef<HTMLDivElement | null>(null);
  const debugLogRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    localStorage.setItem('preset_importer.streamDebugOpen', String(streamDebugOpen));
  }, [streamDebugOpen]);

  useEffect(() => {
    localStorage.setItem('preset_importer.liveOutputOpen', String(liveOutputOpen));
  }, [liveOutputOpen]);

  useEffect(() => {
    if (!liveOutputOpen) return;
    const el = liveBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [liveOutputOpen, streamText, convertedXml, isStreaming]);

  useEffect(() => {
    if (!streamDebugOpen) return;
    const el = debugLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [streamDebugOpen, streamDebugEvents.length]);

  useEffect(() => {
    // Migrate older defaults:
    // - streaming: default should be enabled unless user explicitly turned it off
    // - maxTokens: default should be -1 (omit max_tokens), instead of old 8192
    try {
      const userOverride = localStorage.getItem('preset_importer.streamEnabledUserOverride') === 'true';
      const storedStream = localStorage.getItem('preset_importer.streamEnabled');
      if (!userOverride && storedStream === 'false') {
        localStorage.setItem('preset_importer.streamEnabled', 'true');
        setStreamEnabled(true);
      }

      const storedMaxTokens = localStorage.getItem('preset_importer.maxTokens');
      if (storedMaxTokens === null || storedMaxTokens === '8192') {
        localStorage.setItem('preset_importer.maxTokens', '-1');
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
    localStorage.setItem('preset_importer.sourceMode', sourceMode);
  }, [sourceMode]);

  useEffect(() => {
    localStorage.setItem('preset_importer.inputFileName', inputFileName);
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
    localStorage.setItem('preset_importer.streamEnabled', String(streamEnabled));
  }, [streamEnabled]);

  useEffect(() => {
    localStorage.setItem('preset_importer.apiBaseUrl', apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    localStorage.setItem('preset_importer.apiKey', apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem('preset_importer.model', model);
  }, [model]);

  useEffect(() => {
    localStorage.setItem('preset_importer.temperature', temperature);
  }, [temperature]);

  useEffect(() => {
    localStorage.setItem('preset_importer.maxTokens', maxTokens);
  }, [maxTokens]);

  useEffect(() => {
    localStorage.setItem('preset_importer.advancedOpen', String(advancedOpen));
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
      setStreamDebugEvents([]);
      setStreamDebugMeta({});

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
          apiBaseUrl: apiBaseUrl.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
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
          onDebugEvent: (evt) => {
            setStreamDebugMeta({
              status: evt.status,
              contentType: evt.contentType,
              bytes: evt.bytesReceived,
              frames: evt.framesReceived,
              tokens: evt.tokensReceived,
              lastAt: evt.at,
            });
            setStreamDebugEvents((prev) => {
              const next = prev.concat({
                type: evt.type,
                at: evt.at,
                message: evt.message || (evt.event ? `event=${evt.event}` : undefined),
              });
              return next.length > 120 ? next.slice(next.length - 120) : next;
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
        apiBaseUrl: apiBaseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
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

  const openFilePicker = useCallback(() => {
    if (saving) return;
    const el = fileInputRef.current;
    if (!el) return;
    try {
      el.value = '';
    } catch { }
    el.click();
  }, [saving]);

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

  const onDropFile = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const f = e.dataTransfer?.files && e.dataTransfer.files[0] ? e.dataTransfer.files[0] : null;
    void handlePickFile(f);
  }, [handlePickFile]);

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
        ['--pi-bg' as any]: theme === 'dark' ? '#0B0B0D' : '#FFFFFF',
        ['--pi-fg' as any]: theme === 'dark' ? '#F5F5F6' : '#0B0B0D',
        ['--pi-muted' as any]: theme === 'dark' ? 'rgba(245, 245, 246, 0.62)' : 'rgba(11, 11, 13, 0.58)',
        ['--pi-border' as any]: theme === 'dark' ? 'rgba(245, 245, 246, 0.10)' : 'rgba(11, 11, 13, 0.10)',
        ['--pi-panel' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(11, 11, 13, 0.03)',
        ['--pi-input-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(11, 11, 13, 0.04)',
        ['--pi-preview-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.04)' : 'rgba(11, 11, 13, 0.03)',
        ['--pi-btn-bg' as any]: theme === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(11, 11, 13, 0.04)',
        ['--pi-primary-bg' as any]: theme === 'dark' ? '#FFFFFF' : '#0B0B0D',
        ['--pi-primary-fg' as any]: theme === 'dark' ? '#0B0B0D' : '#FFFFFF',
      }}
    >
      {!embedded ? (
        <div className={styles.topbar}>
          <div className={styles.title}>预设导入</div>
          <div className={styles.topbarRight}>
            <div className={styles.segment}>
              <button type="button" className={activePreview === 'raw' ? `${styles.segmentBtn} ${styles.segmentBtnActive}` : styles.segmentBtn} onClick={() => setActivePreview('raw')}>Raw</button>
              <button type="button" className={activePreview === 'json' ? `${styles.segmentBtn} ${styles.segmentBtnActive}` : styles.segmentBtn} onClick={() => setActivePreview('json')} disabled={!effectiveFileName || (!isJsonFile && !convertedJson)}>JSON</button>
              <button type="button" className={activePreview === 'xml' ? `${styles.segmentBtn} ${styles.segmentBtnActive}` : styles.segmentBtn} onClick={() => setActivePreview('xml')} disabled={!effectiveFileName || (!convertedXml)}>XML</button>
            </div>
            <button type="button" className={styles.btn} onClick={onClose}>关闭</button>
          </div>
        </div>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.sidebar}>
          <div className={styles.sectionTitle}>文件</div>

          <div className={styles.sourceTabs}>
            <button type="button" className={sourceMode === 'upload' ? `${styles.tabBtn} ${styles.tabBtnActive}` : styles.tabBtn} onClick={() => setSourceMode('upload')} disabled={saving}>上传</button>
            <button type="button" className={sourceMode === 'presets' ? `${styles.tabBtn} ${styles.tabBtnActive}` : styles.tabBtn} onClick={() => { setSourceMode('presets'); void state.refreshFiles(); }} disabled={saving}>预设库</button>
            <button type="button" className={sourceMode === 'text' ? `${styles.tabBtn} ${styles.tabBtnActive}` : styles.tabBtn} onClick={() => setSourceMode('text')} disabled={saving}>文本</button>
          </div>

          <input
            ref={fileInputRef}
            className={styles.hiddenFileInput}
            type="file"
            accept=".txt,.md,.json,.yaml,.yml,.toml,.ini,.conf,.prompt,.preset,.text"
            onChange={(e) => void handlePickFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
          />

          {sourceMode === 'upload' ? (
            <>
              <div
                className={dragActive ? `${styles.fileDrop} ${styles.fileDropActive}` : styles.fileDrop}
                onClick={openFilePicker}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openFilePicker();
                  }
                }}
                onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
                onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(false); }}
                onDrop={onDropFile}
                role="button"
                tabIndex={0}
              >
                <button type="button" className={styles.paperclipBtn} onClick={(e) => { e.stopPropagation(); openFilePicker(); }} disabled={saving}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M21 10.5L12.7 18.8C10.4 21.1 6.7 21.1 4.4 18.8C2.1 16.5 2.1 12.8 4.4 10.5L13.4 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M17.7 6.2L8.7 15.2C7.5 16.4 5.6 16.4 4.4 15.2C3.2 14 3.2 12.1 4.4 10.9L13.4 1.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.55"/>
                  </svg>
                </button>
                <div className={styles.fileDropText}>
                  <div className={styles.fileDropTitle}>{file ? '已选择文件' : '拖拽文件到这里'}</div>
                  <div className={styles.fileDropSub}>{file ? '点击替换，或拖拽新文件覆盖' : '或点击回形针选择文件'}</div>
                </div>
              </div>

              {file ? (
                <div className={styles.filePill}>
                  <div className={styles.filePillName}>{file.name}</div>
                  <div className={styles.filePillMeta}>{Math.max(1, Math.round(file.size / 1024))} KB</div>
                  <button
                    type="button"
                    className={styles.removeBtn}
                    onClick={() => void handlePickFile(null)}
                    disabled={saving}
                    aria-label="移除文件"
                  >
                    ×
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {sourceMode === 'presets' ? (
            <div className={styles.field}>
              <div className={styles.fieldLabel}>从预设文件夹选择</div>
              <select
                className={styles.select}
                value={selectedPresetPath}
                onChange={(e) => void handlePickPreset(e.target.value)}
                disabled={saving}
              >
                <option value="">请选择...</option>
                {presetOptions.map((o) => (
                  <option key={o.path} value={o.path}>{o.label}</option>
                ))}
              </select>
            </div>
          ) : null}

          {sourceMode !== 'upload' ? (
            <div className={styles.field}>
              <div className={styles.fieldLabel}>文件名（用于识别类型）</div>
              <input
                className={styles.input}
                value={inputFileName}
                onChange={(e) => setInputFileName(e.target.value)}
                placeholder="例如: preset.txt / preset.json"
                disabled={saving}
              />
            </div>
          ) : null}

          {sourceMode === 'text' ? (
            <div className={styles.field}>
              <div className={styles.fieldLabel}>输入/粘贴文本</div>
              <textarea
                className={styles.textarea}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="直接粘贴预设文本..."
                disabled={saving}
              />
            </div>
          ) : null}

          <div className={styles.sectionTitle}>保存文件名</div>
          <input
            className={styles.input}
            value={targetName}
            onChange={(e) => setTargetName(e.target.value)}
            placeholder="例如: my_preset.json"
          />

          <div className={styles.miniHint}>
            最终保存路径：agent-presets/{effectiveFileName ? (isJsonFile ? inferredTargetName : inferredJsonTargetName) : '-'}
          </div>

          <div className={styles.sectionTitle}>输出</div>
          <div className={styles.switchRow}>
            <div className={styles.fieldLabel}>流式输出</div>
            <label className={styles.switch}>
              <input
                className={styles.switchInput}
                type="checkbox"
                checked={streamEnabled}
                onChange={(e) => {
                  try { localStorage.setItem('preset_importer.streamEnabledUserOverride', 'true'); } catch { }
                  setStreamEnabled(e.target.checked);
                }}
                disabled={saving}
              />
              <span className={styles.switchTrack} />
              <span className={styles.switchThumb} />
            </label>
          </div>

          <div className={styles.liveHeader}>
            <div className={styles.liveTitle}>实时输出</div>
            <button
              type="button"
              className={styles.liveToggle}
              onClick={() => setLiveOutputOpen((v) => !v)}
            >
              {liveOutputOpen ? '收起' : '展开'}
            </button>
          </div>

          {liveOutputOpen ? (
            <div className={styles.liveBox} ref={liveBoxRef}>
              <pre className={styles.livePre}><code>
                {(() => {
                  if (!effectiveFileName) return '等待输入...';
                  if (isJsonFile) return 'JSON 文件不需要转换。你可以直接保存。';
                  const live = streamText || convertedXml;
                  if (isStreaming) return (live || '') + '\n';
                  return live || '点击“转换”后这里会实时显示模型生成内容。';
                })()}
              </code></pre>
            </div>
          ) : null}

          <div className={styles.debugHeader}>
            <div className={styles.debugTitle}>流式状态</div>
            <button
              type="button"
              className={styles.debugToggle}
              onClick={() => setStreamDebugOpen((v) => !v)}
            >
              {streamDebugOpen ? '收起' : '展开'}
            </button>
          </div>

          <div className={styles.debugSummary}>
            <div>content-type: {streamDebugMeta.contentType || '-'}</div>
            <div>bytes: {typeof streamDebugMeta.bytes === 'number' ? streamDebugMeta.bytes : '-'}</div>
            <div>frames: {typeof streamDebugMeta.frames === 'number' ? streamDebugMeta.frames : '-'}</div>
            <div>tokens: {typeof streamDebugMeta.tokens === 'number' ? streamDebugMeta.tokens : '-'}</div>
          </div>

          {streamDebugOpen ? (
            <div className={styles.debugLog} ref={debugLogRef}>
              {streamDebugEvents.length === 0 ? (
                <div className={styles.debugEmpty}>尚无事件（点击“转换”后会显示 open/chunk/token/done）。</div>
              ) : (
                streamDebugEvents.map((e, idx) => (
                  <div key={`${e.at}-${idx}`} className={styles.debugRow}>
                    <div className={styles.debugTs}>{new Date(e.at).toLocaleTimeString()}</div>
                    <div className={styles.debugType}>{e.type}</div>
                    <div className={styles.debugMsg}>{e.message || ''}</div>
                  </div>
                ))
              )}
            </div>
          ) : null}

          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setAdvancedOpen((v) => !v)}
            disabled={saving}
          >
            {advancedOpen ? '收起高级设置' : '展开高级设置'}
          </button>

          {advancedOpen ? (
            <div className={styles.advanced}>
              <div className={styles.sectionTitle}>转换设置</div>

              <div className={styles.field}>
                <div className={styles.fieldLabel}>API Base URL</div>
                <input className={styles.input} value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://xxx 或 https://xxx/v1" />
              </div>

              <div className={styles.field}>
                <div className={styles.fieldLabel}>API Key</div>
                <input className={styles.input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="可留空（使用 root .env）" />
              </div>

              <div className={styles.field}>
                <div className={styles.fieldLabel}>模型</div>
                <input className={styles.input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="可留空（使用 root .env）" />
              </div>

              <div className={styles.field}>
                <div className={styles.fieldLabel}>温度（number）</div>
                <input className={styles.input} type="number" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0" />
              </div>

              <div className={styles.field}>
                <div className={styles.fieldLabel}>max_tokens（number）</div>
                <input className={styles.input} type="number" step="1" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="-1" />
              </div>

              <div className={styles.miniHint}>
                max_tokens 过小会导致内容被截断。
              </div>
            </div>
          ) : null}

          <div className={styles.sidebarActions}>
            <button type="button" className={styles.btn} onClick={() => { setFile(null); setRawText(''); setTargetName(''); setConvertedJson(null); setConvertedXml(''); }} disabled={saving}>清空</button>
            <button type="button" className={styles.btn} onClick={() => void handleConvert()} disabled={!effectiveFileName || saving || isJsonFile || !isTextPresetFile}>转换</button>
            <button type="button" className={styles.btn} onClick={handleStop} disabled={!isStreaming}>停止</button>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void handleImport()} disabled={!effectiveFileName || saving}>保存</button>
          </div>

          <div className={styles.miniHint}>
            同名自动追加 _时间戳
          </div>
        </div>

        <div className={styles.main}>
          {activePreview === 'raw' ? (
            <div className={styles.chat} ref={chatRef}>
              <div className={`${styles.msg} ${styles.msgUser}`}>
                <div className={styles.msgRole}>你</div>
                <pre className={styles.msgContent}><code>{!effectiveFileName ? '请选择文件/预设，或直接输入文本...' : preparedContent}</code></pre>
              </div>
              <div className={`${styles.msg} ${styles.msgAssistant}`}>
                <div className={styles.msgRole}>转换器</div>
                <pre className={styles.msgContent}><code>
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
  );
};
