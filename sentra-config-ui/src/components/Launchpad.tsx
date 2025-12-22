import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';

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
  const [gridCols, setGridCols] = useState<number>(5);
  const [pageDir, setPageDir] = useState<number>(1); // Track direction as state

  // Keyboard navigation state
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset selection when page or search changes
  useEffect(() => {
    setSelectedIndex(-1);
  }, [currentPage, searchTerm]);

  // Focus search on open
  useEffect(() => {
    if (isOpen && !isMobileView) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen, isMobileView]);

  const filteredItems = useMemo(() => {
    if (!searchTerm) return items;
    const lowerTerm = searchTerm.toLowerCase().trim();
    if (!lowerTerm) return items;

    // Split search terms for smarter matching (e.g. "qq bot" matches "QQ Bot")
    const terms = lowerTerm.split(/\s+/);

    return items.filter(item => {
      const displayName = getDisplayName(item.name).toLowerCase();
      const name = item.name.toLowerCase();
      // All terms must match either display name or internal name
      return terms.every(term => displayName.includes(term) || name.includes(term));
    });
  }, [items, searchTerm]);

  // Helper: split list into pages
  const chunkBy = (arr: typeof items, size: number) => {
    const out: typeof items[] = [] as any;
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  // Pagination logic
  const pages = useMemo(() => {
    const size = Math.max(4, pageCapacity);

    // If searching, just paginate the filtered results directly
    if (searchTerm) {
      const chunks = chunkBy(filteredItems, size);
      return chunks.length ? chunks : [[]];
    }

    // Default view logic (categorized)
    const coreApps: typeof items = [];
    const toolsApps: typeof items = [];
    const qqApps: typeof items = [];

    const builtinToolOrder = ['file-manager', 'presets-editor', 'preset-importer', 'redis-editor', 'dev-center'];
    const builtinToolSet = new Set(builtinToolOrder);
    const builtinTools: typeof items = [];

    filteredItems.forEach(item => {
      const name = item.name.toLowerCase();
      if (builtinToolSet.has(name)) {
        builtinTools.push(item);
        return;
      }
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

    builtinTools.sort((a, b) => {
      const ia = builtinToolOrder.indexOf(a.name.toLowerCase());
      const ib = builtinToolOrder.indexOf(b.name.toLowerCase());
      return ia - ib;
    });

    // Priority items
    const isPriority = (it: typeof items[number]) => {
      const n = it.name.toLowerCase();
      return n === '.' || n.includes('utils/emoji-stickers') || n.includes('sentra-config-ui');
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

    // Strict Category Pagination:
    // 1. Core Pages (Priority + Core)
    const coreList = [...priority, ...c];
    const corePages = chunkBy(coreList, size);

    // 2. Tools Pages
    const toolsList = [...builtinTools, ...t];
    const toolsPages = chunkBy(toolsList, size);

    // 3. QQ Pages
    const qqList = q;
    const qqPages = chunkBy(qqList, size);

    // Combine all pages
    const out = [...corePages, ...toolsPages, ...qqPages];

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

      // Calculate columns
      const cols = isMobileView ? 4 : Math.max(3, Math.floor(w / 130)); // 110px min + gap

      setGridCols(cols);
      setPageCapacity(rows * cols);
    };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, [isMobileView]);

  const totalPages = pages.length;
  const activePage = Math.min(currentPage, totalPages - 1);
  const currentItems = pages[activePage] || [];

  const handlePageChange = useCallback((direction: 'prev' | 'next') => {
    if (direction === 'prev') {
      setPageDir(-1);
      setCurrentPage(p => Math.max(0, p - 1));
    } else {
      setPageDir(1);
      setCurrentPage(p => Math.min(totalPages - 1, p + 1));
    }
  }, [totalPages]);

  // For jumping to a specific page (dots/numbers)
  const jumpToPage = useCallback((targetPage: number) => {
    setPageDir(targetPage > currentPage ? 1 : -1);
    setCurrentPage(targetPage);
  }, [currentPage]);

  // Keyboard Navigation Handler
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Allow typing in search box if it's focused and key is not navigation
      if (document.activeElement === searchInputRef.current) {
        if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
          // Let these pass through to navigation logic
          e.preventDefault();
        } else {
          return; // Let user type
        }
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          if (selectedIndex < currentItems.length - 1) {
            setSelectedIndex(s => s + 1);
          } else if (activePage < totalPages - 1) {
            handlePageChange('next');
            setSelectedIndex(0);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (selectedIndex > 0) {
            setSelectedIndex(s => s - 1);
          } else if (activePage > 0) {
            handlePageChange('prev');
            // We don't know exact items on prev page easily without calc, 
            // but we can just set to -1 (last item logic could be added but 0 is safer)
            // Actually let's try to select last item of prev page
            const prevPageItems = pages[activePage - 1];
            setSelectedIndex(prevPageItems ? prevPageItems.length - 1 : 0);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (selectedIndex === -1) {
            setSelectedIndex(0);
          } else if (selectedIndex + gridCols < currentItems.length) {
            setSelectedIndex(s => s + gridCols);
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (selectedIndex - gridCols >= 0) {
            setSelectedIndex(s => s - gridCols);
          }
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedIndex >= 0 && currentItems[selectedIndex]) {
            currentItems[selectedIndex].onClick();
            onClose();
          } else if (currentItems.length > 0 && selectedIndex === -1) {
            // If nothing selected but Enter pressed, launch first item if searching?
            // Or maybe just select first item?
            if (searchTerm) {
              currentItems[0].onClick();
              onClose();
            }
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, currentItems, activePage, totalPages, gridCols, handlePageChange, onClose, pages, searchTerm]);



  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={`${styles.overlay} ${isMobileView ? styles.mobileOverlay : ''}`}
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.02 }}
          transition={{
            duration: 0.2,
            ease: 'easeOut',
          }}
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
                ref={searchInputRef}
                type="text"
                placeholder="搜索"
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(0);
                }}
                autoFocus={!isMobileView}
              />
            </div>

            <div
              className={styles.pagesContainer}
              ref={pagesContainerRef}
            >
              <AnimatePresence initial={false} custom={pageDir} mode="popLayout">
                <motion.div
                  key={activePage}
                  className={`${styles.grid} ${isMobileView ? styles.mobileGrid : ''}`}
                  custom={pageDir}
                  variants={{
                    enter: (direction: number) => ({
                      x: direction > 0 ? '100%' : '-100%',
                    }),
                    center: {
                      x: 0,
                    },
                    exit: (direction: number) => ({
                      x: direction < 0 ? '100%' : '-100%',
                    })
                  }}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{
                    x: { type: 'tween', duration: 0.3, ease: [0.25, 0.1, 0.25, 1] },
                  }}
                  drag={isMobileView ? 'x' : false}
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.2}
                  dragMomentum={false}
                  dragDirectionLock
                  onDragEnd={(_, info) => {
                    const offsetX = info.offset.x;
                    const velocityX = info.velocity.x;
                    const swipePower = offsetX * velocityX;
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
                  {currentItems.map((item, idx) => (
                    <motion.div
                      key={`${item.type}-${item.name}`}
                      className={`${styles.appItem} ${selectedIndex === idx ? styles.selected : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        item.onClick();
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)} // Mouse hover updates selection
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
                      onClick={() => jumpToPage(idx)}
                    />
                  ))}
                </div>

                <div className={styles.pageNumbers}>
                  {Array.from({ length: totalPages }, (_, i) => (
                    <button
                      key={`n-${i}`}
                      className={`${styles.pageNumber} ${i === activePage ? styles.activePageNumber : ''}`}
                      onClick={() => jumpToPage(i)}
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