import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { IoCloseOutline, IoRemoveOutline, IoSquareOutline, IoCopyOutline } from 'react-icons/io5';
import styles from './MacWindow.module.css';

interface MacWindowProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  initialPos?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  initialMaximized?: boolean;
  safeArea?: { top?: number; bottom?: number; left?: number; right?: number };
  zIndex: number;
  isActive: boolean;
  isMinimized: boolean;
  performanceMode?: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: (isMaximized: boolean) => void;
  onFocus: () => void;
  onMove: (x: number, y: number) => void;
  children: React.ReactNode;
}

export const MacWindow: React.FC<MacWindowProps> = ({
  title,
  icon,
  initialPos,
  initialSize = { width: 800, height: 500 },
  initialMaximized = false,
  safeArea,
  zIndex,
  isActive,
  isMinimized,
  performanceMode = false,
  onClose,
  onMinimize,
  onMaximize,
  onFocus,
  onMove,
  children
}) => {
  const [isMaximized, setIsMaximized] = useState(!!initialMaximized);
  const [isDragging, setIsDragging] = useState(false);
  const [size, setSize] = useState(initialSize);
  const nodeRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const lastResizeRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const safeTop = safeArea?.top ?? 30;
  const safeBottom = safeArea?.bottom ?? 120;
  const safeLeft = safeArea?.left ?? 0;
  const safeRight = safeArea?.right ?? 0;

  // Initialize position from props or calculate center immediately to avoid flash/wrong position
  const [defaultPos] = useState(() => {
    if (initialPos) return initialPos;
    const width = initialSize?.width || 800;
    const height = initialSize?.height || 500;
    return {
      x: Math.max(safeLeft, (window.innerWidth - width) / 2),
      y: Math.max(safeTop, (window.innerHeight - height) / 2)
    };
  });

  useEffect(() => {
    // If no initial position was provided, sync the calculated default position to parent
    if (!initialPos) {
      const next = clampPosition(defaultPos.x, defaultPos.y);
      onMove(next.x, next.y);
    }
    const base = initialPos || defaultPos;
    setPos(clampPosition(base.x, base.y));
  }, []);

  useEffect(() => {
    if (initialMaximized) {
      onMaximize(true);
    }
  }, [initialMaximized, onMaximize]);

  useEffect(() => {
    if (!pos) return;

    const minW = 360;
    const minH = 240;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const maxRight = viewportW - safeRight;
    const maxBottom = viewportH - safeBottom;

    let nextW = typeof size.width === 'number' ? size.width : 800;
    let nextH = typeof size.height === 'number' ? size.height : 500;
    let nextX = pos.x;
    let nextY = pos.y;

    if (nextX < safeLeft) nextX = safeLeft;
    if (nextY < safeTop) nextY = safeTop;

    if (nextX + nextW > maxRight) {
      nextW = Math.max(minW, maxRight - nextX);
    }
    if (nextY + nextH > maxBottom) {
      nextH = Math.max(minH, maxBottom - nextY);
    }

    const maxAllowedW = Math.max(minW, maxRight - nextX);
    if (nextW > maxAllowedW) nextW = maxAllowedW;

    const maxAllowedH = Math.max(minH, maxBottom - nextY);
    if (nextH > maxAllowedH) nextH = maxAllowedH;

    const clampedPos = clampPosition(nextX, nextY);
    const posChanged = clampedPos.x !== pos.x || clampedPos.y !== pos.y;
    if (posChanged) setPos(clampedPos);

    const sizeChanged = nextW !== size.width || nextH !== size.height;
    if (sizeChanged) setSize({ width: nextW, height: nextH });
  }, [safeTop, safeBottom, safeLeft, safeRight]);

  const applyDragTransform = (next: { x: number; y: number }) => {
    if (!nodeRef.current) return;
    nodeRef.current.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
  };

  const handleDragStart = (e: React.PointerEvent) => {
    if (isMaximized) return;
    const target = e.target as HTMLElement | null;
    if (target && target.closest('.window-controls')) return;
    onFocus();
    e.preventDefault();

    setIsDragging(true);

    const startPos = pos || defaultPos;
    const startX = e.clientX;
    const startY = e.clientY;

    let last: { x: number; y: number } = startPos;

    const handleMove = (evt: PointerEvent) => {
      const next = clampPosition(startPos.x + (evt.clientX - startX), startPos.y + (evt.clientY - startY));
      last = next;
      if (dragRafRef.current != null) return;
      dragRafRef.current = window.requestAnimationFrame(() => {
        dragRafRef.current = null;
        applyDragTransform(last);
      });
    };

    const handleEnd = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      if (dragRafRef.current != null) {
        window.cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      setIsDragging(false);
      setPos(last);
      onMove(last.x, last.y);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
  };

  const handleMaximizeToggle = () => {
    setIsMaximized(prev => {
      const next = !prev;
      onMaximize(next);
      return next;
    });
  };

  // Animation variants
  const variants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
    exit: { opacity: 0 }
  };

  const resizingRef = useRef<{
    dir: Dir;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startPos: { x: number; y: number };
  } | null>(null);

  const onResizeMove = (evt: MouseEvent | TouchEvent) => {
    const st = resizingRef.current;
    if (!st) return;
    const p = getPoint(evt);
    const dx = p.x - st.startX;
    const dy = p.y - st.startY;

    const minW = 360;
    const minH = 240;

    let newW = st.startW;
    let newH = st.startH;
    let newX = st.startPos.x;
    let newY = st.startPos.y;

    if (st.dir.includes('e')) newW = Math.max(minW, st.startW + dx);
    if (st.dir.includes('s')) newH = Math.max(minH, st.startH + dy);
    if (st.dir.includes('w')) {
      const rawX = st.startPos.x + dx;
      newX = Math.max(safeLeft, rawX);
      const moved = newX - st.startPos.x; // clamped dx
      newW = Math.max(minW, st.startW - moved);
    }
    if (st.dir.includes('n')) {
      const rawY = st.startPos.y + dy;
      newY = Math.max(safeTop, rawY);
      const movedY = newY - st.startPos.y;
      newH = Math.max(minH, st.startH - movedY);
    }

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const maxRight = viewportW - safeRight;
    const maxBottom = viewportH - safeBottom;

    if (newX < safeLeft) {
      newX = safeLeft;
    }
    if (newY < safeTop) {
      newY = safeTop;
    }

    if (newX + newW > maxRight) {
      newW = Math.max(minW, maxRight - newX);
    }

    if (newY + newH > maxBottom) {
      newH = Math.max(minH, maxBottom - newY);
    }

    const maxAllowedW = Math.max(minW, maxRight - newX);
    if (newW > maxAllowedW) {
      newW = maxAllowedW;
    }

    const maxAllowedH = Math.max(minH, maxBottom - newY);
    if (newH > maxAllowedH) {
      newH = maxAllowedH;
    }

    lastResizeRef.current = { x: newX, y: newY, width: newW, height: newH };

    if (resizeRafRef.current != null) return;
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const last = lastResizeRef.current;
      const node = nodeRef.current;
      if (!last || !node) return;
      node.style.width = `${last.width}px`;
      node.style.height = `${last.height}px`;
      node.style.transform = `translate3d(${last.x}px, ${last.y}px, 0)`;
    });
  };

  const clampPosition = (x: number, y: number) => {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const w = typeof size.width === 'number' ? size.width : 800;
    const h = typeof size.height === 'number' ? size.height : 500;
    const minX = safeLeft;
    const maxX = Math.max(minX, viewportW - w - safeRight);
    const minY = safeTop;
    const maxY = Math.max(minY, viewportH - h - safeBottom);
    const clampedX = Math.min(Math.max(x, minX), maxX);
    const clampedY = Math.min(Math.max(y, minY), maxY);
    return { x: clampedX, y: clampedY };
  };

  const onResizeEnd = () => {
    if (resizingRef.current) {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onResizeMove as any);
      window.removeEventListener('mouseup', onResizeEnd);
      window.removeEventListener('touchmove', onResizeMove as any);
      window.removeEventListener('touchend', onResizeEnd);

      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }

      const last = lastResizeRef.current;
      if (last) {
        setPos({ x: last.x, y: last.y });
        setSize({ width: last.width, height: last.height });
        onMove(last.x, last.y);
      } else if (pos) {
        onMove(pos.x, pos.y);
      }
    }
  };

  const startResize = (dir: Dir, e: React.MouseEvent | React.TouchEvent) => {
    if (isMaximized) return;
    e.preventDefault();
    e.stopPropagation();
    const base = pos || defaultPos;
    const point = 'nativeEvent' in e ? (e as any).nativeEvent : e;
    const p = getPoint(point as MouseEvent | TouchEvent);
    resizingRef.current = {
      dir,
      startX: p.x,
      startY: p.y,
      startW: typeof size.width === 'number' ? size.width : 800,
      startH: typeof size.height === 'number' ? size.height : 500,
      startPos: base,
    };
    window.addEventListener('mousemove', onResizeMove as any);
    window.addEventListener('mouseup', onResizeEnd);
    window.addEventListener('touchmove', onResizeMove as any, { passive: false } as any);
    window.addEventListener('touchend', onResizeEnd);
  };

  const windowContent = (
    <motion.div
      ref={nodeRef}
      className={`${styles.window} ${isActive ? styles.active : ''} ${isMaximized ? styles.maximized : ''} ${performanceMode ? styles.performance : ''} ${isDragging ? styles.dragging : ''}`}
      style={{
        width: isMaximized ? `calc(100vw - ${safeLeft + safeRight}px)` : size.width,
        height: isMaximized ? `calc(100vh - ${safeTop + safeBottom}px)` : size.height,
        zIndex: Math.min(zIndex, 9949),
        position: isMaximized ? 'fixed' : 'absolute',
        top: isMaximized ? safeTop : 0,
        left: isMaximized ? safeLeft : 0,
        transform: isMaximized ? 'none' : `translate3d(${(pos || defaultPos).x}px, ${(pos || defaultPos).y}px, 0)`,
        borderRadius: isMaximized ? 0 : 8,
        resize: 'none',
      }}
      onPointerDownCapture={onFocus}
      initial="hidden"
      animate="visible"
      exit="exit"
      variants={variants}
      transition={{ duration: performanceMode ? 0 : 0.12 }}
    >
      <div
        className={`${styles.titleBar} window-drag-handle`}
        onDoubleClick={handleMaximizeToggle}
        onPointerDown={handleDragStart}
      >
        <div className={styles.title}>
          {icon && <span className={styles.titleIcon}>{icon}</span>}
          {title}
        </div>
        <div className={`${styles.controls} window-controls`}>
          <button className={`${styles.btn} ${styles.minimize}`} onClick={(e) => { e.stopPropagation(); onMinimize(); }}>
            <IoRemoveOutline />
          </button>
          <button className={`${styles.btn} ${styles.maximize}`} onClick={(e) => { e.stopPropagation(); handleMaximizeToggle(); }}>
            {isMaximized ? <IoCopyOutline size={12} /> : <IoSquareOutline size={12} />}
          </button>
          <button className={`${styles.btn} ${styles.close}`} onClick={(e) => { e.stopPropagation(); onClose(); }}>
            <IoCloseOutline size={18} />
          </button>
        </div>
      </div>
      <div className={styles.content}>
        {children}
      </div>

      {/* Resize Handles */}
      {!isMaximized && (
        <>
          <div className={`${styles.resizeHandle} ${styles.n}`} onMouseDown={(e) => startResize('n', e)} onTouchStart={(e) => startResize('n', e)} />
          <div className={`${styles.resizeHandle} ${styles.s}`} onMouseDown={(e) => startResize('s', e)} onTouchStart={(e) => startResize('s', e)} />
          <div className={`${styles.resizeHandle} ${styles.e}`} onMouseDown={(e) => startResize('e', e)} onTouchStart={(e) => startResize('e', e)} />
          <div className={`${styles.resizeHandle} ${styles.w}`} onMouseDown={(e) => startResize('w', e)} onTouchStart={(e) => startResize('w', e)} />
          <div className={`${styles.resizeHandle} ${styles.ne}`} onMouseDown={(e) => startResize('ne', e)} onTouchStart={(e) => startResize('ne', e)} />
          <div className={`${styles.resizeHandle} ${styles.nw}`} onMouseDown={(e) => startResize('nw', e)} onTouchStart={(e) => startResize('nw', e)} />
          <div className={`${styles.resizeHandle} ${styles.se}`} onMouseDown={(e) => startResize('se', e)} onTouchStart={(e) => startResize('se', e)} />
          <div className={`${styles.resizeHandle} ${styles.sw}`} onMouseDown={(e) => startResize('sw', e)} onTouchStart={(e) => startResize('sw', e)} />
        </>
      )}
    </motion.div>
  );

  if (isMinimized) return null;

  return windowContent;
};

// Resizing logic
type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

function getPoint(evt: MouseEvent | TouchEvent) {
  if ((evt as TouchEvent).touches && (evt as TouchEvent).touches.length) {
    const t = (evt as TouchEvent).touches[0];
    return { x: t.clientX, y: t.clientY };
  }
  const m = evt as MouseEvent;
  return { x: m.clientX, y: m.clientY };
}