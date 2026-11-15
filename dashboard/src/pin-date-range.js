// Server-side date bounds for GET /v1/pins (?from= / ?to=).
// created_at is stored as UTC ISO 8601 (new Date().toISOString()), so lexical
// comparison equals chronological comparison. A date-only bound covers the
// whole day to match the dashboard date picker.

function parsePinDateBound(raw, isEndOfDay) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return isEndOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  }
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

function resolvePinDateRange(query) {
  const fromBound = parsePinDateBound(query?.from, false);
  const toBound = parsePinDateBound(query?.to, true);
  if (fromBound === undefined || toBound === undefined) {
    return {
      error: 'Query params "from" and "to" must be ISO 8601 dates (YYYY-MM-DD or full timestamp)',
    };
  }
  if (fromBound && toBound && fromBound > toBound) {
    return { error: '"from" must not be after "to"' };
  }
  return { fromBound, toBound };
}

module.exports = { parsePinDateBound, resolvePinDateRange };
