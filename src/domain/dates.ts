const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO calendar date key (YYYY-MM-DD) for the device's LOCAL calendar date.
 * This is the single source of truth for "today" — logging uses the local
 * date, not UTC, so a log made at 23:30 stays on the local day.
 */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Strictly validate a date key: shape YYYY-MM-DD AND a real calendar date
 * (rejects e.g. "2025-02-30"). Returns true when valid.
 */
export function isValidDateKey(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Parse a date key to a local-midnight Date, or null when invalid. */
export function parseDateKey(s: string): Date | null {
  if (!isValidDateKey(s)) return null;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Add `days` (may be negative) to a valid date key. */
export function addDays(key: string, days: number): string {
  const dt = parseDateKey(key);
  if (!dt) throw new RangeError(`invalid date key: ${key}`);
  dt.setDate(dt.getDate() + days);
  return todayKey(dt);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Human display, e.g. "Aug 17, 2026". */
export function formatDateKey(key: string): string {
  const dt = parseDateKey(key);
  if (!dt) return key;
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}
