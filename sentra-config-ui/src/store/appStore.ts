import { create } from 'zustand';
import type { ConfigData } from '../types/config';

type AppStore = {
  isAuthenticated: boolean;
  serverReady: boolean;
  configData: ConfigData | null;
  setIsAuthenticated: (v: boolean) => void;
  setServerReady: (v: boolean) => void;
  setConfigData: (v: ConfigData | null) => void;
};

export const useAppStore = create<AppStore>((set) => {
  return {
    isAuthenticated: false,
    serverReady: false,
    configData: null,
    setIsAuthenticated: (v: boolean) => set({ isAuthenticated: v }),
    setServerReady: (v: boolean) => set({ serverReady: v }),
    setConfigData: (v: ConfigData | null) => set({ configData: v }),
  };
});
