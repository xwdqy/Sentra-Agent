import React, { useRef, useState, useEffect } from 'react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { SentraIcon } from './SentraIcon';
import { Alert, Button, Descriptions, Modal, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { motion, AnimatePresence } from 'framer-motion';
import { MacAlert } from './MacAlert';
import styles from './MenuBar.module.css';
import {
  AppstoreOutlined,
  AppleOutlined,
  BookOutlined,
  BulbOutlined,
  CheckOutlined,
  CloudDownloadOutlined,
  ControlOutlined,
  DownOutlined,
  FontSizeOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
  SoundOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { fontFiles } from 'virtual:sentra-fonts';
import { storage } from '../utils/storage';
import { authedFetch, getAuthHeaders } from '../services/api';

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

  onRunUpdate?: () => void;
  onRunForceUpdate?: () => void;
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
  performanceMode = false,
  onRunUpdate,
  onRunForceUpdate,
}) => {
  const [activeMenu, setActiveMenu] = useState<number | null>(null);
  const [showControlCenter, setShowControlCenter] = useState(false);
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [showAccentPicker, setShowAccentPicker] = useState(false);
  const [showFontPicker, setShowFontPicker] = useState(false);
  const [showNetworkAlert, setShowNetworkAlert] = useState(false);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkInfo, setNetworkInfo] = useState<any>(null);
  const [networkError, setNetworkError] = useState<string>('');
  const [spotlightQuery, setSpotlightQuery] = useState('');
  const [showUpdateAlert, setShowUpdateAlert] = useState(false);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [updateError, setUpdateError] = useState('');
  const accentButtonRef = useRef<HTMLDivElement | null>(null);
  const [accentPickerPos, setAccentPickerPos] = useState<{ top: number; left: number; width: number } | null>(null);
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

  const updateHas = !!(updateInfo?.success && updateInfo?.hasUpdate);

  const updateCommits: any[] = Array.isArray(updateInfo?.commits) ? updateInfo.commits : [];
  const updateFiles: any[] = Array.isArray(updateInfo?.files) ? updateInfo.files : [];

  const updateCommitColumns: ColumnsType<any> = [
    {
      title: 'SHA',
      dataIndex: 'shortSha',
      width: 86,
      render: (v: any) => (
        <Typography.Text code>
          {String(v || '').slice(0, 7)}
        </Typography.Text>
      ),
    },
    {
      title: '标题',
      dataIndex: 'subject',
      ellipsis: true,
      render: (v: any) => <Typography.Text>{String(v || '')}</Typography.Text>,
    },
    {
      title: '作者',
      dataIndex: 'author',
      width: 120,
      ellipsis: true,
      render: (v: any) => <Typography.Text type="secondary">{String(v || '')}</Typography.Text>,
    },
    {
      title: '时间',
      dataIndex: 'date',
      width: 180,
      ellipsis: true,
      render: (v: any) => <Typography.Text type="secondary">{String(v || '')}</Typography.Text>,
    },
  ];

  const updateFileColumns: ColumnsType<any> = [
    {
      title: '类型',
      dataIndex: 'status',
      width: 80,
      render: (v: any) => {
        const s = String(v || '').toUpperCase();
        const color = s === 'A' ? 'green' : s === 'D' ? 'red' : s === 'M' ? 'blue' : 'default';
        return <Tag color={color}>{s || '-'}</Tag>;
      },
    },
    {
      title: '文件',
      dataIndex: 'file',
      render: (v: any) => <Typography.Text>{String(v || '')}</Typography.Text>,
    },
  ];

  const networkLocalRows: any[] = Array.isArray(networkInfo?.local) ? networkInfo.local : [];
  const networkLocalColumns: ColumnsType<any> = [
    { title: '网卡', dataIndex: 'name', width: 120, ellipsis: true },
    {
      title: '地址',
      dataIndex: 'address',
      render: (v: any) => <Typography.Text>{String(v || '')}</Typography.Text>,
    },
    { title: '协议', dataIndex: 'family', width: 80, ellipsis: true },
    {
      title: '类型',
      dataIndex: 'internal',
      width: 80,
      render: (v: any) => (v ? <Tag>Internal</Tag> : <Tag color="blue">LAN</Tag>),
    },
  ];

  const fetchUpdateInfo = async () => {
    setUpdateLoading(true);
    setUpdateError('');
    try {
      const controller = new AbortController();
      const t = window.setTimeout(() => controller.abort(), 60_000);
      const res = await authedFetch('/api/system/update/check', {
        method: 'GET',
        headers: getAuthHeaders({ json: false }),
        cache: 'no-store',
        signal: controller.signal,
      });
      window.clearTimeout(t);
      const data: any = await res.json().catch(() => null);
      if (!res.ok) {
        setUpdateInfo(null);
        const msg = (data && (data.message || data.error)) ? String(data.message || data.error) : '';
        setUpdateError(msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status} ${res.statusText}`);
        return;
      }
      if (!data?.success) {
        setUpdateInfo(data);
        setUpdateError(String(data?.error || 'update check failed'));
        return;
      }
      setUpdateInfo(data);
    } catch (e) {
      setUpdateInfo(null);
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateLoading(false);
    }
  };

  useEffect(() => {
    void fetchUpdateInfo();
    const t = window.setInterval(() => {
      void fetchUpdateInfo();
    }, 10 * 60_000);
    return () => window.clearInterval(t);
  }, []);

  const computeAccentPickerPos = () => {
    const rect = accentButtonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const panelWidth = 244;
    const gap = 8;
    const margin = 12;
    const top = Math.round(rect.bottom + gap);
    let left = Math.round(rect.right - panelWidth);
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;

    setAccentPickerPos({ top, left, width: panelWidth });
  };

  const setSystemFont = async (fileName: string | null) => {
    const fallback = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

    if (!fileName) {
      const next = fallback;
      document.documentElement.style.setProperty('--system-font', next);
      try {
        storage.setString('sentra_system_font', next);
        storage.remove('sentra_font_file');
      } catch { }

      setActiveFontFile(null);
      return;
    }

    const baseName = String(fileName).replace(/\.[^/.]+$/, '');
    const family = `SentraFont_${baseName.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;

    try {
      const face = new FontFace(family, `url(/fonts/${encodeURIComponent(fileName)})`);
      await face.load();
      document.fonts.add(face);
    } catch { }

    const next = `"${family}", ${fallback}`;
    document.documentElement.style.setProperty('--system-font', next);
    try {
      storage.setString('sentra_system_font', next);
      storage.setString('sentra_font_file', fileName);
    } catch { }

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

  const waitForServerReady = async () => {
    const timeoutMs = 60_000;
    const pollMs = 400;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const t = window.setTimeout(() => controller.abort(), 2000);
        const res = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
        window.clearTimeout(t);
        if (res.ok) return true;
      } catch {
        // ignore
      }
      await new Promise<void>(r => window.setTimeout(r, pollMs));
    }
    return false;
  };

  const handleRestartConfirm = async () => {
    setIsRestarting(true);
    try {
      const res = await fetch('/api/system/restart', {
        method: 'POST',
        headers: getAuthHeaders({ json: false }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setIsRestarting(false);
        alert(`Failed to restart system: ${res.status} ${res.statusText}${text ? `\n${text}` : ''}`);
        return;
      }
      const ok = await waitForServerReady();
      if (ok) {
        window.location.reload();
        return;
      }
      setIsRestarting(false);
      alert('Restart started, but timed out waiting for server to come back online. Please refresh the page manually.');
    } catch (e) {
      setIsRestarting(false);
      alert('Failed to restart system: ' + e);
    }
  };

  const fetchNetworkInfo = async () => {
    setNetworkLoading(true);
    setNetworkError('');
    try {
      const controller = new AbortController();
      const t = window.setTimeout(() => controller.abort(), 60_000);
      const res = await fetch('/api/system/network', {
        method: 'GET',
        headers: getAuthHeaders({ json: false }),
        cache: 'no-store',
        signal: controller.signal,
      });
      window.clearTimeout(t);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setNetworkError(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ''}`);
        setNetworkInfo(null);
        return;
      }
      const data: any = await res.json().catch(() => null);
      setNetworkInfo(data);
    } catch (e) {
      setNetworkError(e instanceof Error ? e.message : String(e));
      setNetworkInfo(null);
    } finally {
      setNetworkLoading(false);
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

  useEffect(() => {
    if (!showAccentPicker) return;
    computeAccentPickerPos();

    const handle = () => computeAccentPickerPos();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [showAccentPicker]);

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
          <Tooltip title={showDock ? '隐藏常用应用' : '显示常用应用'}>
            <div
              className={styles.menuItem}
              onClick={(e) => {
                e.stopPropagation();
                onToggleDock();
              }}
              aria-label={showDock ? '隐藏常用应用' : '显示常用应用'}
              style={{ opacity: showDock ? 1 : 0.5 }}
            >
              <AppstoreOutlined style={{ fontSize: 18 }} />
            </div>
          </Tooltip>
          <Tooltip title="切换应用主题颜色（Accent）">
            <div
              className={`${styles.menuItem} ${styles.accentMenuItem} ${showAccentPicker ? styles.active : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(null);
                setShowControlCenter(false);
                setShowSpotlight(false);
                setShowFontPicker(false);
                if (showAccentPicker) {
                  setShowAccentPicker(false);
                } else {
                  computeAccentPickerPos();
                  setShowAccentPicker(true);
                }
              }}
              aria-label="切换应用主题颜色（Accent）"
              ref={accentButtonRef}
            >
              <div className={styles.accentButton}>
                <span className={styles.accentDot} />
                <DownOutlined className={styles.accentChevron} style={{ fontSize: 14 }} />
              </div>
            </div>
          </Tooltip>

          <Tooltip title="切换字体">
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
              aria-label="切换字体"
              ref={fontButtonRef}
            >
              <div className={styles.fontButton}>
                <FontSizeOutlined style={{ fontSize: 14, opacity: 0.85 }} />
                <DownOutlined className={styles.fontChevron} style={{ fontSize: 14 }} />
              </div>
            </div>
          </Tooltip>
          <Tooltip title="网络">
            <div
              className={styles.menuItem}
              aria-label="网络"
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(null);
                setShowControlCenter(false);
                setShowAccentPicker(false);
                setShowFontPicker(false);
                setShowSpotlight(false);
                setShowNetworkAlert(true);
                void fetchNetworkInfo();
              }}
            >
              <WifiOutlined style={{ fontSize: 18 }} />
            </div>
          </Tooltip>
          <Tooltip title="搜索">
            <div
              className={styles.menuItem}
              onClick={(e) => {
                e.stopPropagation();
                setShowControlCenter(false);
                setShowAccentPicker(false);
                setShowSpotlight(v => !v);
              }}
              aria-label="搜索"
            >
              <SearchOutlined style={{ fontSize: 18 }} />
            </div>
          </Tooltip>
          <Tooltip title="控制中心">
            <div
              className={styles.menuItem}
              onClick={(e) => {
                e.stopPropagation();
                setShowSpotlight(false);
                setShowAccentPicker(false);
                setShowControlCenter(v => !v);
              }}
              aria-label="控制中心"
            >
              <ControlOutlined style={{ fontSize: 18 }} />
            </div>
          </Tooltip>
          <Tooltip title="打开 DeepWiki · Sentra Agent 文档与助手">
            <div
              className={styles.menuItem}
              onClick={(e) => { e.stopPropagation(); onOpenDeepWiki(); }}
              aria-label="打开 DeepWiki · Sentra Agent 文档与助手"
            >
              <BookOutlined style={{ fontSize: 18 }} />
            </div>
          </Tooltip>

          <Tooltip
            title={updateInfo?.success
              ? (updateInfo?.hasUpdate ? `发现更新（落后 ${String(updateInfo?.behind ?? '')}）` : '已是最新')
              : (updateError ? `更新检查失败：${updateError}` : '检查更新')}
          >
            <div
              className={styles.menuItem}
              onClick={(e) => {
                e.stopPropagation();
                setActiveMenu(null);
                setShowControlCenter(false);
                setShowAccentPicker(false);
                setShowFontPicker(false);
                setShowSpotlight(false);
                setShowUpdateAlert(true);
                void fetchUpdateInfo();
              }}
              aria-label="检查更新"
            >
              <CloudDownloadOutlined style={{ fontSize: 18 }} />
              {updateInfo?.success && updateInfo?.hasUpdate ? (
                Number(updateInfo?.behind || 0) > 0 ? (
                  <span className={styles.badgeCount}>{Number(updateInfo?.behind || 0) > 99 ? '99+' : String(updateInfo?.behind || 0)}</span>
                ) : (
                  <span className={styles.badgeDot} />
                )
              ) : null}
            </div>
          </Tooltip>

          <Tooltip title="重启系统">
            <div
              className={styles.menuItem}
              onClick={() => setShowRestartAlert(true)}
              aria-label="重启系统"
            >
              <ReloadOutlined style={{ fontSize: 18 }} />
            </div>
          </Tooltip>
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

      <Modal
        open={showUpdateAlert}
        title={(
          <Space size={8}>
            <span>系统更新</span>
            {updateLoading ? <Tag color="processing">检查中</Tag> : updateHas ? <Tag color="warning">发现更新</Tag> : <Tag color="success">已是最新</Tag>}
          </Space>
        )}
        onCancel={() => setShowUpdateAlert(false)}
        width={900}
        footer={(
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Typography.Text type="secondary">更新会在“终端窗口”中执行；完成后请手动点击右上角“重启系统”。</Typography.Text>
            <Space>
              <Button onClick={() => void fetchUpdateInfo()} loading={updateLoading}>重新检查</Button>
              <Button
                danger
                disabled={!onRunForceUpdate}
                onClick={() => {
                  if (onRunForceUpdate) onRunForceUpdate();
                  setShowUpdateAlert(false);
                }}
              >
                强制更新
              </Button>
              <Button
                type="primary"
                disabled={!onRunUpdate}
                onClick={() => {
                  if (onRunUpdate) onRunUpdate();
                  setShowUpdateAlert(false);
                }}
              >
                更新
              </Button>
            </Space>
          </Space>
        )}
        destroyOnHidden
      >
        {updateError ? (
          <Alert type="error" showIcon message="更新检查失败" description={updateError} />
        ) : null}

        {!updateError && updateInfo?.success && updateInfo?.fetchOk === false ? (
          <Alert
            type="warning"
            showIcon
            message="远端更新拉取失败：显示的结果可能不是最新"
            description={String(updateInfo?.fetchError || 'git fetch failed')}
            style={{ marginBottom: 12 }}
          />
        ) : null}

        <Tabs
          items={[
            {
              key: 'overview',
              label: '概览',
              children: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Descriptions
                    size="small"
                    bordered
                    column={2}
                    items={[
                      {
                        key: 'branch',
                        label: '当前分支',
                        children: <Typography.Text>{String(updateInfo?.branch || '')}</Typography.Text>,
                      },
                      {
                        key: 'remote',
                        label: '远端分支',
                        children: <Typography.Text>{`origin/${String(updateInfo?.remoteBranch || '')}`}</Typography.Text>,
                      },
                      {
                        key: 'behind',
                        label: '落后',
                        children: <Typography.Text>{String(updateInfo?.behind ?? '')}</Typography.Text>,
                      },
                      {
                        key: 'ahead',
                        label: '领先',
                        children: <Typography.Text>{String(updateInfo?.ahead ?? '')}</Typography.Text>,
                      },
                      {
                        key: 'head',
                        label: '本地 Commit',
                        span: 2,
                        children: <Typography.Text code>{String(updateInfo?.currentCommit || '')}</Typography.Text>,
                      },
                      {
                        key: 'remoteCommit',
                        label: '远端 Commit',
                        span: 2,
                        children: <Typography.Text code>{String(updateInfo?.remoteCommit || '')}</Typography.Text>,
                      },
                    ]}
                  />

                  <div>
                    <Typography.Title level={5} style={{ margin: '0 0 8px 0' }}>文件变更（汇总）</Typography.Title>
                    <Table
                      size="small"
                      rowKey={(r) => `${String(r.status || '')}:${String(r.file || '')}`}
                      columns={updateFileColumns}
                      dataSource={updateFiles}
                      pagination={false}
                      scroll={{ y: 260 }}
                      locale={{ emptyText: updateLoading ? '加载中…' : '无变更' }}
                    />
                  </div>
                </div>
              )
            },
            {
              key: 'commits',
              label: `提交 (${updateCommits.length})`,
              children: (
                <Table
                  size="small"
                  rowKey={(r) => String(r.sha || r.shortSha || Math.random())}
                  columns={updateCommitColumns}
                  dataSource={updateCommits}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  expandable={{
                    expandedRowRender: (row) => {
                      const fs = Array.isArray(row?.files) ? row.files : [];
                      if (!fs.length) return <Typography.Text type="secondary">（无文件列表）</Typography.Text>;
                      return (
                        <div style={{ padding: 8 }}>
                          <Table
                            size="small"
                            rowKey={(r) => `${String(r.status || '')}:${String(r.file || '')}`}
                            columns={updateFileColumns}
                            dataSource={fs}
                            pagination={false}
                          />
                        </div>
                      );
                    },
                    rowExpandable: (row) => Array.isArray(row?.files) && row.files.length > 0,
                  }}
                  locale={{ emptyText: updateLoading ? '加载中…' : '无提交' }}
                />
              )
            }
          ]}
        />
      </Modal>

      <Modal
        open={showNetworkAlert}
        title={(
          <Space size={8}>
            <span>网络信息</span>
            {networkLoading ? <Tag color="processing">加载中</Tag> : networkError ? <Tag color="error">失败</Tag> : <Tag color="success">正常</Tag>}
          </Space>
        )}
        onCancel={() => setShowNetworkAlert(false)}
        width={860}
        footer={<Button onClick={() => setShowNetworkAlert(false)}>关闭</Button>}
        destroyOnHidden
      >
        {networkError ? (
          <Alert type="error" showIcon message="网络信息获取失败" description={networkError} />
        ) : null}

        {!networkError && networkInfo?.publicError ? (
          <Alert
            type="warning"
            showIcon
            message="公网信息获取失败（不影响局域网）"
            description={String(networkInfo.publicError || '')}
            style={{ marginBottom: 12 }}
          />
        ) : null}

        <Tabs
          items={[
            {
              key: 'overview',
              label: '概览',
              children: (
                <Descriptions
                  size="small"
                  bordered
                  column={2}
                  items={[
                    {
                      key: 'hostname',
                      label: 'Hostname',
                      children: <Typography.Text>{String(networkInfo?.hostname || '')}</Typography.Text>,
                    },
                    {
                      key: 'serverPort',
                      label: 'Server Port',
                      children: <Typography.Text>{String(networkInfo?.serverPort || '')}</Typography.Text>,
                    },
                    {
                      key: 'clientPort',
                      label: 'Client Port',
                      children: <Typography.Text>{String(networkInfo?.clientPort || '')}</Typography.Text>,
                    },
                    {
                      key: 'publicIp',
                      label: '公网 IP',
                      children: <Typography.Text>{String(networkInfo?.public?.ip || '')}</Typography.Text>,
                    },
                    {
                      key: 'isp',
                      label: 'ISP/Org',
                      span: 2,
                      children: <Typography.Text>{String(networkInfo?.public?.org || networkInfo?.public?.asn || '')}</Typography.Text>,
                    },
                    {
                      key: 'location',
                      label: '位置',
                      span: 2,
                      children: (
                        <Typography.Text>
                          {String(networkInfo?.public?.city || '')}
                          {networkInfo?.public?.region ? `, ${String(networkInfo.public.region)}` : ''}
                          {networkInfo?.public?.country_name ? `, ${String(networkInfo.public.country_name)}` : ''}
                        </Typography.Text>
                      ),
                    },
                    {
                      key: 'timezone',
                      label: 'Timezone',
                      children: <Typography.Text>{String(networkInfo?.public?.timezone || '')}</Typography.Text>,
                    },
                    {
                      key: 'latlon',
                      label: 'Lat/Lon',
                      children: <Typography.Text>{`${String(networkInfo?.public?.latitude ?? '')}, ${String(networkInfo?.public?.longitude ?? '')}`}</Typography.Text>,
                    },
                  ]}
                />
              )
            },
            {
              key: 'lan',
              label: `局域网 (${networkLocalRows.length})`,
              children: (
                <Table
                  size="small"
                  rowKey={(r) => `${String(r.name || '')}-${String(r.address || '')}-${String(r.family || '')}`}
                  columns={networkLocalColumns}
                  dataSource={networkLocalRows}
                  pagination={false}
                  scroll={{ y: 360 }}
                  locale={{ emptyText: networkLoading ? '加载中…' : '无数据' }}
                />
              )
            }
          ]}
        />
      </Modal>

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
              background: 'linear-gradient(var(--sentra-accent-tint-12), var(--sentra-accent-tint-12)), var(--sentra-panel-bg-strong)',
              zIndex: 1000000002,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--sentra-fg)',
              fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
              transform: 'translateZ(0)', // Hardware acceleration
            }}
          >
            <div style={{
              width: 40,
              height: 40,
              border: '4px solid var(--sentra-border-strong)',
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
              <SearchOutlined style={{ fontSize: 24, color: 'var(--sentra-muted-fg)' }} />
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
                  <div className={`${styles.ccIcon} ${styles.active}`}><WifiOutlined /></div>
                  <div className={styles.ccText}>Wi-Fi</div>
                </div>
                <div className={styles.ccRow}>
                  <div className={`${styles.ccIcon} ${styles.active}`}><LinkOutlined /></div>
                  <div className={styles.ccText}>蓝牙</div>
                </div>
                <div className={styles.ccRow}>
                  <div className={`${styles.ccIcon} ${styles.active}`}><AppleOutlined /></div>
                  <div className={styles.ccText}>AirDrop</div>
                </div>
              </div>
              <div className={styles.ccModule}>
                <div className={styles.ccRow}>
                  <div className={styles.ccIcon}><BulbOutlined /></div>
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
                  <div className={styles.ccIcon}><SoundOutlined /></div>
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
            style={accentPickerPos ? { top: accentPickerPos.top, left: accentPickerPos.left, width: accentPickerPos.width } : undefined}
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
                  <Tooltip key={c} title={c}>
                    <div
                      className={`${styles.swatch} ${isActive ? styles.swatchActive : ''}`}
                      style={{ background: c }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAccentColor(c);
                      }}
                      aria-label={c}
                    />
                  </Tooltip>
                );
              })}
            </div>

            <div className={styles.customRow}>
              <div className={styles.customLabel}>自定义</div>
              <div className={styles.customControls}>
                <Tooltip title="打开系统调色盘">
                  <input
                    className={styles.colorInput}
                    type="color"
                    value={String(accentColor || '#007AFF')}
                    onChange={(e) => setAccentColor(e.target.value)}
                    aria-label="打开系统调色盘"
                  />
                </Tooltip>
                <Tooltip title="重置为默认">
                  <button
                    className={styles.resetBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAccentColor('#007AFF');
                    }}
                    type="button"
                    aria-label="重置为默认"
                  >
                    重置
                  </button>
                </Tooltip>
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