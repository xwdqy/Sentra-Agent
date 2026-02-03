import { Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import styles from './QqSandbox.module.css';
import type { Conversation } from './QqSandbox.types';

export function RightPanel(props: {
  active: Conversation;
  rightPanelOpen: boolean;
  activeGroupInfo: null | { title: string; avatarUrl?: string };
  activeGroupMembers: any[];
  membersBusy: boolean;
  memberSearch: string;
  setMemberSearch: (v: string) => void;
  insertAtMember: (m: any) => void;
  isAvatarBroken: (key: string) => boolean;
  avatarKey: (kind: 'user' | 'group', id: number) => string;
  markAvatarBroken: (key: string) => void;
  avatarUrlForUser: (uid: number) => string;
}) {
  const {
    active,
    rightPanelOpen,
    activeGroupInfo,
    activeGroupMembers,
    membersBusy,
    memberSearch,
    setMemberSearch,
    insertAtMember,
    isAvatarBroken,
    avatarKey,
    markAvatarBroken,
    avatarUrlForUser,
  } = props;

  if (!rightPanelOpen) return null;
  if (!active || active.kind !== 'group') return null;

  return (
    <div className={styles.rightPanel}>
      <div className={styles.rightSection}>
        <div className={styles.groupCard}>
          <div className={styles.groupAvatar}>
            {activeGroupInfo?.avatarUrl && !isAvatarBroken(avatarKey('group', Number(active.targetId || 0))) ? (
              <img
                className={styles.groupAvatarImg}
                src={activeGroupInfo.avatarUrl}
                alt=""
                loading="lazy"
                onError={() => markAvatarBroken(avatarKey('group', Number(active.targetId || 0)))}
              />
            ) : null}
          </div>
          <div className={styles.groupMeta}>
            <div className={styles.groupName} title={activeGroupInfo?.title || active.title}>{activeGroupInfo?.title || active.title}</div>
            <div className={styles.groupSub}>群号 {active.targetId}</div>
          </div>
        </div>
      </div>

      <div className={styles.rightSection}>
        <div className={styles.rightTitleRow}>
          <div className={styles.rightTitle}>群聊成员 {activeGroupMembers.length}</div>
        </div>

        <div className={styles.memberSearchRow}>
          <Input
            size="small"
            allowClear
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            prefix={<SearchOutlined />}
            placeholder="搜索成员"
          />
        </div>

        <div className={styles.memberList}>
          {activeGroupMembers.map((m: any) => {
            const mm: any = m?.data || m;
            const uid = Number(mm?.user_id || 0);
            const nickname = String(mm?.nickname || '');
            const card = String(mm?.card || '');
            const role = String(mm?.role || '').toLowerCase();
            const title = card || nickname || (uid ? `QQ ${uid}` : '');
            const roleLabel = role === 'owner' ? '群主' : role === 'admin' ? '管理员' : '';
            const aKey = avatarKey('user', uid);
            const url = uid ? avatarUrlForUser(uid) : '';
            return (
              <div key={String(uid) + String(title)} className={styles.memberItem} onClick={() => insertAtMember(m)}>
                <div className={styles.memberAvatar}>
                  {url && aKey && !isAvatarBroken(aKey) ? (
                    <img className={styles.memberAvatarImg} src={url} alt="" loading="lazy" onError={() => markAvatarBroken(aKey)} />
                  ) : null}
                </div>
                <div className={styles.memberMeta}>
                  <div className={styles.memberName} title={title}>{title}</div>
                </div>
                {roleLabel ? <span className={styles.memberRole}>{roleLabel}</span> : null}
              </div>
            );
          })}

          {activeGroupMembers.length === 0 ? (
            <div className={styles.memberEmpty}>{membersBusy ? '加载中...' : '暂无成员数据'}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
