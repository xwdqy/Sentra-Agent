import React, { useState, useEffect } from 'react';
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
  IoMoon,
  IoApps,
  IoReload
} from 'react-icons/io5';
import { BsController } from 'react-icons/bs';
import { motion, AnimatePresence } from 'framer-motion';
import { MacAlert } from './MacAlert';
import styles from './MenuBar.module.css';

interface MenuBarProps {
  title?: string;
  menus?: { label: string; items: { label: string; onClick: () => void }[] }[];
  onAppleClick?: () => void;
  brightness: number;
  setBrightness: (val: number) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  showDock: boolean;
  onToggleDock: () => void;
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
  theme,
  onToggleTheme,
  showDock,
  onToggleDock
}) => {
  const [activeMenu, setActiveMenu] = useState<number | null>(null);
  const [showControlCenter, setShowControlCenter] = useState(false);
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [spotlightQuery, setSpotlightQuery] = useState('');

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
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleSpotlightSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (spotlightQuery.trim()) {
      // Use Bing search in iframe
    }
  };

  return (
    <>
      <div className={styles.menubar} onClick={e => e.stopPropagation()}>
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
            onClick={(e) => { e.stopPropagation(); onToggleDock(); }}
            title={showDock ? '隐藏常用应用' : '显示常用应用'}
            style={{ opacity: showDock ? 1 : 0.5 }}
          >
            <IoApps size={18} />
          </div>
          <div className={styles.menuItem} onClick={onToggleTheme} title={theme === 'dark' ? '切换到日间模式' : '切换到夜间模式'}>
            {theme === 'dark' ? <IoMoon size={18} /> : <IoSunny size={18} />}
          </div>
          <div className={styles.menuItem}>
            <IoWifi size={18} />
          </div>
          <div className={styles.menuItem} onClick={() => setShowSpotlight(!showSpotlight)}>
            <IoSearch size={18} />
          </div>
          <div className={styles.menuItem} onClick={() => setShowControlCenter(!showControlCenter)}>
            <BsController size={18} />
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
        {isRestarting && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              background: 'rgba(255, 255, 255, 0.95)', // Solid background instead of blur
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
              borderTop: '4px solid #007AFF',
              borderRadius: '50%',
              marginBottom: 20,
              animation: 'spin 1s linear infinite'
            }} />
            <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
            <div style={{ fontSize: 18, fontWeight: 500 }}>系统重启中...</div>
            <div style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>页面将自动刷新</div>
          </motion.div>
        )}
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
              <IoSearch size={24} color="#999" />
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
              <div className={styles.spotlightResults} style={{ background: 'rgba(255, 255, 255, 0.95)', borderRadius: '0 0 12px 12px' }}>
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
        {showControlCenter && (
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
        )}
      </AnimatePresence>
    </>
  );
};