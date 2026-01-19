import React, { useRef, useState, useEffect } from 'react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { SentraIcon } from './SentraIcon';
import {
  IoLogoApple,
  IoSearch,
  IoWifi,
  IoBluetooth,
  IoVolumeHigh,
  IoSunny,
  IoApps,
  IoReload,
  IoBookOutline,
  IoChevronDown,
} from 'react-icons/io5';
import { BsController } from 'react-icons/bs';
import { motion, AnimatePresence } from 'framer-motion';
import { MacAlert } from './MacAlert';
import styles from './MenuBar.module.css';
import { CheckOutlined, FontSizeOutlined } from '@ant-design/icons';
import { fontFiles } from 'virtual:sentra-fonts';
import { storage } from '../utils/storage';

interface MenuBarProps {
  title?: string;
  menus?: { label: string; items: { label: string; onClick: () => void }[] }[];
  onAppleClick?: () => void;
  brightness: number;
  setBrightness: (val: number) => void;
  accentColor: string;
  setAccentColor: (val: string) => void;
  showDock: boolean;
  onToggleDock: () => void;
  onOpenDeepWiki: () => void;
  performanceMode?: boolean;
}

const Clock: React.FC = () => {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className={styles.menuItem} style={{ fontWeight: 500 }}>
      {format(currentTime, 'M月d日 EEE HH:mm', { locale: zhCN })}
    </div>
  );
};

export const MenuBar: React.FC<MenuBarProps> = ({
  title = 'Sentra Agent',
  menus = [],
  onAppleClick,
  brightness,
  setBrightness,
  accentColor,
  setAccentColor,
  showDock,
  onToggleDock,
  onOpenDeepWiki,
  performanceMode = false
}) => {
  const [activeMenu, setActiveMenu] = useState<number | null>(null);
  const [showControlCenter, setShowControlCenter] = useState(false);
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [showAccentPicker, setShowAccentPicker] = useState(false);
  const [showFontPicker, setShowFontPicker] = useState(false);
  const [spotlightQuery, setSpotlightQuery] = useState('');
  const fontButtonRef = useRef<HTMLDivElement | null>(null);
  const [fontPickerPos, setFontPickerPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [activeFontFile, setActiveFontFile] = useState<string | null>(() => {
    const v = storage.getString('sentra_font_file', { fallback: '' });
    return v || null;
  });

  const computeFontPickerPos = () => {
    const rect = fontButtonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const panelWidth = 244;
    const gap = 8;
    const margin = 12;
    const top = Math.round(rect.bottom + gap);
    let left = Math.round(rect.right - panelWidth);
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;

    setFontPickerPos({ top, left, width: panelWidth });
  };

  const setSystemFont = async (fileName: string | null) => {
    const fallback = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

    if (!fileName) {
      const next = fallback;
      document.documentElement.style.setProperty('--system-font', next);
      try {
        storage.setString('sentra_system_font', next);
        storage.remove('sentra_font_file');
      } catch {}

      setActiveFontFile(null);
      return;
    }

    const baseName = String(fileName).replace(/\.[^/.]+$/, '');
    const family = `SentraFont_${baseName.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;

    try {
      const face = new FontFace(family, `url(/fonts/${encodeURIComponent(fileName)})`);
      await face.load();
      document.fonts.add(face);
    } catch {}

    const next = `"${family}", ${fallback}`;
    document.documentElement.style.setProperty('--system-font', next);
    try {
      storage.setString('sentra_system_font', next);
      storage.setString('sentra_font_file', fileName);
    } catch {}

    setActiveFontFile(fileName);
  };

  useEffect(() => {
    const storedFile = (() => {
      return storage.getString('sentra_font_file', { fallback: '' }) || null;
    })();

    if (storedFile && Array.isArray(fontFiles) && fontFiles.includes(storedFile as any)) {
      void setSystemFont(storedFile);
    }
  }, []);

  const accentPresets = [
    '#007AFF',
    '#34C759',
    '#FF9500',
    '#FF3B30',
    '#AF52DE',
    '#FF2D55',
    '#00C7BE',
    '#5AC8FA',
    '#5856D6',
    '#A2845E',
    '#8E8E93',
    '#111827',
  ];

  // Restart State
  const [showRestartAlert, setShowRestartAlert] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const handleRestartConfirm = async () => {
    setIsRestarting(true);
    try {
      await fetch('/api/system/restart', { method: 'POST' });
      setTimeout(() => {
        window.location.reload();
      }, 5000);
    } catch (e) {
      setIsRestarting(false);
      alert('Failed to restart system: ' + e);
    }
  };

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setActiveMenu(null);
      setShowControlCenter(false);
      setShowSpotlight(false);
      setShowAccentPicker(false);
      setShowFontPicker(false);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!showFontPicker) return;
    computeFontPickerPos();

    const handle = () => computeFontPickerPos();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [showFontPicker]);

  const handleSpotlightSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (spotlightQuery.trim()) {
      // Use Bing search in iframe
    }
  };

  return (
    <>
      <div className={`${styles.menubar} ${performanceMode ? styles.performanceMode : ''}`} onClick={e => e.stopPropagation()}>
        <div className={styles.left}>
          <div className={`${styles.menuItem} ${styles.appleIcon}`} onClick={onAppleClick}>
            <SentraIcon size={18} />
          </div>
          <div className={`${styles.menuItem} ${styles.appTitle}`}>{title}</div>
          {menus.map((menu, index) => (
            <div
              key={index}
              className={`${styles.menuItem} ${activeMenu === index ? styles.active : ''}`}
              onClick={() => setActiveMenu(activeMenu === index ? null : index)}
            >
              {menu.label}
              {activeMenu === index && (
                <div className={styles.dropdown}>
                  {menu.items.map((item, idx) => (
                    <div
                      key={idx}
                      className={styles.dropdownItem}
                      onClick={(e) => {
                        e.stopPropagation();
                        item.onClick();
                        setActiveMenu(null);
                      }}
                    >
                      {item.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className={styles.right}>
          <div
            className={styles.menuItem}
            onClick={(e) => {
              e.stopPropagation();
              onToggleDock();
            }}
            title={showDock ? '隐藏常用应用' : '显示常用应用'}
            style={{ opacity: showDock ? 1 : 0.5 }}
          >
            <IoApps size={18} />
          </div>
          <div
            className={`${styles.menuItem} ${styles.accentMenuItem} ${showAccentPicker ? styles.active : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setActiveMenu(null);
              setShowControlCenter(false);
              setShowSpotlight(false);
              setShowFontPicker(false);
              setShowAccentPicker(v => !v);
            }}
            title="切换应用主题颜色（Accent）"
          >
            <div className={styles.accentButton}>
              <span className={styles.accentDot} />
              <IoChevronDown className={styles.accentChevron} size={14} />
            </div>
          </div>

          <div
            className={`${styles.menuItem} ${styles.fontMenuItem} ${showFontPicker ? styles.active : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setActiveMenu(null);
              setShowControlCenter(false);
              setShowAccentPicker(false);
              setShowSpotlight(false);
              if (showFontPicker) {
                setShowFontPicker(false);
              } else {
                computeFontPickerPos();
                setShowFontPicker(true);
              }
            }}
            title="切换字体"
            ref={fontButtonRef}
          >
            <div className={styles.fontButton}>
              <FontSizeOutlined style={{ fontSize: 14, opacity: 0.85 }} />
              <IoChevronDown className={styles.fontChevron} size={14} />
            </div>
          </div>
          <div className={styles.menuItem}>
            <IoWifi size={18} />
          </div>
          <div
            className={styles.menuItem}
            onClick={(e) => {
              e.stopPropagation();
              setShowControlCenter(false);
              setShowAccentPicker(false);
              setShowSpotlight(v => !v);
            }}
          >
            <IoSearch size={18} />
          </div>
          <div
            className={styles.menuItem}
            onClick={(e) => {
              e.stopPropagation();
              setShowSpotlight(false);
              setShowAccentPicker(false);
              setShowControlCenter(v => !v);
            }}
          >
            <BsController size={18} />
          </div>
          <div
            className={styles.menuItem}
            onClick={(e) => { e.stopPropagation(); onOpenDeepWiki(); }}
            title="打开 DeepWiki · Sentra Agent 文档与助手"
          >
            <IoBookOutline size={18} />
          </div>
          <div
            className={styles.menuItem}
            onClick={() => setShowRestartAlert(true)}
            title="重启系统"
          >
            <IoReload size={18} />
          </div>
          <Clock />
        </div>
      </div>

      <MacAlert
        isOpen={showRestartAlert}
        title="系统重启"
        message="确定要重启系统吗？这将停止所有正在运行的进程并重新加载界面。"
        onClose={() => setShowRestartAlert(false)}
        onConfirm={handleRestartConfirm}
        confirmText="重启"
        cancelText="取消"
        isDanger={true}
      />

      {/* Restarting Overlay */}
      <AnimatePresence>
        {isRestarting ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              background: 'rgba(255, 255, 255, 0.95)',
              zIndex: 99999,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#333',
              fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
              transform: 'translateZ(0)', // Hardware acceleration
            }}
          >
            <div style={{
              width: 40,
              height: 40,
              border: '4px solid rgba(0,0,0,0.1)',
              borderTop: '4px solid var(--sentra-accent)',
              borderRadius: '50%',
              marginBottom: 20,
              animation: 'spin 1s linear infinite'
            }} />
            <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
            <div style={{ fontSize: 18, fontWeight: 500 }}>系统重启中...</div>
            <div style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>页面将自动刷新</div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Spotlight Search */}
      <AnimatePresence>
        {showSpotlight && (
          <motion.div
            className={styles.spotlightOverlay}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.spotlightBar}>
              <IoSearch size={24} color="var(--sentra-muted-fg)" />
              <form onSubmit={handleSpotlightSearch} style={{ width: '100%' }}>
                <input
                  type="text"
                  placeholder="Bing 搜索"
                  value={spotlightQuery}
                  onChange={e => setSpotlightQuery(e.target.value)}
                  autoFocus
                  style={{ fontSize: '20px', fontWeight: 300 }}
                />
              </form>
            </div>
            {spotlightQuery && (
              <div className={styles.spotlightResults} style={{ borderRadius: '0 0 12px 12px' }}>
                <iframe
                  src={`https://www.bing.com/search?q=${encodeURIComponent(spotlightQuery)}&igu=1`}
                  title="Bing Search"
                  width="100%"
                  height="100%"
                  style={{ border: 'none', borderRadius: '0 0 12px 12px' }}
                />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Control Center */}
      <AnimatePresence>
        {showControlCenter ? (
          <motion.div
            className={styles.controlCenter}
            initial={{ opacity: 0, scale: 0.9, x: 20, y: -20 }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.ccGrid}>
              <div className={styles.ccModule}>
                <div className={styles.ccRow}>
                  <div className={`${styles.ccIcon} ${styles.active}`}><IoWifi /></div>
                  <div className={styles.ccText}>Wi-Fi</div>
                </div>
                <div className={styles.ccRow}>
                  <div className={`${styles.ccIcon} ${styles.active}`}><IoBluetooth /></div>
                  <div className={styles.ccText}>蓝牙</div>
                </div>
                <div className={styles.ccRow}>
                  <div className={`${styles.ccIcon} ${styles.active}`}><IoLogoApple /></div>
                  <div className={styles.ccText}>AirDrop</div>
                </div>
              </div>
              <div className={styles.ccModule}>
                <div className={styles.ccRow}>
                  <div className={styles.ccIcon}><IoSunny /></div>
                  <div className={styles.ccSlider}>
                    <div className={styles.ccSliderFill} style={{ width: `${brightness}%` }} />
                    <input
                      type="range"
                      min="20"
                      max="100"
                      value={brightness}
                      onChange={(e) => setBrightness(Number(e.target.value))}
                      className={styles.rangeInput}
                    />
                  </div>
                </div>
              </div>
              <div className={styles.ccModule}>
                <div className={styles.ccRow}>
                  <div className={styles.ccIcon}><IoVolumeHigh /></div>
                  <div className={styles.ccSlider}><div className={styles.ccSliderFill} style={{ width: '50%' }} /></div>
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Accent Picker */}
      <AnimatePresence>
        {showAccentPicker ? (
          <motion.div
            className={styles.accentPicker}
            initial={{ opacity: 0, scale: 0.96, x: 10, y: -10 }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.accentHeader}>
              <div className={styles.accentTitle}>应用主题颜色（Accent）</div>
              <div className={styles.accentPreview}>
                <span className={styles.accentPreviewDot} />
                <span className={styles.accentPreviewHex}>{String(accentColor || '').toUpperCase()}</span>
              </div>
            </div>

            <div className={styles.swatchGrid}>
              {accentPresets.map((c) => {
                const isActive = String(accentColor || '').toUpperCase() === c;
                return (
                  <div
                    key={c}
                    className={`${styles.swatch} ${isActive ? styles.swatchActive : ''}`}
                    style={{ background: c }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAccentColor(c);
                    }}
                    title={c}
                  />
                );
              })}
            </div>

            <div className={styles.customRow}>
              <div className={styles.customLabel}>自定义</div>
              <div className={styles.customControls}>
                <input
                  className={styles.colorInput}
                  type="color"
                  value={String(accentColor || '#007AFF')}
                  onChange={(e) => setAccentColor(e.target.value)}
                  title="打开系统调色盘"
                />
                <button
                  className={styles.resetBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAccentColor('#007AFF');
                  }}
                  type="button"
                  title="重置为默认"
                >
                  重置
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showFontPicker && fontPickerPos ? (
          <motion.div
            className={styles.fontPicker}
            style={fontPickerPos ? { top: fontPickerPos.top, left: fontPickerPos.left, width: fontPickerPos.width } : undefined}
            initial={{ opacity: 0, scale: 0.96, x: 10, y: -10 }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.fontHeader}>
              <div className={styles.fontTitle}>字体</div>
            </div>

            <div className={styles.fontList}>
              <button
                type="button"
                className={`${styles.fontItem} ${!activeFontFile ? styles.fontItemActive : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void setSystemFont(null);
                  setShowFontPicker(false);
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span>系统默认</span>
                  {!activeFontFile ? <CheckOutlined /> : null}
                </span>
              </button>
              {(Array.isArray(fontFiles) ? fontFiles : []).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`${styles.fontItem} ${activeFontFile === String(f) ? styles.fontItemActive : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void setSystemFont(String(f));
                    setShowFontPicker(false);
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span>{String(f).replace(/\.[^/.]+$/, '')}</span>
                    {activeFontFile === String(f) ? <CheckOutlined /> : null}
                  </span>
                </button>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
};