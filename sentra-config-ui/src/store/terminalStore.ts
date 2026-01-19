import { create } from 'zustand';
import type { TerminalWin } from '../types/ui';
import { storage } from '../utils/storage';

type SetTerminalWindows = (next: TerminalWin[] | ((prev: TerminalWin[]) => TerminalWin[])) => void;

type TerminalStore = {
  terminalWindows: TerminalWin[];
  activeTerminalId: string | null;
  setTerminalWindows: SetTerminalWindows;
  setActiveTerminalId: (id: string | null) => void;
};

let cleaned = false;
function ensureLegacyCleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    storage.remove('sentra_terminal_windows');
    storage.remove('sentra_active_terminal_id');
  } catch {
    // ignore
  }
}

export const useTerminalStore = create<TerminalStore>((set) => {
  ensureLegacyCleanup();

  const setTerminalWindows: SetTerminalWindows = (next) => {
    set(prev => ({
      ...prev,
      terminalWindows: typeof next === 'function' ? (next as any)(prev.terminalWindows) : next,
    }));
  };

  return {
    terminalWindows: [],
    activeTerminalId: null,
    setTerminalWindows,
    setActiveTerminalId: (id: string | null) => set({ activeTerminalId: id }),
  };
});
