import React, { useState, useMemo, useRef, useEffect } from 'react';

import { motion, AnimatePresence } from 'framer-motion';
import { getIconForType, getDisplayName } from '../utils/icons';
import styles from './Launchpad.module.css';
import { IoChevronBack, IoChevronForward } from 'react-icons/io5';

import { useDevice } from '../hooks/useDevice';

interface LaunchpadProps {
  isOpen: boolean;
  onClose: () => void;
  items: { name: string; type: 'module' | 'plugin'; onClick: () => void }[];
}

export const Launchpad: React.FC<LaunchpadProps> = ({ isOpen, onClose, items }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const { isMobile, isTablet } = useDevice();

  const isMobileView = isMobile || isTablet;

  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const [pageCapacity, setPageCapacity] = useState<number>(20);
  const prevPageRef = useRef<number>(0);

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const displayName = getDisplayName(item.name);
      return displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.name.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [items, searchTerm]);

  // Helper: split list into pages
  const chunkBy = (arr: typeof items, size: number) => {
    const out: typeof items[] = [] as any;
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  // Pagination: 首页只放 优先项 + 主板块(Core)；其余页依次为剩余Core、Tools、QQ
  const pages = useMemo(() => {
    if (searchTerm) return [filteredItems];

    const coreApps: typeof items = [];
    const toolsApps: typeof items = [];
    const qqApps: typeof items = [];

    filteredItems.forEach(item => {
      const name = item.name.toLowerCase();
      if (
        name.includes('sentra-prompts') ||
        name.includes('sentra-mcp') ||
        name.includes('sentra-emo') ||
        name.includes('sentra-adapter') ||
        name.includes('sentra-rag')
      ) {
        coreApps.push(item);
      } else if (name.includes('qq_') || name.includes('qq-')) {
        qqApps.push(item);
      } else {
        toolsApps.push(item);
      }
    });

    const byName = (a: typeof items[number], b: typeof items[number]) =>
      getDisplayName(a.name).localeCompare(getDisplayName(b.name), 'zh-Hans-CN');
    coreApps.sort(byName); toolsApps.sort(byName); qqApps.sort(byName);

    // Priority items: '.'(根目录配置) & 'utils/emoji-stickers'(表情包配置)
    const isPriority = (it: typeof items[number]) => {
      const n = it.name.toLowerCase();
      return n === '.' || n.includes('utils/emoji-stickers');
    };

    const priority: typeof items = [] as any;
    const removePriority = (arr: typeof items) => {
      const rest: typeof items = [] as any;
      arr.forEach(it => (isPriority(it) ? priority.push(it) : rest.push(it)));
      return rest;
    };

    const c = removePriority(coreApps);
    const t = removePriority(toolsApps);
    const q = removePriority(qqApps);

    const size = Math.max(4, pageCapacity);

    // 首屏：优先项 + 主板块；不混入 Tools/QQ
    const usedCore = Math.max(0, size - Math.min(priority.length, size));
    const firstPage = [...priority.slice(0, size), ...c.slice(0, usedCore)].slice(0, size);
    const remainingCore = c.slice(usedCore);

    const restOrdered = [...remainingCore, ...t, ...q];
    const restPages = chunkBy(restOrdered, size);

    const out: typeof items[] = [] as any;
    if (firstPage.length) out.push(firstPage);
    restPages.forEach(p => out.push(p));
    return out.length ? out : [[]];
  }, [filteredItems, searchTerm, pageCapacity]);

  useEffect(() => {
    const calc = () => {
      const container = pagesContainerRef.current;
      if (!container) return;
      const h = container.clientHeight;
      const w = container.clientWidth;
      // Reserve bottom space for pagination / safe-area on mobile
      const reservedBottom = isMobileView ? 120 : 0;
      const rowH = isMobileView ? 92 : 120;
      let availH = Math.max(0, h - reservedBottom);
      let rows = Math.max(3, Math.floor(availH / rowH));
      if (isMobileView) rows = Math.min(rows, 4); // clamp for consistency
      const cols = isMobileView ? 4 : Math.max(3, Math.floor(w / 130));
      setPageCapacity(rows * cols);
    };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, [isMobileView]);

  const totalPages = pages.length;
  const activePage = Math.min(currentPage, totalPages - 1);

  const handlePageChange = (direction: 'prev' | 'next') => {
    if (direction === 'prev') {
      setCurrentPage(p => Math.max(0, p - 1));
    } else {
      setCurrentPage(p => Math.min(totalPages - 1, p + 1));
    }
  };

  // Drag handled by framer-motion; no manual touch handlers

  const pageDir = currentPage >= prevPageRef.current ? 1 : -1;
  useEffect(() => { prevPageRef.current = currentPage; }, [currentPage]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={`${styles.overlay} ${isMobileView ? styles.mobileOverlay : ''}`}
          initial={{ opacity: 0, scale: 1.1 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.1 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className={styles.content}>

            <div className={styles.searchBar} onClick={e => e.stopPropagation()}>
              <span className="material-icons" style={{ color: '#fff', opacity: 0.6 }}>search</span>
              <input
                type="text"
                placeholder="搜索"
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(0);
                }}
                autoFocus
              />
            </div>

            <div
              className={styles.pagesContainer}
              ref={pagesContainerRef}
            >
              <AnimatePresence mode='wait'>
                <motion.div
                  key={activePage}
                  className={`${styles.grid} ${isMobileView ? styles.mobileGrid : ''}`}
                  initial={{ opacity: 0, x: 100 * pageDir, y: 0 }}
                  animate={{ opacity: 1, x: 0, y: 0 }}
                  exit={{ opacity: 0, x: -100 * pageDir, y: 0 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 26, mass: 0.6 }}
                  drag={isMobileView ? 'x' : false}
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.2}
                  dragMomentum={false}
                  dragDirectionLock
                  onDragEnd={(_, info) => {
                    const offsetX = info.offset.x;
                    const velocityX = info.velocity.x;
                    const swipePower = offsetX * velocityX; // 带方向的功率
                    const OFFSET_THRESHOLD = 20;
                    const VELOCITY_THRESHOLD = 150;
                    const POWER_THRESHOLD = 600;
                    if (offsetX < -OFFSET_THRESHOLD || velocityX < -VELOCITY_THRESHOLD || swipePower < -POWER_THRESHOLD) {
                      handlePageChange('next');
                    } else if (offsetX > OFFSET_THRESHOLD || velocityX > VELOCITY_THRESHOLD || swipePower > POWER_THRESHOLD) {
                      handlePageChange('prev');
                    }
                  }}
                >
                  {pages[activePage]?.map((item) => (
                    <motion.div
                      key={`${item.type}-${item.name}`}
                      className={styles.appItem}
                      onClick={(e) => {
                        e.stopPropagation();
                        item.onClick();
                        onClose();
                      }}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                    >
                      <div className={styles.iconWrapper}>
                        {getIconForType(item.name, item.type)}
                      </div>
                      <div className={styles.appName}>{getDisplayName(item.name)}</div>
                    </motion.div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>

            {
              <div className={`${styles.pagination} ${isMobileView ? styles.mobilePagination : ''}`} onClick={e => e.stopPropagation()}>
                <button
                  className={styles.navBtn}
                  onClick={() => handlePageChange('prev')}
                  disabled={activePage === 0}
                >
                  <IoChevronBack />
                </button>

                <div className={styles.dots}>
                  {pages.map((_, idx) => (
                    <div
                      key={idx}
                      className={`${styles.dot} ${idx === activePage ? styles.activeDot : ''}`}
                      onClick={() => setCurrentPage(idx)}
                    />
                  ))}
                </div>

                <div className={styles.pageNumbers}>
                  {Array.from({ length: totalPages }, (_, i) => (
                    <button
                      key={`n-${i}`}
                      className={`${styles.pageNumber} ${i === activePage ? styles.activePageNumber : ''}`}
                      onClick={() => setCurrentPage(i)}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>

                <div className={styles.pageCount}>{activePage + 1} / {totalPages}</div>

                <button
                  className={styles.navBtn}
                  onClick={() => handlePageChange('next')}
                  disabled={activePage === totalPages - 1}
                >
                  <IoChevronForward />
                </button>
              </div>
            }
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};