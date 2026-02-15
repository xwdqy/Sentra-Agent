import { DateTime } from 'luxon';

export function formatDateFromMillis(ms: number, timezone: string = 'Asia/Shanghai'): string {
  if (!Number.isFinite(ms)) return '';

  try {
    return DateTime.fromMillis(ms).setZone(timezone).toFormat('yyyy-LL-dd');
  } catch {
    try {
      return new Date(ms).toISOString().slice(0, 10);
    } catch {
      return '';
    }
  }
}
