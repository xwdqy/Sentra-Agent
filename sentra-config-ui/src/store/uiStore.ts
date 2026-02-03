import { create } from 'zustand';
import type { ToastMessage } from '../components/Toast';
import { storage } from '../utils/storage';

type DialogType = 'info' | 'warning' | 'error';

type DialogConfig = {
  title: string;
  message: string;
  type: DialogType;
  onConfirm: () => void;
};

export type UIStore = {
  toasts: ToastMessage[];
  addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
  removeToast: (id: string) => void;

  saving: boolean;
  setSaving: (s: boolean) => void;

  loading: boolean;
  setLoading: (loading: boolean) => void;

  authChecking: boolean;
  setAuthChecking: (checking: boolean) => void;

  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;

  performanceModeOverride: 'auto' | 'on' | 'off';
  setPerformanceModeOverride: (v: 'auto' | 'on' | 'off') => void;

  accentColor: string;
  setAccentColor: (val: string) => void;

  showDock: boolean;
  toggleDock: () => void;

  launchpadOpen: boolean;
  setLaunchpadOpen: (open: boolean) => void;

  dialogOpen: boolean;
  dialogConfig: DialogConfig;
  setDialogOpen: (open: boolean) => void;
  setDialogConfig: (cfg: DialogConfig) => void;

  devCenterOpen: boolean;
  setDevCenterOpen: (open: boolean) => void;
  devCenterMinimized: boolean;
  setDevCenterMinimized: (min: boolean) => void;

  deepWikiOpen: boolean;
  setDeepWikiOpen: (open: boolean) => void;
  deepWikiMinimized: boolean;
  setDeepWikiMinimized: (min: boolean) => void;

  redisAdminOpen: boolean;
  setRedisAdminOpen: (open: boolean) => void;
  redisAdminMinimized: boolean;
  setRedisAdminMinimized: (min: boolean) => void;

  modelProvidersManagerOpen: boolean;
  setModelProvidersManagerOpen: (open: boolean) => void;
  modelProvidersManagerMinimized: boolean;
  setModelProvidersManagerMinimized: (min: boolean) => void;

  mcpServersManagerOpen: boolean;
  setMcpServersManagerOpen: (open: boolean) => void;
  mcpServersManagerMinimized: boolean;
  setMcpServersManagerMinimized: (min: boolean) => void;

  emojiStickersManagerOpen: boolean;
  setEmojiStickersManagerOpen: (open: boolean) => void;
  emojiStickersManagerMinimized: boolean;
  setEmojiStickersManagerMinimized: (min: boolean) => void;

  presetsEditorOpen: boolean;
  setPresetsEditorOpen: (open: boolean) => void;
  presetsEditorMinimized: boolean;
  setPresetsEditorMinimized: (min: boolean) => void;

  presetImporterOpen: boolean;
  setPresetImporterOpen: (open: boolean) => void;
  presetImporterMinimized: boolean;
  setPresetImporterMinimized: (min: boolean) => void;

  fileManagerOpen: boolean;
  setFileManagerOpen: (open: boolean) => void;
  fileManagerMinimized: boolean;
  setFileManagerMinimized: (min: boolean) => void;

  terminalManagerOpen: boolean;
  setTerminalManagerOpen: (open: boolean) => void;
  terminalManagerMinimized: boolean;
  setTerminalManagerMinimized: (min: boolean) => void;

  qqSandboxOpen: boolean;
  setQqSandboxOpen: (open: boolean) => void;
  qqSandboxMinimized: boolean;
  setQqSandboxMinimized: (min: boolean) => void;

  utilityFocusRequestId: string | null;
  utilityFocusRequestNonce: number;
  requestUtilityFocus: (id: string) => void;
  clearUtilityFocusRequest: () => void;

  iosPresetsEditorOpen: boolean;
  setIosPresetsEditorOpen: (open: boolean) => void;
  iosPresetImporterOpen: boolean;
  setIosPresetImporterOpen: (open: boolean) => void;
  iosFileManagerOpen: boolean;
  setIosFileManagerOpen: (open: boolean) => void;
  iosModelProvidersManagerOpen: boolean;
  setIosModelProvidersManagerOpen: (open: boolean) => void;
  iosEmojiStickersManagerOpen: boolean;
  setIosEmojiStickersManagerOpen: (open: boolean) => void;
  iosTerminalManagerOpen: boolean;
  setIosTerminalManagerOpen: (open: boolean) => void;
  iosRedisAdminOpen: boolean;
  setIosRedisAdminOpen: (open: boolean) => void;

  iosMcpServersManagerOpen: boolean;
  setIosMcpServersManagerOpen: (open: boolean) => void;
};

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

function readBool(key: string, fallback: boolean) {
  return storage.getBool(key, { fallback });
}

type SetState<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void;

export const useUIStore = create<UIStore>((set: SetState<UIStore>) => {
  const theme: 'light' | 'dark' = (() => {
    const raw = storage.getString('sentra_theme', { fallback: 'light' });
    return raw === 'dark' ? 'dark' : 'light';
  })();

  const performanceModeOverride: 'auto' | 'on' | 'off' = (() => {
    const raw = storage.getString('sentra_performance_mode_override', { fallback: 'auto' });
    if (raw === 'on' || raw === 'off') return raw;
    return 'auto';
  })();

  const accentColor = (() => {
    const saved = normalizeHexColor(storage.getString('sentra_accent_color', { fallback: '' }));
    return saved || '#007AFF';
  })();

  return {
    toasts: [],
    addToast: (type: ToastMessage['type'], title: string, message?: string) => {
      const id = Math.random().toString(36).substr(2, 9);
      set((s: UIStore) => ({ toasts: [...s.toasts, { id, type, title, message }] }));
    },
    removeToast: (id: string) => set((s: UIStore) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    saving: false,
    setSaving: (s: boolean) => set({ saving: s }),

    loading: true,
    setLoading: (loading: boolean) => set({ loading }),

    authChecking: true,
    setAuthChecking: (checking: boolean) => set({ authChecking: checking }),

    theme,
    setTheme: (next: 'light' | 'dark') => {
      storage.setString('sentra_theme', next);
      set({ theme: next });
    },

    performanceModeOverride,
    setPerformanceModeOverride: (v: 'auto' | 'on' | 'off') => {
      storage.setString('sentra_performance_mode_override', v);
      set({ performanceModeOverride: v });
    },

    accentColor,
    setAccentColor: (val: string) => {
      const next = normalizeHexColor(val) || '#007AFF';
      storage.setString('sentra_accent_color', next);
      set({ accentColor: next });
    },

    showDock: readBool('sentra_show_dock', true),
    toggleDock: () => {
      set((s: UIStore) => {
        const next = !s.showDock;
        storage.setBool('sentra_show_dock', next);
        return { showDock: next };
      });
    },

    launchpadOpen: false,
    setLaunchpadOpen: (open: boolean) => set({ launchpadOpen: open }),

    dialogOpen: false,
    dialogConfig: { title: '', message: '', type: 'info', onConfirm: () => { } },
    setDialogOpen: (open: boolean) => set({ dialogOpen: open }),
    setDialogConfig: (cfg: DialogConfig) => set({ dialogConfig: cfg }),

    devCenterOpen: readBool('sentra_dev_center_open', false),
    setDevCenterOpen: (open: boolean) => {
      storage.setBool('sentra_dev_center_open', open);
      set({ devCenterOpen: open });
    },
    devCenterMinimized: readBool('sentra_dev_center_minimized', false),
    setDevCenterMinimized: (min: boolean) => {
      storage.setBool('sentra_dev_center_minimized', min);
      set({ devCenterMinimized: min });
    },

    deepWikiOpen: readBool('sentra_deepwiki_open', false),
    setDeepWikiOpen: (open: boolean) => {
      storage.setBool('sentra_deepwiki_open', open);
      set({ deepWikiOpen: open });
    },
    deepWikiMinimized: readBool('sentra_deepwiki_minimized', false),
    setDeepWikiMinimized: (min: boolean) => {
      storage.setBool('sentra_deepwiki_minimized', min);
      set({ deepWikiMinimized: min });
    },

    redisAdminOpen: readBool('sentra_redis_admin_open', false),
    setRedisAdminOpen: (open: boolean) => {
      storage.setBool('sentra_redis_admin_open', open);
      set({ redisAdminOpen: open });
    },
    redisAdminMinimized: readBool('sentra_redis_admin_minimized', false),
    setRedisAdminMinimized: (min: boolean) => {
      storage.setBool('sentra_redis_admin_minimized', min);
      set({ redisAdminMinimized: min });
    },

    modelProvidersManagerOpen: readBool('sentra_model_providers_manager_open', false),
    setModelProvidersManagerOpen: (open: boolean) => {
      storage.setBool('sentra_model_providers_manager_open', open);
      set({ modelProvidersManagerOpen: open });
    },
    modelProvidersManagerMinimized: readBool('sentra_model_providers_manager_minimized', false),
    setModelProvidersManagerMinimized: (min: boolean) => {
      storage.setBool('sentra_model_providers_manager_minimized', min);
      set({ modelProvidersManagerMinimized: min });
    },

    mcpServersManagerOpen: readBool('sentra_mcp_servers_manager_open', false),
    setMcpServersManagerOpen: (open: boolean) => {
      storage.setBool('sentra_mcp_servers_manager_open', open);
      set({ mcpServersManagerOpen: open });
    },
    mcpServersManagerMinimized: readBool('sentra_mcp_servers_manager_minimized', false),
    setMcpServersManagerMinimized: (min: boolean) => {
      storage.setBool('sentra_mcp_servers_manager_minimized', min);
      set({ mcpServersManagerMinimized: min });
    },

    emojiStickersManagerOpen: readBool('sentra_emoji_stickers_manager_open', false),
    setEmojiStickersManagerOpen: (open: boolean) => {
      storage.setBool('sentra_emoji_stickers_manager_open', open);
      set({ emojiStickersManagerOpen: open });
    },
    emojiStickersManagerMinimized: readBool('sentra_emoji_stickers_manager_minimized', false),
    setEmojiStickersManagerMinimized: (min: boolean) => {
      storage.setBool('sentra_emoji_stickers_manager_minimized', min);
      set({ emojiStickersManagerMinimized: min });
    },

    presetsEditorOpen: readBool('sentra_presets_editor_open', false),
    setPresetsEditorOpen: (open: boolean) => {
      storage.setBool('sentra_presets_editor_open', open);
      set({ presetsEditorOpen: open });
    },
    presetsEditorMinimized: readBool('sentra_presets_editor_minimized', false),
    setPresetsEditorMinimized: (min: boolean) => {
      storage.setBool('sentra_presets_editor_minimized', min);
      set({ presetsEditorMinimized: min });
    },

    presetImporterOpen: readBool('sentra_preset_importer_open', false),
    setPresetImporterOpen: (open: boolean) => {
      storage.setBool('sentra_preset_importer_open', open);
      set({ presetImporterOpen: open });
    },
    presetImporterMinimized: readBool('sentra_preset_importer_minimized', false),
    setPresetImporterMinimized: (min: boolean) => {
      storage.setBool('sentra_preset_importer_minimized', min);
      set({ presetImporterMinimized: min });
    },

    fileManagerOpen: readBool('sentra_file_manager_open', false),
    setFileManagerOpen: (open: boolean) => {
      storage.setBool('sentra_file_manager_open', open);
      set({ fileManagerOpen: open });
    },
    fileManagerMinimized: readBool('sentra_file_manager_minimized', false),
    setFileManagerMinimized: (min: boolean) => {
      storage.setBool('sentra_file_manager_minimized', min);
      set({ fileManagerMinimized: min });
    },

    terminalManagerOpen: readBool('sentra_terminal_manager_open', false),
    setTerminalManagerOpen: (open: boolean) => {
      storage.setBool('sentra_terminal_manager_open', open);
      set({ terminalManagerOpen: open });
    },
    terminalManagerMinimized: readBool('sentra_terminal_manager_minimized', false),
    setTerminalManagerMinimized: (min: boolean) => {
      storage.setBool('sentra_terminal_manager_minimized', min);
      set({ terminalManagerMinimized: min });
    },

    qqSandboxOpen: readBool('sentra_qq_sandbox_open', false),
    setQqSandboxOpen: (open: boolean) => {
      storage.setBool('sentra_qq_sandbox_open', open);
      set({ qqSandboxOpen: open });
    },
    qqSandboxMinimized: readBool('sentra_qq_sandbox_minimized', false),
    setQqSandboxMinimized: (min: boolean) => {
      storage.setBool('sentra_qq_sandbox_minimized', min);
      set({ qqSandboxMinimized: min });
    },

    utilityFocusRequestId: null,
    utilityFocusRequestNonce: 0,
    requestUtilityFocus: (id: string) => {
      set((s: UIStore) => ({
        utilityFocusRequestId: id,
        utilityFocusRequestNonce: (s.utilityFocusRequestNonce || 0) + 1,
      }));
    },
    clearUtilityFocusRequest: () => set({ utilityFocusRequestId: null }),

    iosPresetsEditorOpen: false,
    setIosPresetsEditorOpen: (open: boolean) => set({ iosPresetsEditorOpen: open }),
    iosPresetImporterOpen: false,
    setIosPresetImporterOpen: (open: boolean) => set({ iosPresetImporterOpen: open }),
    iosFileManagerOpen: false,
    setIosFileManagerOpen: (open: boolean) => set({ iosFileManagerOpen: open }),
    iosModelProvidersManagerOpen: false,
    setIosModelProvidersManagerOpen: (open: boolean) => set({ iosModelProvidersManagerOpen: open }),
    iosEmojiStickersManagerOpen: false,
    setIosEmojiStickersManagerOpen: (open: boolean) => set({ iosEmojiStickersManagerOpen: open }),
    iosTerminalManagerOpen: false,
    setIosTerminalManagerOpen: (open: boolean) => set({ iosTerminalManagerOpen: open }),
    iosRedisAdminOpen: false,
    setIosRedisAdminOpen: (open: boolean) => set({ iosRedisAdminOpen: open }),

    iosMcpServersManagerOpen: false,
    setIosMcpServersManagerOpen: (open: boolean) => set({ iosMcpServersManagerOpen: open }),
  };
});
