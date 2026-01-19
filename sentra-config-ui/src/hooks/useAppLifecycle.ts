import { useCallback, useEffect } from 'react';
import { fetchConfigs, verifyToken, waitForBackend } from '../services/api';
import type { ConfigData } from '../types/config';
import { storage } from '../utils/storage';
import { useUIStore } from '../store/uiStore';
import { useWindowsStore } from '../store/windowsStore';
import { useAppStore } from '../store/appStore';

export function useAppLifecycle() {
  const addToast = useUIStore(s => s.addToast);
  const setLoading = useUIStore(s => s.setLoading);
  const setAuthChecking = useUIStore(s => s.setAuthChecking);

  const setIsAuthenticated = useAppStore(s => s.setIsAuthenticated);
  const setConfigData = useAppStore(s => s.setConfigData);
  const setServerReady = useAppStore(s => s.setServerReady);

  const setOpenWindows = useWindowsStore(s => s.setOpenWindows);
  const syncWindowsFromConfigData = useWindowsStore(s => s.syncWindowsFromConfigData);

  const loadConfigs = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const data = await fetchConfigs();
      setConfigData(data as ConfigData);
      syncWindowsFromConfigData(data);
    } catch (error) {
      console.error('加载配置失败', error);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [setConfigData, setLoading, syncWindowsFromConfigData]);

  const checkAuth = useCallback(async () => {
    const token = storage.getString('sentra_auth_token', { backend: 'session', fallback: '' })
      || storage.getString('sentra_auth_token', { fallback: '' });
    if (token) {
      const isValid = await verifyToken(token);
      if (isValid) {
        setIsAuthenticated(true);
        loadConfigs();
      } else {
        storage.remove('sentra_auth_token', 'session');
        storage.remove('sentra_auth_token');
      }
    }
    setAuthChecking(false);
    setLoading(false);
  }, [loadConfigs, setAuthChecking, setIsAuthenticated, setLoading]);

  const initApp = useCallback(async () => {
    // 1. Wait for backend to be ready
    const bootTime = await waitForBackend();
    setServerReady(!!bootTime);

    if (!bootTime) {
      addToast('error', '连接失败', '无法连接到后端服务器');
      setLoading(false);
      return;
    }

    // 2. Check if server restarted (Boot Time changed)
    const lastBootTime = storage.getString('sentra_server_boot_time', { backend: 'session', fallback: '' })
      || storage.getString('sentra_server_boot_time', { fallback: '' });
    if (lastBootTime && lastBootTime !== String(bootTime)) {
      console.log('Server restarted, invalidating session');
      storage.remove('sentra_auth_token', 'session');
      storage.remove('sentra_server_boot_time', 'session');
      storage.remove('sentra_auth_token');
      storage.remove('sentra_server_boot_time');
      setIsAuthenticated(false);
    }

    // Update stored boot time
    storage.setString('sentra_server_boot_time', String(bootTime), 'session');
    storage.setString('sentra_server_boot_time', String(bootTime));

    // 3. Check auth
    await checkAuth();
  }, [addToast, checkAuth, setIsAuthenticated, setLoading, setServerReady]);

  useEffect(() => {
    void initApp();
  }, [initApp]);

  const handleLogin = useCallback(async (token: string) => {
    const isValid = await verifyToken(token);
    if (isValid) {
      storage.setString('sentra_auth_token', token, 'session');
      storage.setString('sentra_auth_token', token);
      setIsAuthenticated(true);
      loadConfigs();
      return true;
    }
    return false;
  }, [loadConfigs, setIsAuthenticated]);

  const handleLogout = useCallback(() => {
    storage.remove('sentra_auth_token', 'session');
    storage.remove('sentra_auth_token');
    setIsAuthenticated(false);
    setOpenWindows([]);
    setConfigData(null);
  }, [setConfigData, setIsAuthenticated, setOpenWindows]);

  return {
    loadConfigs,
    handleLogin,
    handleLogout,
  } as const;
}
