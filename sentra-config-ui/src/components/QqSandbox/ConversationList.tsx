import { Button, Input, Segmented, Select, Space, Tooltip } from 'antd';
import { SearchOutlined, SyncOutlined } from '@ant-design/icons';
import styles from './QqSandbox.module.css';
import type { Conversation } from './QqSandbox.types';

export function ConversationList(props: {
  sidebarMode: 'chats' | 'contacts';
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  syncBusy: boolean;
  syncSource: 'recent' | 'groups' | 'friends' | 'all';
  contactsTab: 'groups' | 'friends';
  search: string;
  activeKey: string | null;
  conversations: Conversation[];
  contactConversations: Conversation[];
  formatConvoTime: (ms: number) => string;
  isAvatarBroken: (key: string) => boolean;
  avatarKey: (kind: 'user' | 'group', id: number) => string;
  markAvatarBroken: (key: string) => void;
  pickInitials: (title: string) => string;

  setSearch: (v: string) => void;
  setSidebarMode: (v: 'chats' | 'contacts') => void;
  setContactsTab: (v: 'groups' | 'friends') => void;
  setSyncSource: (v: 'recent' | 'groups' | 'friends' | 'all') => void;
  syncGroups: () => void | Promise<void>;
  syncFriends: () => void | Promise<void>;
  setActiveKey: (key: string) => void;
  markRead: (key: string) => void;
  ensureGroupInfo: (gid: number) => void | Promise<void>;
  loadGroupMembers: (gid: number) => void | Promise<void>;
  syncBySource: () => void | Promise<void>;
  onSelectConversation?: (c: Conversation) => void;
}) {
  const {
    sidebarMode,
    status,
    syncBusy,
    syncSource,
    contactsTab,
    search,
    activeKey,
    conversations,
    contactConversations,
    formatConvoTime,
    isAvatarBroken,
    avatarKey,
    markAvatarBroken,
    pickInitials,
    setSearch,
    setSidebarMode,
    setContactsTab,
    setSyncSource,
    syncGroups,
    syncFriends,
    setActiveKey,
    markRead,
    ensureGroupInfo,
    loadGroupMembers,
    syncBySource,
    onSelectConversation,
  } = props;

  const list = sidebarMode === 'contacts' ? contactConversations : conversations;

  return (
    <div className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <Space size={8} className={styles.sidebarHeaderRow}>
          <Input
            className={styles.search}
            allowClear
            placeholder={sidebarMode === 'contacts' ? '搜索 联系人 / 群 / ID' : '搜索 会话 / ID'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<SearchOutlined />}
          />

          {sidebarMode === 'contacts' ? (
            <Segmented
              size="middle"
              value={contactsTab}
              onChange={(v) => {
                const t = String(v) === 'friends' ? 'friends' : 'groups';
                setContactsTab(t);
                setSyncSource(t === 'groups' ? 'groups' : 'friends');
                if (status === 'connected') {
                  if (t === 'groups') void syncGroups();
                  else void syncFriends();
                }
              }}
              options={[{ label: '群', value: 'groups' }, { label: '好友', value: 'friends' }]}
            />
          ) : (
            <Select
              className={styles.sourceSelect}
              value={syncSource}
              onChange={(v) => setSyncSource(v as any)}
              size="middle"
              options={[
                { value: 'recent', label: '最近' },
                { value: 'groups', label: '群' },
                { value: 'friends', label: '好友' },
                { value: 'all', label: '全部' },
              ]}
            />
          )}

          <Tooltip title={sidebarMode === 'contacts' ? '同步联系人' : '同步会话列表来源'}>
            <Button
              className={styles.smallBtn}
              icon={<SyncOutlined />}
              disabled={status !== 'connected' || syncBusy}
              loading={syncBusy}
              onClick={() => {
                if (sidebarMode === 'contacts') {
                  if (contactsTab === 'groups') void syncGroups();
                  else void syncFriends();
                  return;
                }
                void syncBySource();
              }}
            >
              同步
            </Button>
          </Tooltip>
        </Space>
      </div>

      <div className={styles.convoList}>
        {list.length === 0 ? (
          <div className={styles.empty}>
            {sidebarMode === 'contacts' ? '暂无联系人。' : '暂无会话。'}
            <div style={{ marginTop: 8, color: 'rgba(17,24,39,0.55)', fontSize: 12, lineHeight: 1.5 }}>
              你可以：
              <div>1) 点击上方“同步”拉取数据</div>
              <div>2) 确认已连接 Napcat/端口配置正确</div>
            </div>
          </div>
        ) : (
          list.map((c) => (
            <div
              key={c.key}
              className={`${styles.convoItem} ${activeKey === c.key ? styles.convoItemActive : ''}`}
              onClick={() => {
                setActiveKey(c.key);
                markRead(c.key);
                if (sidebarMode === 'contacts') setSidebarMode('chats');
                if (c.kind === 'group') {
                  try {
                    void ensureGroupInfo(c.targetId);
                    if (status === 'connected') void loadGroupMembers(c.targetId);
                  } catch {
                  }
                }
                try {
                  onSelectConversation?.(c);
                } catch {
                }
              }}
            >
              <div className={styles.avatar}>
                {c.avatarUrl && !isAvatarBroken(avatarKey(c.kind === 'group' ? 'group' : 'user', c.targetId)) ? (
                  <img
                    className={styles.avatarImg}
                    src={c.avatarUrl}
                    alt=""
                    loading="lazy"
                    onError={() => markAvatarBroken(avatarKey(c.kind === 'group' ? 'group' : 'user', c.targetId))}
                  />
                ) : (
                  <div className={styles.avatarFallback}>{pickInitials(c.title)}</div>
                )}
              </div>
              <div className={styles.convoMeta}>
                <div className={styles.convoTitleRow}>
                  <div className={styles.convoTitle} title={c.title}>{c.title}</div>
                  <div className={styles.convoTime}>{c.lastTime ? formatConvoTime(c.lastTime) : ''}</div>
                </div>
                <div className={styles.convoPreview} title={c.lastPreview}>{c.lastPreview}</div>
              </div>
              {c.unread > 0 && <div className={styles.unread}>{c.unread > 99 ? '99+' : c.unread}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
