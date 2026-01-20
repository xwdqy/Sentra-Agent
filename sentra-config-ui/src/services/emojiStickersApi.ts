import { getAuthHeaders } from './api';

const API_BASE = '/api/emoji-stickers';

export type EmojiStickerItem = {
  filename: string;
  description: string;
  category?: string;
  tags?: string[];
  enabled?: boolean;
};

export type EmojiStickerFile = {
  filename: string;
  size: number;
  modified: string;
};

export async function fetchEmojiStickersStatus() {
  const res = await fetch(`${API_BASE}/status`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function ensureEmojiStickers() {
  const res = await fetch(`${API_BASE}/ensure`, { method: 'POST', headers: getAuthHeaders(), body: '{}' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchEmojiStickersItems(): Promise<{ files: EmojiStickerFile[]; items: EmojiStickerItem[] }> {
  const res = await fetch(`${API_BASE}/items`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveEmojiStickersItems(params: { items: EmojiStickerItem[]; applyEnv?: boolean }) {
  const res = await fetch(`${API_BASE}/items`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ items: params.items, applyEnv: !!params.applyEnv }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function applyEmojiStickersEnv() {
  const res = await fetch(`${API_BASE}/apply-env`, { method: 'POST', headers: getAuthHeaders(), body: '{}' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function uploadEmojiSticker(params: {
  filename: string;
  dataUrl: string;
  compress?: boolean;
  maxDim?: number;
  quality?: number;
}) {
  const res = await fetch(`${API_BASE}/upload`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      filename: params.filename,
      dataUrl: params.dataUrl,
      compress: !!params.compress,
      maxDim: params.maxDim,
      quality: params.quality,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteEmojiStickerFile(filename: string) {
  const res = await fetch(`${API_BASE}/file?filename=${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: getAuthHeaders({ json: false }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function renameEmojiStickerFile(params: { from: string; to: string }) {
  const res = await fetch(`${API_BASE}/rename`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ from: params.from, to: params.to }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
