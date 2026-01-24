import React, { memo, useMemo } from 'react';
import { Tooltip } from 'antd';
import { CloseOutlined, CodeOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import type { DeskWindow, TerminalWin } from '../types/ui';
import { getDisplayName, getIconForType } from '../utils/icons';
import styles from './SideTaskbar.module.css';

type ExtraTab = {
  id: string;
  title: string;
  icon: React.ReactNode;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
};

interface SideTaskbarProps {
  openWindows: DeskWindow[];
  terminalWindows: TerminalWin[];
  activeWinId: string | null;
  activeTerminalId: string | null;
  onActivateWindow: (id: string) => void;
  onActivateTerminal: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onCloseTerminal: (id: string) => void;
  extraTabs?: ExtraTab[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  topOffset?: number;
  expandedWidth?: number;
  collapsedWidth?: number;
  performanceMode?: boolean;
}

export const SideTaskbar: React.FC<SideTaskbarProps> = memo(({
  openWindows,
  terminalWindows,
  activeWinId,
  activeTerminalId,
  onActivateWindow,
  onActivateTerminal,
  onCloseWindow,
  onCloseTerminal,
  extraTabs = [],
  collapsed,
  onCollapsedChange,
  topOffset = 30,
  expandedWidth = 220,
  collapsedWidth = 44,
  performanceMode = false,
}) => {
  const hasTabs = openWindows.length + terminalWindows.length + extraTabs.length > 0;
  if (!hasTabs) return null;

  const width = collapsed ? collapsedWidth : expandedWidth;

  if (collapsed) {
    return (
      <div
        className={`${styles.floatingToggle} ${performanceMode ? styles.floatingTogglePerformance : ''}`}
        style={{
          ['--side-taskbar-top' as any]: `${topOffset}px`,
        }}
      >
        <Tooltip title="展开标签栏">
          <div
            className={styles.collapseHandle}
            role="button"
            tabIndex={0}
            aria-label="展开标签栏"
            onClick={(e) => {
              e.stopPropagation();
              onCollapsedChange(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onCollapsedChange(false);
              }
            }}
          >
            <RightOutlined style={{ fontSize: 14 }} />
          </div>
        </Tooltip>
      </div>
    );
  }

  const allTabs = useMemo(() => {
    return [
      ...openWindows.map(w => ({
        id: w.id,
        title: getDisplayName(w.file.name),
        type: 'app' as const,
        isActive: w.id === activeWinId,
        icon: getIconForType(w.file.name, w.file.type),
        onActivate: () => onActivateWindow(w.id),
        onClose: () => onCloseWindow(w.id),
      })),
      ...terminalWindows.map(t => ({
        id: t.id,
        title: t.title,
        type: 'terminal' as const,
        isActive: t.id === activeTerminalId,
        icon: <CodeOutlined />,
        onActivate: () => onActivateTerminal(t.id),
        onClose: () => onCloseTerminal(t.id),
      })),
      ...extraTabs.map(t => ({
        id: t.id,
        title: t.title,
        type: 'extra' as const,
        isActive: t.isActive,
        icon: t.icon,
        onActivate: t.onActivate,
        onClose: t.onClose,
      })),
    ];
  }, [openWindows, terminalWindows, extraTabs, activeWinId, activeTerminalId, onActivateWindow, onActivateTerminal, onCloseWindow, onCloseTerminal]);

  return (
    <div
      className={`${styles.sidebar} ${performanceMode ? styles.performance : ''}`}
      style={{
        ['--side-taskbar-top' as any]: `${topOffset}px`,
        ['--side-taskbar-width' as any]: `${width}px`,
      }}
    >
      <Tooltip title="收起标签栏">
        <div
          className={styles.collapseHandleEdge}
          role="button"
          tabIndex={0}
          aria-label="收起标签栏"
          onClick={(e) => {
            e.stopPropagation();
            onCollapsedChange(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onCollapsedChange(true);
            }
          }}
        >
          <LeftOutlined style={{ fontSize: 14 }} />
        </div>
      </Tooltip>

      <div className={styles.inner}>
        <div className={styles.tabs}>
          {allTabs.map(tab => (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.isActive ? styles.tabActive : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                tab.onActivate();
              }}
            >
              <div className={styles.icon}>{tab.icon}</div>
              <div className={styles.title}>{tab.title}</div>
              <Tooltip title="关闭">
                <div
                  className={styles.close}
                  onClick={(e) => {
                    e.stopPropagation();
                    tab.onClose();
                  }}
                  aria-label="关闭"
                >
                  <CloseOutlined style={{ fontSize: 12 }} />
                </div>
              </Tooltip>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
