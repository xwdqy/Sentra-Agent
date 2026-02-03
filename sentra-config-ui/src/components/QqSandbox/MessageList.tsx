import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Button, Tooltip } from 'antd';
import { CopyOutlined, MessageOutlined, PictureOutlined } from '@ant-design/icons';
import styles from './QqSandbox.module.css';
import type { Conversation, FormattedMessage } from './QqSandbox.types';

export function MessageList(props: {
  active: Conversation | null;
  activeMessages: FormattedMessage[];
  renderLimit: number;
  defaultRenderPageStep: number;
  setRenderLimit: Dispatch<SetStateAction<number>>;
  messagesEndRef: RefObject<HTMLDivElement>;
  hoverKey: string | null;
  setHoverKey: Dispatch<SetStateAction<string | null>>;

  selfId: number;
  avatarUrlForUser: (uid: number) => string;
  isAvatarBroken: (key: string) => boolean;
  avatarKey: (kind: 'user' | 'group', id: number) => string;
  markAvatarBroken: (key: string) => void;
  pickInitials: (s: string) => string;

  formatTimeShort: (ms: number) => string;
  nowMsFromMsg: (m: FormattedMessage) => number;
  formatSenderDisplay: (m: FormattedMessage, isMe: boolean) => { displayName: string; roleLabel: string };
  pickFirstImageUrl: (m: FormattedMessage) => string;
  getMessageMarkdown: (m: FormattedMessage, msgKey: string) => string;
  toPlainSingleLine: (s: string) => string;
  parseCqImageCandidates: (raw: string) => Array<{ url?: string; path?: string; summary?: string }>;

  copyText: (s: string) => Promise<void>;
  copyImageFromUrl: (u: string) => Promise<void>;
  setReplyDraft: (v: null | { messageId: number; senderName: string; text: string }) => void;

  renderMarkdown: (md: string) => any;
  renderAttachments: (m: FormattedMessage) => any;
  renderReplyBox: (m: FormattedMessage) => any;
}) {
  const {
    active,
    activeMessages,
    renderLimit,
    defaultRenderPageStep,
    setRenderLimit,
    messagesEndRef,
    hoverKey,
    setHoverKey,
    selfId,
    avatarUrlForUser,
    isAvatarBroken,
    avatarKey,
    markAvatarBroken,
    pickInitials,
    formatTimeShort,
    nowMsFromMsg,
    formatSenderDisplay,
    pickFirstImageUrl,
    getMessageMarkdown,
    toPlainSingleLine,
    parseCqImageCandidates,
    copyText,
    copyImageFromUrl,
    setReplyDraft,
    renderMarkdown,
    renderAttachments,
    renderReplyBox,
  } = props;

  if (!active) {
    return <div className={styles.empty}>选择一个会话。</div>;
  }

  return (
    <>
      {activeMessages.length > renderLimit && (
        <div className={styles.loadMoreRow}>
          <Button className={styles.loadMoreBtn} onClick={() => setRenderLimit((v) => v + defaultRenderPageStep)}>
            加载更多
          </Button>
        </div>
      )}

      {activeMessages.slice(Math.max(0, activeMessages.length - renderLimit)).map((m) => {
        const msgKey = `${m.message_id}-${m.time}`;
        const knownSelfId = Number(selfId || 0);
        const selfIdFromMsg = Number((m as any).self_id || 0);
        const myId = (Number.isFinite(selfIdFromMsg) && selfIdFromMsg > 0) ? selfIdFromMsg : (Number.isFinite(knownSelfId) && knownSelfId > 0 ? knownSelfId : 0);
        const isMe =
          (Number.isFinite(selfIdFromMsg) && selfIdFromMsg > 0 && Number(m.sender_id) === selfIdFromMsg) ||
          (Number.isFinite(knownSelfId) && knownSelfId > 0 && Number(m.sender_id) === knownSelfId) ||
          String(m.sender_name || '').trim() === '我' ||
          String((m as any).sender_card || '').trim() === '我';

        const { displayName, roleLabel } = formatSenderDisplay(m, isMe);
        const avatarUrl = isMe ? avatarUrlForUser(myId) : avatarUrlForUser(Number(m.sender_id || 0));
        const md = getMessageMarkdown(m, msgKey);

        if (String((m as any)?.event_type || '') === 'poke') {
          const target = String((m as any)?.target_name || (m as any)?.target_id || '');
          const text = `${displayName} 戳了戳 ${target || '你'}`;
          return (
            <div key={msgKey} className={styles.sysRow}>
              <div className={styles.sysLine}>{text}</div>
            </div>
          );
        }

        const firstImg = pickFirstImageUrl(m);
        const showActions = hoverKey === msgKey;

        const hasAttachments =
          (Array.isArray((m as any)?.images) && (m as any).images.length > 0) ||
          (Array.isArray((m as any)?.videos) && (m as any).videos.length > 0) ||
          (Array.isArray((m as any)?.records) && (m as any).records.length > 0) ||
          (Array.isArray((m as any)?.files) && (m as any).files.length > 0) ||
          (Array.isArray((m as any)?.cards) && (m as any).cards.length > 0) ||
          (Array.isArray((m as any)?.forwards) && (m as any).forwards.length > 0) ||
          parseCqImageCandidates(String((m as any)?.text || '') + '\n' + String((m as any)?.summary || '') + '\n' + String((m as any)?.objective || '')).length > 0 ||
          (Array.isArray((m as any)?.segments) && (m as any).segments.some((s: any) => {
            const t = String(s?.type || '');
            return t === 'image' || t === 'file';
          }));
        const hasReply = !!(m as any)?.reply?.text;
        if (!String(md || '').trim() && !hasAttachments && !hasReply) {
          return null;
        }

        return (
          <div
            key={msgKey}
            className={`${styles.msgRow} ${isMe ? styles.msgRowMe : ''}`}
            onMouseEnter={() => setHoverKey(msgKey)}
            onMouseLeave={() => setHoverKey((prev) => (prev === msgKey ? null : prev))}
          >
            <div className={styles.msgAvatar}>
              {(() => {
                const senderId = isMe ? myId : Number(m.sender_id || 0);
                const aKey = avatarKey('user', senderId);
                return avatarUrl && aKey && !isAvatarBroken(aKey) ? (
                  <img className={styles.msgAvatarImg} src={avatarUrl} alt="" loading="lazy" onError={() => markAvatarBroken(aKey)} />
                ) : (
                  <div className={styles.msgAvatarFallback}>{pickInitials(displayName)}</div>
                );
              })()}
            </div>
            <div className={styles.msgBody}>
              <div className={styles.msgMeta}>
                <span className={styles.msgWho}>{displayName}</span>
                {roleLabel && m.type === 'group' ? <span className={styles.roleBadge}>{roleLabel}</span> : null}
                <span className={styles.msgDot}>·</span>
                <span className={styles.msgTime}>{m.time_str || formatTimeShort(nowMsFromMsg(m))}</span>
              </div>
              <div className={`${styles.bubble} ${isMe ? styles.bubbleMe : ''}`}>
                {showActions && (
                  <div className={styles.msgActions}>
                    <Tooltip title="复制">
                      <Button className={styles.actionBtn} type="text" icon={<CopyOutlined />} onClick={() => void copyText(md)} />
                    </Tooltip>
                    {firstImg ? (
                      <Tooltip title="复制图片">
                        <Button className={styles.actionBtn} type="text" icon={<PictureOutlined />} onClick={() => void copyImageFromUrl(firstImg)} />
                      </Tooltip>
                    ) : null}
                    <Tooltip title="引用回复">
                      <Button
                        className={styles.actionBtn}
                        type="text"
                        icon={<MessageOutlined />}
                        onClick={() => {
                          setReplyDraft({
                            messageId: Number(m.message_id || 0),
                            senderName: displayName,
                            text: toPlainSingleLine(md),
                          });
                        }}
                      />
                    </Tooltip>
                  </div>
                )}
                {renderReplyBox(m)}
                <div className={styles.md}>{renderMarkdown(md)}</div>
                {renderAttachments(m)}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={messagesEndRef} />
    </>
  );
}
