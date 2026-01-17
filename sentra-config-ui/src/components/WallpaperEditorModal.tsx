import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './WallpaperEditorModal.module.css';

export type WallpaperEditorModalProps = {
  isOpen: boolean;
  src: string | null;
  targetAspect: number;
  targetSize?: { w: number; h: number } | null;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
};

type ImgInfo = {
  w: number;
  h: number;
};

type RangeStyle = React.CSSProperties & { ['--pct']?: string };

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export function WallpaperEditorModal({
  isOpen,
  src,
  targetAspect,
  targetSize,
  onCancel,
  onSave,
}: WallpaperEditorModalProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const [imgInfo, setImgInfo] = useState<ImgInfo | null>(null);
  const [frameSize, setFrameSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [showGrid, setShowGrid] = useState(true);
  const [jpegQuality, setJpegQuality] = useState(0.86);
  const [outputPreset, setOutputPreset] = useState<'auto' | '1280' | '1920' | '2560'>('auto');
  const [estimatedMb, setEstimatedMb] = useState<number | null>(null);

  const zoomPctStyle = useMemo(() => {
    const pct = ((zoom - 1) / (4 - 1)) * 100;
    return { ['--pct' as any]: `${clamp(pct, 0, 100)}%` } as RangeStyle;
  }, [zoom]);

  const qualityPctStyle = useMemo(() => {
    const pct = ((jpegQuality - 0.7) / (0.95 - 0.7)) * 100;
    return { ['--pct' as any]: `${clamp(pct, 0, 100)}%` } as RangeStyle;
  }, [jpegQuality]);

  const autoOutputWidth = useMemo(() => {
    const w = Math.max(1, Math.round(targetSize?.w || 0));
    if (!w) return 1920;
    if (w <= 1366) return 1280;
    if (w <= 2048) return 1920;
    return 2560;
  }, [targetSize]);

  const outputWidth = useMemo(() => {
    if (outputPreset === 'auto') return autoOutputWidth;
    return Number(outputPreset);
  }, [autoOutputWidth, outputPreset]);

  const outputHeight = useMemo(() => {
    if (!Number.isFinite(targetAspect) || targetAspect <= 0) return 1080;
    return Math.max(1, Math.round(outputWidth / targetAspect));
  }, [outputWidth, targetAspect]);

  const fitScale = useMemo(() => {
    if (!imgInfo || !frameSize.w || !frameSize.h) return 1;
    return Math.max(frameSize.w / imgInfo.w, frameSize.h / imgInfo.h);
  }, [frameSize.h, frameSize.w, imgInfo]);

  const dispScale = useMemo(() => fitScale * zoom, [fitScale, zoom]);

  const clampOffset = useCallback((next: { x: number; y: number }) => {
    if (!imgInfo || !frameSize.w || !frameSize.h) return next;

    const imgW = imgInfo.w * dispScale;
    const imgH = imgInfo.h * dispScale;
    const maxX = Math.max(0, (imgW - frameSize.w) / 2);
    const maxY = Math.max(0, (imgH - frameSize.h) / 2);

    return {
      x: clamp(next.x, -maxX, maxX),
      y: clamp(next.y, -maxY, maxY),
    };
  }, [dispScale, frameSize.h, frameSize.w, imgInfo]);

  const applyFit = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const applyCenter = useCallback(() => {
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((z) => clamp(z + 0.12, 1, 4));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => clamp(z - 0.12, 1, 4));
  }, []);

  useEffect(() => {
    if (!isOpen || !src) return;

    const img = new Image();
    img.onload = () => {
      setImgInfo({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setEstimatedMb(null);
    };
    img.src = src;
  }, [isOpen, src]);

  useEffect(() => {
    if (!isOpen) return;
    const el = frameRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      setFrameSize({ w, h });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setOffset(prev => clampOffset(prev));
  }, [clampOffset, dispScale, isOpen]);

  const frameStyle = useMemo(() => {
    const aspect = Number.isFinite(targetAspect) && targetAspect > 0 ? targetAspect : (16 / 9);
    return { aspectRatio: `${aspect}` } as React.CSSProperties;
  }, [targetAspect]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!isOpen) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st) return;

    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    const next = clampOffset({ x: st.ox + dx, y: st.oy + dy });
    setOffset(next);
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const step = Math.abs(delta) > 60 ? 0.12 : 0.06;
    setZoom((z) => clamp(z + (delta > 0 ? step : -step), 1, 4));
  };

  const renderTranslate = useMemo(() => {
    return {
      transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
    } as React.CSSProperties;
  }, [offset.x, offset.y]);

  const renderScale = useMemo(() => {
    return {
      transform: `scale(${dispScale})`,
    } as React.CSSProperties;
  }, [dispScale]);

  useEffect(() => {
    if (!isOpen || !src || !imgInfo || !frameSize.w || !frameSize.h) {
      setEstimatedMb(null);
      return;
    }

    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('load_failed'));
          img.src = src;
        });

        const sampleW = 960;
        const sampleH = Math.max(1, Math.round(sampleW / (Number.isFinite(targetAspect) && targetAspect > 0 ? targetAspect : (16 / 9))));
        const canvas = document.createElement('canvas');
        canvas.width = sampleW;
        canvas.height = sampleH;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const srcW = frameSize.w / dispScale;
        const srcH = frameSize.h / dispScale;
        const srcX = (imgInfo.w / 2) + (-frameSize.w / 2 - offset.x) / dispScale;
        const srcY = (imgInfo.h / 2) + (-frameSize.h / 2 - offset.y) / dispScale;
        const safeX = clamp(srcX, 0, Math.max(0, imgInfo.w - srcW));
        const safeY = clamp(srcY, 0, Math.max(0, imgInfo.h - srcH));

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, safeX, safeY, srcW, srcH, 0, 0, sampleW, sampleH);

        const blob: Blob | null = await new Promise((resolve) =>
          canvas.toBlob((b) => resolve(b), 'image/jpeg', jpegQuality)
        );
        if (!blob) return;

        const scale = (outputWidth * outputHeight) / (sampleW * sampleH);
        const est = (blob.size * scale) / (1024 * 1024);
        if (alive) setEstimatedMb(est);
      } catch {
        if (alive) setEstimatedMb(null);
      }
    }, 220);

    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [dispScale, frameSize.h, frameSize.w, imgInfo, isOpen, jpegQuality, offset.x, offset.y, outputHeight, outputWidth, src, targetAspect]);

  const handleSave = useCallback(async () => {
    if (!src || !imgInfo || !frameSize.w || !frameSize.h) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('load_failed'));
      img.src = src;
    });

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const srcW = frameSize.w / dispScale;
    const srcH = frameSize.h / dispScale;

    const srcX = (imgInfo.w / 2) + (-frameSize.w / 2 - offset.x) / dispScale;
    const srcY = (imgInfo.h / 2) + (-frameSize.h / 2 - offset.y) / dispScale;

    const safeX = clamp(srcX, 0, Math.max(0, imgInfo.w - srcW));
    const safeY = clamp(srcY, 0, Math.max(0, imgInfo.h - srcH));

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, safeX, safeY, srcW, srcH, 0, 0, outputWidth, outputHeight);

    const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
    onSave(dataUrl);
  }, [dispScale, frameSize.h, frameSize.w, imgInfo, jpegQuality, offset.x, offset.y, onSave, outputHeight, outputWidth, src]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave();
      if (e.key === '+' || e.key === '=') zoomIn();
      if (e.key === '-') zoomOut();
      if (e.key === '0') applyFit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyFit, handleSave, isOpen, onCancel, zoomIn, zoomOut]);

  if (!isOpen || !src) return null;

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.title}>壁纸编辑</div>
          <div className={styles.headerMeta}>
            {imgInfo ? `${imgInfo.w}×${imgInfo.h}` : ''}
          </div>
        </div>

        <div className={styles.body}>
          <div className={styles.previewPane}>
            <div className={styles.previewFrame} style={frameStyle} ref={frameRef}>
              <div className={styles.previewToolbar}>
                <button className={styles.toolBtn} onClick={zoomOut} aria-label="zoom-out">−</button>
                <button className={styles.toolBtn} onClick={zoomIn} aria-label="zoom-in">＋</button>
                <div className={styles.toolDivider} />
                <button className={styles.toolBtn} onClick={applyCenter}>居中</button>
                <button className={styles.toolBtn} onClick={applyFit}>适配</button>
                <div className={styles.toolDivider} />
                <button className={styles.toolBtn} onClick={() => setShowGrid(v => !v)}>
                  {showGrid ? '网格开' : '网格关'}
                </button>
              </div>

              <div
                className={styles.dragLayer}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onWheel={handleWheel}
              >
                <div className={styles.imgTranslate} style={renderTranslate}>
                  <img
                    className={styles.img}
                    alt="wallpaper"
                    src={src}
                    draggable={false}
                    style={renderScale}
                  />
                </div>
              </div>

              <div className={styles.frameBorder} />
              {showGrid && <div className={styles.gridOverlay} />}
            </div>

            <div className={styles.previewFooter}>
              <div className={styles.previewHint}>拖拽移动，滚轮缩放。快捷键：0 适配，+/- 缩放，Ctrl/⌘+Enter 保存。</div>
            </div>
          </div>

          <div className={styles.inspector}>
            <div className={styles.group}>
              <div className={styles.groupTitle}>取景</div>
              <div className={styles.row}>
                <div className={styles.label}>缩放</div>
                <input
                  className={styles.slider}
                  style={zoomPctStyle}
                  type="range"
                  min={1}
                  max={4}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </div>
              <div className={styles.metaRow}>
                <div className={styles.muted}>{Math.round(zoom * 100)}%</div>
                <div className={styles.muted}>x: {Math.round(offset.x)}  y: {Math.round(offset.y)}</div>
              </div>
            </div>

            <div className={styles.group}>
              <div className={styles.groupTitle}>输出</div>
              <div className={styles.row}>
                <div className={styles.label}>分辨率</div>
                <select
                  className={styles.select}
                  value={outputPreset}
                  onChange={(e) => setOutputPreset(e.target.value as any)}
                >
                  <option value="auto">自动（推荐）</option>
                  <option value="1280">1280</option>
                  <option value="1920">1920</option>
                  <option value="2560">2560</option>
                </select>
              </div>
              <div className={styles.metaRow}>
                <div className={styles.muted}>{outputWidth}×{outputHeight}</div>
                <div className={styles.muted}>{estimatedMb != null ? `预计 ~${estimatedMb.toFixed(1)} MB` : '预计大小…'}</div>
              </div>

              <div className={styles.row}>
                <div className={styles.label}>质量</div>
                <input
                  className={styles.slider}
                  style={qualityPctStyle}
                  type="range"
                  min={0.7}
                  max={0.95}
                  step={0.01}
                  value={jpegQuality}
                  onChange={(e) => setJpegQuality(Number(e.target.value))}
                />
              </div>
              <div className={styles.metaRow}>
                <div className={styles.muted}>{Math.round(jpegQuality * 100)}%</div>
                <div className={styles.muted}>JPEG</div>
              </div>
            </div>

            <div className={styles.group}>
              <div className={styles.groupTitle}>操作</div>
              <div className={styles.actions}>
                <button className={styles.btn} onClick={applyFit}>一键适配屏幕</button>
                <button className={styles.btn} onClick={applyCenter}>居中</button>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.btnGhost} onClick={onCancel}>取消</button>
          <button className={styles.btnPrimary} onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  );
}
