import React, { useState, useRef, useEffect } from 'react';
import Draggable from 'react-draggable';
import { motion } from 'framer-motion';
import { IoCloseOutline, IoRemoveOutline, IoSquareOutline, IoCopyOutline } from 'react-icons/io5';
import styles from './MacWindow.module.css';

interface MacWindowProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  initialPos?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  zIndex: number;
  isActive: boolean;
  isMinimized: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onFocus: () => void;
  onMove: (x: number, y: number) => void;
  children: React.ReactNode;
}

export const MacWindow: React.FC<MacWindowProps> = ({
  title,
  icon,
  initialPos,
  initialSize = { width: 800, height: 500 },
  zIndex,
  isActive,
  isMinimized,
  onClose,
  onMinimize,
  onFocus,
  onMove,
  children
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [size, setSize] = useState(initialSize);
  const nodeRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Initialize position from props or calculate center immediately to avoid flash/wrong position
  const [defaultPos] = useState(() => {
    if (initialPos) return initialPos;
    const width = initialSize?.width || 800;
    const height = initialSize?.height || 500;
    return {
      x: Math.max(0, (window.innerWidth - width) / 2),
      y: Math.max(40, (window.innerHeight - height) / 2)
    };
  });

  useEffect(() => {
    // If no initial position was provided, sync the calculated default position to parent
    if (!initialPos) {
      onMove(defaultPos.x, defaultPos.y);
    }
    setPos(initialPos || defaultPos);
  }, []);

  const handleMaximizeToggle = () => {
    setIsMaximized(!isMaximized);
    // Don't call onMaximize prop as it might be for something else, we handle state locally
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
      newX = Math.max(0, rawX);
      const moved = newX - st.startPos.x; // clamped dx
      newW = Math.max(minW, st.startW - moved);
    }
    if (st.dir.includes('n')) {
      const rawY = st.startPos.y + dy;
      newY = Math.max(0, rawY);
      const movedY = newY - st.startPos.y;
      newH = Math.max(minH, st.startH - movedY);
    }

    // Prevent overflow on the right/bottom relative to viewport
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight - 0; // menu bar accounted by y origin
    if (newX + newW > viewportW) newW = Math.max(minW, viewportW - newX);
    if (newY + newH > viewportH) newH = Math.max(minH, viewportH - newY);

    setPos({ x: newX, y: newY });
    setSize({ width: newW, height: newH });
  };

  const onResizeEnd = () => {
    if (resizingRef.current) {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onResizeMove as any);
      window.removeEventListener('mouseup', onResizeEnd);
      window.removeEventListener('touchmove', onResizeMove as any);
      window.removeEventListener('touchend', onResizeEnd);
      if (pos) onMove(pos.x, pos.y);
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
      className={`${styles.window} ${isActive ? styles.active : ''}`}
      style={{
        width: isMaximized ? '100vw' : size.width,
        height: isMaximized ? 'calc(100vh - 30px)' : size.height,
        zIndex: isMaximized ? 10000 : zIndex, // Higher than TopTaskbar (9000) when maximized
        position: isMaximized ? 'fixed' : 'absolute',
        top: isMaximized ? 30 : 0,
        left: isMaximized ? 0 : 0,
        borderRadius: isMaximized ? 0 : 8,
        resize: 'none',
      }}
      onMouseDown={onFocus}
      initial="hidden"
      animate="visible"
      exit="exit"
      variants={variants}
      transition={{ duration: 0.2 }}
    >
      <div className={`${styles.titleBar} window-drag-handle`} onDoubleClick={handleMaximizeToggle}>
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

  // Always render Draggable to preserve component tree, but disable it when maximized
  // When maximized, we want the window to be at 0,0 (relative to viewport, but Draggable uses transform).
  // If we disable Draggable, it renders the child.
  // But we need to ensure the child is positioned correctly.
  // If we use position={isMaximized ? {x:0, y:0} : pos}, Draggable will apply that transform.
  // But when maximized, we want it fixed?
  // Actually, if we set position to {0,0} and disable dragging, it will be at the top-left of the container?
  // Our container is the desktop (relative).
  // So {x:0, y:0} works if we want it at top-left.

  return (
    <Draggable
      handle=".window-drag-handle"
      position={isMaximized ? { x: 0, y: 0 } : (pos || defaultPos)}
      onStart={onFocus}
      onDrag={(_e, data) => setPos({ x: data.x, y: data.y })}
      onStop={(_e, data) => {
        if (!isMaximized) {
          setPos({ x: data.x, y: data.y });
          onMove(data.x, data.y);
        }
      }}
      nodeRef={nodeRef}
      bounds="parent"
      disabled={isMaximized}
    >
      {windowContent}
    </Draggable>
  );
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