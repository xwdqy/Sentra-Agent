import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PresetsEditorState } from '../hooks/usePresetsEditor';
import { convertPresetText, convertPresetTextStream, fetchPresetFile, savePresetFile } from '../services/api';

type ToastFn = (type: 'success' | 'error', title: string, message?: string) => void;

function splitFileName(name: string) {
  const safe = String(name || '').replace(/[/\\]/g, '_');
  const dot = safe.lastIndexOf('.');
  if (dot <= 0 || dot === safe.length - 1) {
    return { base: safe, ext: '' };
  }
  return { base: safe.slice(0, dot), ext: safe.slice(dot) };
}

function normalizeJsonPreset(obj: any, fileBaseName: string) {
  const safeName = fileBaseName || 'AgentPreset';
  const base = obj && typeof obj === 'object' ? { ...obj } : {};

  if (!base.meta || typeof base.meta !== 'object') base.meta = {};
  const meta = base.meta as any;

  if (!meta.node_name) meta.node_name = safeName;
  if (!meta.category) meta.category = 'agent_preset';
  if (!meta.description) meta.description = 'Agent preset imported from JSON';

  if (!base.parameters || typeof base.parameters !== 'object' || Array.isArray(base.parameters)) {
    base.parameters = {};
  }

  if (!Array.isArray(base.rules)) {
    if (base.rules && typeof base.rules === 'object') base.rules = [base.rules];
    else base.rules = [];
  }

  return base;
}

export interface IOSPresetImporterProps {
  onClose: () => void;
  addToast: ToastFn;
  state: PresetsEditorState;
  theme: 'light' | 'dark';
}

export const IOSPresetImporter: React.FC<IOSPresetImporterProps> = ({ onClose, addToast, state, theme }) => {
  const [sourceMode, setSourceMode] = useState<'upload' | 'presets' | 'text'>(() => {
    const v = localStorage.getItem('preset_importer.sourceMode') as any;
    return v === 'presets' || v === 'text' || v === 'upload' ? v : 'upload';
  });
  const [file, setFile] = useState<File | null>(null);
  const [inputFileName, setInputFileName] = useState<string>(() => localStorage.getItem('preset_importer.inputFileName') || 'pasted.txt');
  const [selectedPresetPath, setSelectedPresetPath] = useState<string>('');
  const [rawText, setRawText] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [convertedJson, setConvertedJson] = useState<any | null>(null);
  const [convertedXml, setConvertedXml] = useState<string>('');

  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => (localStorage.getItem('preset_importer.streamEnabled') || 'true') !== 'false');
  const [streamText, setStreamText] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamTextRef = useRef<string>('');
  const flushRafRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => localStorage.getItem('preset_importer.apiBaseUrl') || '');
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('preset_importer.apiKey') || '');
  const [model, setModel] = useState<string>(() => localStorage.getItem('preset_importer.model') || '');
  const [temperature, setTemperature] = useState<string>(() => localStorage.getItem('preset_importer.temperature') || '0');
  const [maxTokens, setMaxTokens] = useState<string>(() => localStorage.getItem('preset_importer.maxTokens') || '8192');

  const effectiveFileName = useMemo(() => {
    if (sourceMode === 'upload') return file?.name || '';
    if (sourceMode === 'presets') return inputFileName || '';
    return inputFileName || '';
  }, [file, inputFileName, sourceMode]);

  useEffect(() => {
    localStorage.setItem('preset_importer.sourceMode', sourceMode);
  }, [sourceMode]);

  useEffect(() => {
    localStorage.setItem('preset_importer.inputFileName', inputFileName);
  }, [inputFileName]);

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

  const existingNames = useMemo(() => {
    const set = new Set<string>();
    for (const f of state.files || []) {
      if (f && typeof f.path === 'string' && !f.path.includes('/')) set.add(f.path);
      if (f && typeof f.name === 'string') set.add(f.name);
    }
    return set;
  }, [state.files]);

  const inferredName = useMemo(() => {
    if (!effectiveFileName) return '';
    const safe = effectiveFileName || 'preset.txt';
    const { base, ext } = splitFileName(safe);
    const name = `${base}${ext || '.txt'}`;
    if (!existingNames.has(name)) return name;
    return `${base}_${Date.now()}${ext || '.txt'}`;
  }, [effectiveFileName, existingNames]);

  const inferredJsonName = useMemo(() => {
    if (!effectiveFileName) return '';
    const base = splitFileName(effectiveFileName || 'preset').base || 'preset';
    const name = `${base}.json`;
    if (!existingNames.has(name)) return name;
    return `${base}_${Date.now()}.json`;
  }, [effectiveFileName, existingNames]);

  const preparedContent = useMemo(() => {
    if (!effectiveFileName) return '';
    const lower = String(effectiveFileName || '').toLowerCase();
    const txt = String(rawText || '');

    if (lower.endsWith('.json')) {
      try {
        const obj = JSON.parse(txt.trim());
        const baseName = splitFileName(effectiveFileName).base;
        const normalized = normalizeJsonPreset(obj, baseName);
        return JSON.stringify(normalized, null, 2);
      } catch {
        return txt;
      }
    }

    return txt;
  }, [effectiveFileName, rawText]);

  const handlePick = useCallback(async (f: File | null) => {
    setFile(f);
    setRawText('');
    setConvertedJson(null);
    setConvertedXml('');
    setStreamText('');
    streamTextRef.current = '';
    setIsStreaming(false);
    if (!f) return;
    try {
      setRawText(await f.text());
      setInputFileName(f.name || 'preset.txt');
      setSourceMode('upload');
    } catch (e: any) {
      addToast('error', '读取失败', e?.message || String(e));
    }
  }, [addToast]);

  const openFilePicker = useCallback(() => {
    if (saving) return;
    const el = fileInputRef.current;
    if (!el) return;
    try { el.value = ''; } catch { }
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

  const isJsonFile = useMemo(() => {
    return !!effectiveFileName && String(effectiveFileName || '').toLowerCase().endsWith('.json');
  }, [effectiveFileName]);

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
      const temperatureNum = Number.isFinite(tempNum) ? tempNum : 0;
      const maxTokensNum = Number(maxTokens);
      const maxTokensValue = Number.isFinite(maxTokensNum) && maxTokensNum > 0 ? maxTokensNum : undefined;

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

      if (streamEnabled) {
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
        });

        abortRef.current = null;
        setIsStreaming(false);
        setStreamText(streamTextRef.current);
        setConvertedJson(result.presetJson || null);
        setConvertedXml(result.presetXml || '');
        addToast('success', '转换成功', '已生成结构化预设，可保存为 .json');
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
      addToast('success', '转换成功', '已生成结构化预设，可保存为 .json');
    } catch (e: any) {
      if (String(e?.name || '') === 'AbortError') {
        addToast('error', '已停止', '已中止流式转换');
      } else {
        addToast('error', '转换失败', e?.message || String(e));
      }
    } finally {
      setSaving(false);
      setIsStreaming(false);
    }
  }, [addToast, apiBaseUrl, apiKey, effectiveFileName, maxTokens, model, rawText, streamEnabled, temperature]);

  const handleStop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    try { controller.abort(); } catch { }
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const handleImport = useCallback(async () => {
    if (!effectiveFileName) {
      addToast('error', '导入失败', '请先选择文件或填写文件名');
      return;
    }
    try {
      setSaving(true);
      const lower = String(effectiveFileName || '').toLowerCase();

      if (!lower.endsWith('.json')) {
        if (!convertedJson) {
          addToast('error', '请先转换', 'txt/md 预设需要先转换为结构化预设，然后再保存。');
          return;
        }
        await savePresetFile(inferredJsonName, JSON.stringify(convertedJson, null, 2));
        addToast('success', '导入成功', `已保存到 agent-presets/${inferredJsonName}`);
      } else {
        const content = preparedContent;
        if (!content.trim()) {
          addToast('error', '导入失败', '文件内容为空');
          return;
        }
        await savePresetFile(inferredName, content);
        addToast('success', '导入成功', `已保存到 agent-presets/${inferredName}`);
      }

      await state.refreshFiles();
      onClose();
    } catch (e: any) {
      addToast('error', '导入失败', e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [addToast, convertedJson, effectiveFileName, inferredJsonName, inferredName, onClose, preparedContent, state]);

  return (
    <div
      className="ios-app-window"
      style={{
        display: 'flex',
        background: theme === 'dark' ? '#0B0B0D' : '#FFFFFF',
        color: theme === 'dark' ? '#F5F5F6' : '#0B0B0D',
      }}
    >
      <div className="ios-app-header">
        <div className="ios-back-btn" onClick={onClose}>返回</div>
        <div>预设导入</div>
        <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={onClose}>关闭</div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <button className="ios-primary-btn" type="button" onClick={() => setSourceMode('upload')} disabled={saving} style={{ opacity: sourceMode === 'upload' ? 1 : 0.72 }}>上传</button>
          <button className="ios-primary-btn" type="button" onClick={() => { setSourceMode('presets'); void state.refreshFiles(); }} disabled={saving} style={{ opacity: sourceMode === 'presets' ? 1 : 0.72 }}>预设库</button>
          <button className="ios-primary-btn" type="button" onClick={() => setSourceMode('text')} disabled={saving} style={{ opacity: sourceMode === 'text' ? 1 : 0.72 }}>文本</button>
        </div>

        {sourceMode === 'upload' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.json,.yaml,.yml,.toml,.ini,.conf,.prompt,.preset,.text"
              onChange={(e) => void handlePick(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
            />
            <button className="ios-primary-btn" type="button" onClick={openFilePicker} disabled={saving}>选择文件</button>
          </div>
        ) : null}

        {sourceMode === 'presets' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>从预设文件夹选择</div>
            <select value={selectedPresetPath} onChange={(e) => void handlePickPreset(e.target.value)} disabled={saving} style={{ padding: 10, borderRadius: 12 }}>
              <option value="">请选择...</option>
              {presetOptions.map((o) => (
                <option key={o.path} value={o.path}>{o.label}</option>
              ))}
            </select>
          </div>
        ) : null}

        {sourceMode !== 'upload' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>文件名（用于识别类型）</div>
            <input value={inputFileName} onChange={(e) => setInputFileName(e.target.value)} placeholder="例如: preset.txt / preset.json" style={{ padding: 10, borderRadius: 12 }} />
          </div>
        ) : null}

        {sourceMode === 'text' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>输入/粘贴文本</div>
            <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} placeholder="直接粘贴预设文本..." style={{ minHeight: 140, padding: 10, borderRadius: 12, resize: 'vertical' }} />
          </div>
        ) : null}

        <div style={{ fontSize: 12, opacity: 0.82 }}>保存位置：agent-presets/；同名自动追加 _时间戳</div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 10, borderRadius: 14, background: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(11,11,13,0.04)' }}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>流式输出</div>
          <input type="checkbox" checked={streamEnabled} onChange={(e) => setStreamEnabled(e.target.checked)} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="text" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="API Base URL(可选)" style={{ padding: 10, borderRadius: 12 }} />
          <input type="text" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key(可选)" style={{ padding: 10, borderRadius: 12 }} />
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型(可选)" style={{ padding: 10, borderRadius: 12 }} />
          <input type="number" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="温度(默认0)" style={{ padding: 10, borderRadius: 12 }} />
          <input type="number" step="1" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="max_tokens(默认8192)" style={{ padding: 10, borderRadius: 12 }} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', background: theme === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(11,11,13,0.03)', borderRadius: 14, padding: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {!effectiveFileName ? '请选择文件/预设，或直接输入文本...' : (
            isJsonFile ? preparedContent : (streamText || convertedXml || '点击“转换”开始生成（支持流式/非流式）。')
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <button className="ios-primary-btn" type="button" onClick={() => void handleConvert()} disabled={!effectiveFileName || saving || isJsonFile}>转换</button>
          <button className="ios-primary-btn" type="button" onClick={handleStop} disabled={!isStreaming}>停止</button>
          <button className="ios-primary-btn" type="button" onClick={() => void handleImport()} disabled={!effectiveFileName || saving}>保存</button>
        </div>
      </div>
    </div>
  );
};
