import { useEffect, useState } from 'react';
import { storage } from '../utils/storage';

export function useUsageCounts() {
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>(() => {
    const saved = storage.getJson<any>('sentra_usage_counts', { fallback: {} });
    return saved && typeof saved === 'object' ? saved : {};
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      storage.setJson('sentra_usage_counts', usageCounts);
    }, 500);
    return () => clearTimeout(timer);
  }, [usageCounts]);

  const recordUsage = (key: string) => {
    setUsageCounts(prev => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
  };

  return { usageCounts, recordUsage } as const;
}
