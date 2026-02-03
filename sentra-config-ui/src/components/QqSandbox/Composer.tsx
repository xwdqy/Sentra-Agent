import type { ChangeEvent, Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { Button, Dropdown, Input, Popover, Spin, Tabs, Tooltip, Upload } from 'antd';
import {
  CloseOutlined,
  DownOutlined,
  PaperClipOutlined,
  PictureOutlined,
  ReloadOutlined,
  SmileOutlined,
} from '@ant-design/icons';
import styles from './QqSandbox.module.css';
import type { Conversation } from './QqSandbox.types';

export function Composer(props: {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  active: Conversation | null;

  replyDraft: null | { messageId: number; senderName: string; text: string };
  setReplyDraft: Dispatch<SetStateAction<null | { messageId: number; senderName: string; text: string }>>;

  composerToolbarRef: RefObject<HTMLDivElement>;
  textareaRef: RefObject<any>;

  emojiOpen: boolean;
  setEmojiOpen: Dispatch<SetStateAction<boolean>>;
  emojiTab: string;
  setEmojiTab: Dispatch<SetStateAction<string>>;
  basicEmojis: string[];

  loadStickers: (force?: boolean) => Promise<void>;
  stickersLoading: boolean;
  stickers: Array<{ filename: string; description: string; enabled?: boolean; tags?: string[] }>;
  buildEmojiStickerUrl: (filename: string, opts?: { thumb?: boolean }) => string;
  addStickerToDraft: (filename: string) => Promise<void>;

  addPendingAttachment: (file: File, kind: 'image' | 'file') => void;
  pendingAttachments: Array<{ id: string; kind: 'image' | 'file'; file: File; name: string; size: number; previewUrl?: string }>;
  setPendingAttachments: Dispatch<SetStateAction<Array<{ id: string; kind: 'image' | 'file'; file: File; name: string; size: number; previewUrl?: string }>>>;
  setImgPreviewSrc: Dispatch<SetStateAction<string>>;
  setImgPreviewOpen: Dispatch<SetStateAction<boolean>>;

  sendText: string;
  setSendText: Dispatch<SetStateAction<string>>;

  insertTextAtCursor: (insert: string) => void;

  sendHotkey: 'enter' | 'ctrl_enter' | 'shift_enter';
  setSendHotkey: Dispatch<SetStateAction<'enter' | 'ctrl_enter' | 'shift_enter'>>;

  membersBusy: boolean;
  loadGroupMembers: (gid: number, opts?: { force?: boolean }) => void;

  clearComposer: () => void;
  sendMessage: () => Promise<void>;
}) {
  const {
    status,
    active,
    replyDraft,
    setReplyDraft,
    composerToolbarRef,
    textareaRef,
    emojiOpen,
    setEmojiOpen,
    emojiTab,
    setEmojiTab,
    basicEmojis,
    loadStickers,
    stickersLoading,
    stickers,
    buildEmojiStickerUrl,
    addStickerToDraft,
    addPendingAttachment,
    pendingAttachments,
    setPendingAttachments,
    setImgPreviewSrc,
    setImgPreviewOpen,
    sendText,
    setSendText,
    insertTextAtCursor,
    sendHotkey,
    setSendHotkey,
    membersBusy,
    loadGroupMembers,
    clearComposer,
    sendMessage,
  } = props;

  return (
    <div className={`${styles.composer} ${replyDraft ? styles.composerWithReply : ''}`}>
      {replyDraft ? (
        <div className={styles.replyDraft}>
          <div className={styles.replyDraftText}>
            回复 {replyDraft.senderName}: {replyDraft.text}
          </div>
          <Button className={styles.replyDraftClose} type="text" icon={<CloseOutlined />} onClick={() => setReplyDraft(null)} />
        </div>
      ) : null}

      <div className={styles.composerToolbar} ref={composerToolbarRef}>
        <Popover
          open={emojiOpen}
          onOpenChange={(open) => {
            setEmojiOpen(open);
            if (open) void loadStickers();
          }}
          trigger={['click']}
          placement="topLeft"
          overlayClassName={styles.emojiPopover}
          rootClassName={styles.emojiPopover}
          overlayStyle={{ maxHeight: 'min(420px, calc(100vh - 220px))' }}
          getPopupContainer={(node) => (composerToolbarRef.current || node?.parentElement || document.body)}
          content={
            <div className={styles.emojiPanel}>
              <Tabs
                size="small"
                activeKey={emojiTab}
                onChange={(k) => setEmojiTab(String(k || 'emoji'))}
                items={[
                  {
                    key: 'emoji',
                    label: '表情',
                    children: (
                      <div className={styles.emojiGrid}>
                        {basicEmojis.map((e) => (
                          <button
                            key={e}
                            type="button"
                            className={styles.emojiCell}
                            onClick={() => {
                              insertTextAtCursor(e);
                              setEmojiOpen(false);
                            }}
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    ),
                  },
                  {
                    key: 'stickers',
                    label: '贴纸',
                    children: (
                      <div className={styles.stickerPanel}>
                        {stickersLoading ? (
                          <div className={styles.emojiLoading}><Spin size="small" /></div>
                        ) : (
                          <div className={styles.stickerGrid}>
                            {(stickers || []).slice(0, 240).map((it) => (
                              <button
                                key={it.filename}
                                type="button"
                                className={styles.stickerCell}
                                title={it.description || it.filename}
                                onClick={() => void addStickerToDraft(it.filename)}
                              >
                                <img className={styles.stickerImg} src={buildEmojiStickerUrl(it.filename, { thumb: true })} alt="" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          }
        >
          <Tooltip title="表情">
            <Button className={styles.toolBtn} type="text" disabled={status !== 'connected' || !active} icon={<SmileOutlined />} />
          </Tooltip>
        </Popover>

        <Upload
          multiple
          accept="image/*"
          showUploadList={false}
          beforeUpload={(file) => {
            addPendingAttachment(file as any, 'image');
            return false;
          }}
        >
          <Tooltip title="图片">
            <Button className={styles.toolBtn} type="text" disabled={status !== 'connected' || !active} icon={<PictureOutlined />} />
          </Tooltip>
        </Upload>

        <Upload
          multiple
          showUploadList={false}
          beforeUpload={(file) => {
            addPendingAttachment(file as any, 'file');
            return false;
          }}
        >
          <Tooltip title="文件">
            <Button className={styles.toolBtn} type="text" disabled={status !== 'connected' || !active} icon={<PaperClipOutlined />} />
          </Tooltip>
        </Upload>

        <div className={styles.toolSpacer} />

        {active && active.kind === 'group' ? (
          <Tooltip title="刷新成员列表">
            <Button
              className={styles.toolBtn}
              type="text"
              disabled={status !== 'connected' || membersBusy}
              icon={<ReloadOutlined />}
              onClick={() => void loadGroupMembers(active.targetId, { force: true })}
            />
          </Tooltip>
        ) : null}
      </div>

      <div className={styles.composerMain}>
        {pendingAttachments.length > 0 ? (
          <div className={styles.pendingBar}>
            {pendingAttachments.map((a) => (
              <div key={a.id} className={styles.pendingItem}>
                {a.kind === 'image' && a.previewUrl ? (
                  <img
                    className={styles.pendingThumb}
                    src={a.previewUrl}
                    alt=""
                    onClick={() => {
                      setImgPreviewSrc(a.previewUrl || '');
                      setImgPreviewOpen(true);
                    }}
                  />
                ) : (
                  <div className={styles.pendingIcon}>{a.kind === 'image' ? <PictureOutlined /> : <PaperClipOutlined />}</div>
                )}
                <div className={styles.pendingName} title={a.name}>{a.name}</div>
                <Button
                  className={styles.pendingRemove}
                  type="text"
                  icon={<CloseOutlined />}
                  onClick={() => {
                    setPendingAttachments((prev) => {
                      const next = (prev || []).filter((x) => x.id !== a.id);
                      try { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); } catch { }
                      return next;
                    });
                  }}
                />
              </div>
            ))}
          </div>
        ) : null}

        <Input.TextArea
          ref={textareaRef}
          className={styles.textarea}
          placeholder="输入消息..."
          value={sendText}
          autoSize={{ minRows: 4, maxRows: 10 }}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSendText(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key !== 'Enter') return;
            if (e.altKey || e.metaKey) return;
            if (sendHotkey === 'enter') {
              if (!e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                void sendMessage();
              }
              return;
            }
            if (sendHotkey === 'ctrl_enter') {
              if (e.ctrlKey && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
              return;
            }
            if (sendHotkey === 'shift_enter') {
              if (e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                void sendMessage();
              }
            }
          }}
        />

        <div className={styles.composerFooterRow}>
          <Button className={styles.sendCloseBtn} onClick={() => clearComposer()}>关闭</Button>

          <div className={styles.sendGroup}>
            <Button
              type="primary"
              className={styles.sendBtnMain}
              disabled={status !== 'connected' || !active || (!String(sendText || '').trim() && pendingAttachments.length === 0)}
              onClick={() => void sendMessage()}
            >
              发送
            </Button>
            <Dropdown
              trigger={['click']}
              menu={{
                selectable: true,
                selectedKeys: [sendHotkey],
                items: [
                  { key: 'enter', label: 'Enter 发送' },
                  { key: 'ctrl_enter', label: 'Ctrl+Enter 发送' },
                  { key: 'shift_enter', label: 'Shift+Enter 发送' },
                ],
                onClick: (info) => setSendHotkey(info.key as any),
              }}
            >
              <Button type="primary" className={styles.sendBtnMore} icon={<DownOutlined />} disabled={status !== 'connected'} />
            </Dropdown>
          </div>
        </div>
      </div>
    </div>
  );
}
