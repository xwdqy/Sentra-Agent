import { saveModuleConfig, savePluginConfig, restoreModuleConfig, restorePluginConfig } from '../services/api';
import { getDisplayName } from '../utils/icons';
import type { EnvVariable } from '../types/config';
import type { ToastMessage } from '../components/Toast';
import { useWindowsStore } from '../store/windowsStore';

export type UseDesktopWindowsParams = {
  setSaving: (s: boolean) => void;
  addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
  // When saving finishes, we need to refresh configs
  loadConfigs: (silent?: boolean) => Promise<void> | void;
  onLogout?: () => void;
};

export function useDesktopWindows({ setSaving, addToast, loadConfigs, onLogout }: UseDesktopWindowsParams) {
  const openWindows = useWindowsStore(s => s.openWindows);
  const setOpenWindows = useWindowsStore(s => s.setOpenWindows);

  const handleSave = async (id: string) => {
    const win = openWindows.find(w => w.id === id);
    if (!win) return;

    try {
      setSaving(true);
      const validVars = win.editedVars.filter(v => v.key.trim());
      if (win.file.type === 'module') {
        await saveModuleConfig(win.file.name, validVars);
      } else {
        await savePluginConfig(win.file.name, validVars);
      }
      addToast('success', '保存成功', `已更新 ${getDisplayName(win.file.name)} 配置`);
      await loadConfigs(true);

      // Trigger logout ONLY if SECURITY_TOKEN was modified
      // We compare the new value (in editedVars) with the old value (in file.variables)
      const oldToken = win.file.variables?.find(v => v.key === 'SECURITY_TOKEN')?.value;
      const newToken = validVars.find(v => v.key === 'SECURITY_TOKEN')?.value;

      if (onLogout && newToken !== oldToken) {
        setTimeout(() => {
          onLogout();
        }, 1500); // Small delay to let the toast show
      }
    } catch (error) {
      addToast('error', '保存失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const handleVarChange = (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => {
    setOpenWindows(ws => ws.map(w => {
      if (w.id !== id) return w;
      const newVars = [...w.editedVars];
      newVars[index] = { ...newVars[index], [field]: val } as EnvVariable;
      return { ...w, editedVars: newVars };
    }));
  };

  const handleAddVar = (id: string) => {
    setOpenWindows(ws => ws.map(w => w.id === id ? { ...w, editedVars: [...w.editedVars, { key: '', value: '', comment: '', isNew: true }] } : w));
  };

  const handleDeleteVar = (id: string, index: number) => {
    const win = openWindows.find(w => w.id === id);
    if (!win) return;

    const targetVar = win.editedVars[index];

    // Check if variable exists in .env.example
    const exampleKeys = new Set((win.file.exampleVariables || []).map(v => v.key));
    if (exampleKeys.has(targetVar.key)) {
      addToast('error', '无法删除', `变量 "${targetVar.key}" 存在于 .env.example 中，无法删除`);
      return;
    }

    // Allow deletion and show success feedback
    setOpenWindows(ws => ws.map(w => w.id === id ? { ...w, editedVars: w.editedVars.filter((_, i) => i !== index) } : w));
    addToast('success', '删除成功', `已删除变量 "${targetVar.key}"`);
  };

  const handleRestore = async (id: string) => {
    const win = openWindows.find(w => w.id === id);
    if (!win) return;

    try {
      setSaving(true);
      if (win.file.type === 'module') {
        await restoreModuleConfig(win.file.name);
      } else {
        await restorePluginConfig(win.file.name);
      }
      addToast('success', '恢复成功', `已恢复 ${getDisplayName(win.file.name)} 配置为默认值`);
      await loadConfigs(true);
    } catch (error) {
      addToast('error', '恢复失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  return {
    handleSave,
    handleVarChange,
    handleAddVar,
    handleDeleteVar,
    handleRestore,
  } as const;
}
