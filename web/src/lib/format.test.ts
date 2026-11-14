import { describe, it, expect } from 'vitest';
import { formatBytes, formatDateTime, truncateMiddle } from './format';

describe('formatBytes', () => {
  it('formats zero and negative as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
  });

  it('uses binary units with adaptive precision', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1048576)).toBe('1.00 MB');
    expect(formatBytes(80 * 1024 * 1024)).toBe('80.0 MB');
  });

  it('caps at TB', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB');
  });
});

describe('formatDateTime', () => {
  it('formats ISO strings as UTC timestamps', () => {
    expect(formatDateTime('2026-01-02T03:04:05.000Z')).toBe('2026-01-02 03:04:05');
  });

  it('returns a placeholder for missing input', () => {
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('truncateMiddle', () => {
  it('keeps short strings intact', () => {
    expect(truncateMiddle('abc', 8, 6)).toBe('abc');
  });

  it('truncates CIDs in the middle', () => {
    expect(truncateMiddle('Qm' + 'x'.repeat(44), 10, 7)).toBe('Qmxxxxxxxx...xxxxxxx');
  });

  it('returns a placeholder for missing input', () => {
    expect(truncateMiddle(undefined)).toBe('—');
  });
});
