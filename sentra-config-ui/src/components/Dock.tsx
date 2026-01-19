import React, { memo, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, useMotionValue, useSpring, useTransform, MotionValue } from 'framer-motion';
import { Menu, Item, useContextMenu } from 'react-contexify';
import 'react-contexify/dist/ReactContexify.css';
import styles from './Dock.module.css';

const DOCK_MENU_ID = 'sentra-dock-menu';

interface DockItem {
  id: string;
  name: string;
  icon: React.ReactNode;
  isOpen?: boolean;
  onClick: () => void;
  onHover?: () => void;
  onRemove?: () => void;
  onClose?: () => void;
}

interface DockProps {
  items: DockItem[];
  performanceMode?: boolean;
}

export const Dock: React.FC<DockProps> = ({ items, performanceMode = false }) => {
  const mouseX = useMotionValue<number>(Infinity);

  const activeItemRef = useRef<DockItem | null>(null);
  const { show } = useContextMenu({ id: DOCK_MENU_ID });

  const handleRequestContextMenu = useCallback((e: React.MouseEvent, item: DockItem) => {
    e.preventDefault();
    e.stopPropagation();
    activeItemRef.current = item;
    show({ event: e });
  }, [show]);

  const handleMenuOpen = useCallback(() => {
    activeItemRef.current?.onClick();
  }, []);

  const handleMenuClose = useCallback(() => {
    activeItemRef.current?.onClose?.();
  }, []);

  const handleMenuRemove = useCallback(() => {
    activeItemRef.current?.onRemove?.();
  }, []);

  return (
    <div className={styles.dockContainer}>
      {performanceMode ? (
        <div className={`${styles.dock} ${styles.performanceMode}`}>
          {items.map((item) => (
            <DockIcon
              key={item.id}
              mouseX={mouseX}
              item={item}
              performanceMode={true}
              onRequestContextMenu={handleRequestContextMenu}
            />
          ))}
        </div>
      ) : (
        <motion.div
          className={styles.dock}
          onMouseMove={(e) => mouseX.set(e.clientX)}
          onMouseLeave={() => mouseX.set(Infinity)}
        >
          {items.map((item) => (
            <DockIcon
              key={item.id}
              mouseX={mouseX}
              item={item}
              performanceMode={false}
              onRequestContextMenu={handleRequestContextMenu}
            />
          ))}
        </motion.div>
      )}

      {createPortal(
        <Menu id={DOCK_MENU_ID} theme="light" animation="scale">
          <Item onClick={handleMenuOpen}>打开</Item>
          <Item onClick={handleMenuClose}>退出</Item>
          <Item onClick={handleMenuRemove}>从 Dock 中移除</Item>
          <Item disabled>选项...</Item>
        </Menu>,
        document.body
      )}
    </div>
  );
};

const DockIcon = memo(function DockIcon({
  mouseX,
  item,
  performanceMode,
  onRequestContextMenu,
}: {
  mouseX: MotionValue<number>;
  item: DockItem;
  performanceMode: boolean;
  onRequestContextMenu: (e: React.MouseEvent, item: DockItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const centerX = useMotionValue<number>(0);

  useEffect(() => {
    const updateCenter = () => {
      const bounds = ref.current?.getBoundingClientRect();
      if (!bounds) return;
      centerX.set(bounds.left + bounds.width / 2);
    };

    updateCenter();

    const ro = new ResizeObserver(() => updateCenter());
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', updateCenter);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateCenter);
    };
  }, [centerX]);

  const distance = useTransform([mouseX, centerX], (latest) => {
    const [mx, cx] = latest as [number, number];
    return mx - cx;
  });

  const widthSync = useTransform(distance, [-150, 0, 150], [50, 100, 50]);
  const width = useSpring(widthSync, { mass: 0.1, stiffness: 150, damping: 12 });

  const handleContextMenu = (e: React.MouseEvent) => onRequestContextMenu(e, item);
  const handleHover = useCallback(() => {
    try {
      item.onHover?.();
    } catch {
      // ignore
    }
  }, [item]);

  return (
    <>
      {performanceMode ? (
        <div
          ref={ref}
          style={{ width: 50 }}
          className={`${styles.dockItem} ${styles.performanceItem}`}
          onClick={item.onClick}
          onMouseEnter={handleHover}
          onFocus={handleHover}
          onContextMenu={handleContextMenu}
        >
          <div className={styles.tooltip}>{item.name}</div>
          <div className={styles.iconWrapper} style={{ width: 50, height: 50 }}>
            <div className={styles.iconContent} style={{ fontSize: '2.5em' }}>
              {item.icon}
            </div>
          </div>
          {item.isOpen && <div className={styles.dot} />}
        </div>
      ) : (
        <motion.div
          ref={ref}
          style={{ width }}
          className={styles.dockItem}
          onClick={item.onClick}
          onMouseEnter={handleHover}
          onFocus={handleHover}
          onContextMenu={handleContextMenu}
        >
          <div className={styles.tooltip}>{item.name}</div>
          <motion.div className={styles.iconWrapper} style={{ width, height: width }}>
            <div className={styles.iconContent} style={{ fontSize: '2.5em' }}>
              {item.icon}
            </div>
          </motion.div>
          {item.isOpen && <div className={styles.dot} />}
        </motion.div>
      )}
    </>
  );
});