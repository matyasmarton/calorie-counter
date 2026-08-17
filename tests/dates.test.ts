import { addDays, formatDateKey, isValidDateKey, parseDateKey, todayKey } from '@/domain/dates';
import { describe, expect, it } from 'vitest';

describe('todayKey', () => {
  it('uses the LOCAL calendar date, not UTC', () => {
    // Local-timezone construction is deterministic in any TZ.
    expect(todayKey(new Date(2026, 7, 17, 23, 59, 59))).toBe('2026-08-17');
    expect(todayKey(new Date(2026, 7, 18, 0, 0, 0))).toBe('2026-08-18');
    expect(todayKey(new Date(2026, 0, 1, 12, 0))).toBe('2026-01-01');
  });

  it('zero-pads month and day', () => {
    expect(todayKey(new Date(2026, 11, 5))).toBe('2026-12-05');
  });
});

describe('isValidDateKey', () => {
  it('accepts real calendar dates', () => {
    expect(isValidDateKey('2026-08-17')).toBe(true);
    expect(isValidDateKey('2024-02-29')).toBe(true); // leap year
  });

  it('rejects impossible calendar dates', () => {
    expect(isValidDateKey('2025-02-29')).toBe(false); // not a leap year
    expect(isValidDateKey('2026-02-30')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('2026-00-10')).toBe(false);
    expect(isValidDateKey('2026-04-31')).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(isValidDateKey('2026-8-17')).toBe(false);
    expect(isValidDateKey('17-08-2026')).toBe(false);
    expect(isValidDateKey('20260817')).toBe(false);
    expect(isValidDateKey('')).toBe(false);
    expect(isValidDateKey('today')).toBe(false);
  });
});

describe('addDays', () => {
  it('wraps month and year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29'); // leap year
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('rejects invalid input', () => {
    expect(() => addDays('nope', 1)).toThrow(RangeError);
  });
});

describe('parseDateKey / formatDateKey', () => {
  it('parses to local midnight and formats for display', () => {
    const dt = parseDateKey('2026-08-17');
    expect(dt).not.toBeNull();
    expect(dt!.getFullYear()).toBe(2026);
    expect(dt!.getMonth()).toBe(7);
    expect(dt!.getDate()).toBe(17);
    expect(formatDateKey('2026-08-17')).toBe('Aug 17, 2026');
    expect(formatDateKey('2026-01-05')).toBe('Jan 5, 2026');
  });

  it('returns null / raw input for invalid keys', () => {
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(formatDateKey('garbage')).toBe('garbage');
  });
});
