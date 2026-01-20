import type { ReactNode } from 'react';
import type { ModuleConfig, PluginConfig, EnvVariable } from './config';

export type FileItem = (ModuleConfig | PluginConfig) & { type: 'module' | 'plugin' };

export type DeskWindow = {
  id: string;
  file: FileItem;
  pos?: { x: number; y: number };
  size?: { width: number; height: number };
  z: number;
  minimized: boolean;
  editedVars: EnvVariable[];
  maximized?: boolean;
};

export type TerminalWin = {
  id: string;
  title: string;
  processId: string;
  appKey: string;
  pos: { x: number; y: number };
  size?: { width: number; height: number };
  z: number;
  minimized: boolean;
  maximized?: boolean;
  theme?: any; // ITheme from xterm is not exported here, using any for now or need to import
  headerText?: string;
};

export type DesktopIcon = {
  id: string;
  name: string;
  icon: ReactNode;
  position: { x: number; y: number };
  onClick: () => void;
};

export type IOSEditorWin = {
  id: string;
  file: FileItem;
  editedVars: EnvVariable[];
  minimized: boolean;
};

export type AppFolder = {
  id: string;
  name: string;
  icon: ReactNode;
  position: { x: number; y: number };
  apps: DesktopIcon[];
  isOpen?: boolean;
};
