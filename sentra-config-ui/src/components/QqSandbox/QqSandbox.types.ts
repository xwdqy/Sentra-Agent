export type StreamEnvelope =
  | { type: 'welcome'; message?: string; time?: number }
  | { type: 'pong'; time?: number }
  | { type: 'message'; data: FormattedMessage }
  | { type: 'result'; requestId: string; ok: boolean; data?: any; error?: string }
  | { type: 'proxy'; event?: string; time?: number; upstream?: any;[k: string]: any }
  | { type: 'disconnect'; message?: string }
  | { type: 'error'; message?: string }
  | { type: string;[k: string]: any };

export type FormattedMessage = {
  message_id: number;
  time: number;
  time_str: string;
  type: 'private' | 'group';
  event_type?: string;
  target_id?: number;
  target_name?: string;
  self_id?: number;
  peer_id?: number;
  sender_id: number;
  sender_name: string;
  sender_card?: string;
  sender_role?: 'owner' | 'admin' | 'member' | string;
  group_id?: number;
  group_name?: string;
  text: string;
  summary: string;
  objective?: string;
  images?: Array<{ url?: string; summary?: string; path?: string }>;
  videos?: Array<{ url?: string; path?: string; file?: string }>;
  records?: Array<{ url?: string; path?: string; file?: string; format?: string; file_size?: any }>;
  files?: Array<{ url?: string; path?: string; name?: string; size?: any; file_id?: any }>;
  forwards?: Array<{ id?: string | number; message_id?: any; count?: number; preview?: string[]; nodes?: any[] }>;
  cards?: Array<{ type: string; title?: string; url?: string; content?: string; image?: string; source?: string; raw?: any; preview?: string }>;
  faces?: Array<{ id?: string; text?: string }>;
  at_users?: number[];
  at_all?: boolean;
  segments?: Array<{ type: string; data?: any }>;
  reply?: {
    id?: any;
    text?: string;
    sender_name?: string;
    sender_id?: number;
    media?: any;
  };
};

export type Conversation = {
  key: string;
  kind: 'group' | 'private';
  targetId: number;
  title: string;
  avatarUrl?: string;
  lastTime: number;
  lastPreview: string;
  unread: number;
  messages: FormattedMessage[];
  historyCursor?: number;
  historyLoaded?: boolean;
};
