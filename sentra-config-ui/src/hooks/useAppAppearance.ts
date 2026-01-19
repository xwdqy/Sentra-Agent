import { useEffect } from 'react';
import { storage } from '../utils/storage';

function normalizeHexColor(v: string) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  const m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split('');
    return (`#${r}${r}${g}${g}${b}${b}`).toUpperCase();
  }
  return '';
}

function hexToRgb(hex: string) {
  const v = normalizeHexColor(hex);
  if (!v) return null;
  const n = parseInt(v.slice(1), 16);
  if (!Number.isFinite(n)) return null;
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}

function getContrastColor(rgb: { r: number; g: number; b: number }) {
  const l = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return l > 0.65 ? '#000000' : '#FFFFFF';
}

type UseAppAppearanceParams = {
  theme: 'light' | 'dark';
  accentColor: string;
};

export function useAppAppearance(params: UseAppAppearanceParams) {
  const { theme, accentColor } = params;

  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-theme', theme);
      document.body.setAttribute('data-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    const next = normalizeHexColor(accentColor) || '#007AFF';
    const rgb = hexToRgb(next);
    if (!rgb) return;
    const contrast = getContrastColor(rgb);

    try {
      storage.setString('sentra_accent_color', next);
    } catch {
      // ignore
    }

    try {
      const rgbStr = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
      document.documentElement.style.setProperty('--sentra-accent', next);
      document.documentElement.style.setProperty('--sentra-accent-rgb', rgbStr);
      document.documentElement.style.setProperty('--sentra-accent-contrast', contrast);
      document.body.style.setProperty('--sentra-accent', next);
      document.body.style.setProperty('--sentra-accent-rgb', rgbStr);
      document.body.style.setProperty('--sentra-accent-contrast', contrast);
    } catch {
      // ignore
    }
  }, [accentColor]);
}
