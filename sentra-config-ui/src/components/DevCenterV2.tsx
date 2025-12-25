import React, { useMemo, useState } from 'react';
import type { FileItem } from '../types/ui';
import { getDisplayName, getIconForType } from '../utils/icons';
import { IoApps, IoConstruct } from 'react-icons/io5';
import styles from './DevCenter.module.css';

export interface DevCenterProps {
  allItems: FileItem[];
  onOpenItem: (file: FileItem) => void;
  onOpenDeepWiki?: () => void;
}

type TabKey = 'apps' | 'workers';

export const DevCenterV2: React.FC<DevCenterProps> = ({ allItems, onOpenItem, onOpenDeepWiki }) => {
  const [activeTab, setActiveTab] = useState<TabKey>('apps');

  const apps = useMemo(() => allItems.filter(i => i.type === 'module'), [allItems]);
  const workers = useMemo(() => allItems.filter(i => i.type === 'plugin'), [allItems]);

  const sections: Record<TabKey, FileItem[]> = {
    apps,
    workers,
  };

  const currentList = sections[activeTab];

  const renderTabLabel = (key: TabKey) => {
    if (key === 'apps') return '应用模块';
    return '后台插件';
  };

  const renderTabIcon = (key: TabKey) => {
    if (key === 'apps') return <IoApps size={16} />;
    return <IoConstruct size={16} />;
  };

  const getCount = (key: TabKey) => sections[key].length;

  return (
    <div className={styles.root}>
      {/* 顶部工具栏：标题 + 全局操作 */}
      <div className={styles.topBar}>
        <div className={styles.titleGroup}>
          <div className={styles.title}>开发中心</div>
          <div className={styles.subtitle}>
            统一管理 Sentra Agent 的应用模块与插件，一键跳转到对应的环境配置界面。
          </div>
        </div>
        <div className={styles.topActions} />
      </div>

      <div className={styles.body}>
        {/* 左侧导航：仅保留 应用模块 / 后台插件，两类 Tab */}
        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader}>导航</div>
          <div className={styles.navList}>
            {(['apps', 'workers'] as TabKey[]).map(key => (
              <div
                key={key}
                className={`${styles.navItem} ${activeTab === key ? styles.navItemActive : ''}`}
                onClick={() => setActiveTab(key)}
              >
                <div className={styles.navName}>
                  {renderTabIcon(key)}
                  <span>{renderTabLabel(key)}</span>
                </div>
                <span className={styles.navBadge}>{getCount(key)}</span>
              </div>
            ))}
          </div>

          {/* 底部文档入口 */}
          <div style={{ marginTop: 'auto', fontSize: 11, color: '#9ca3af' }}>
            <div style={{ opacity: 0.8 }}>开发文档与指南</div>
            <div
              style={{ cursor: 'pointer', marginTop: 4, color: '#2563eb' }}
              onClick={() => {
                if (onOpenDeepWiki) return onOpenDeepWiki();
                window.open('https://github.com/JustForSO/Sentra-Agent', '_blank');
              }}
            >
              打开 DeepWiki · Sentra Agent
            </div>
          </div>
        </div>

        {/* 右侧内容区域：列表 + 空状态 */}
        <div className={styles.content}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.sectionTitle}>{renderTabLabel(activeTab)}</div>
              <div className={styles.sectionDesc}>
                {activeTab === 'apps'
                  ? '应用模块（modules），通常对应一个 Agent 或完整的业务功能入口。'
                  : '后台插件（plugins），负责具体工具能力、系统集成与功能扩展。'}
              </div>
            </div>
          </div>

          {currentList.length === 0 ? (
            <div className={styles.emptyState}>
              当前分类下还没有可管理的项目。
              <br />
              请先在后端仓库中添加新的模块或插件，并在桌面顶部菜单中点击“刷新配置”后重新打开此窗口。
            </div>
          ) : (
            <div className={styles.cards}>
              {currentList.map(item => (
                <div
                  key={`${item.type}:${item.name}`}
                  className={styles.appCard}
                >
                  <div className={styles.appLeft}>
                    <div className={styles.appIcon}>
                      {getIconForType(item.name, item.type)}
                    </div>
                    <div className={styles.appMeta}>
                      <div className={styles.appName}>{getDisplayName(item.name)}</div>
                      <div className={styles.appPath}>{item.path}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={styles.appType}>
                      {item.type === 'module' ? '模块' : '插件'}
                    </span>
                    <button
                      className={styles.appActionBtn}
                      onClick={() => onOpenItem(item)}
                    >
                      打开环境配置
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
