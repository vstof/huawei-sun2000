// -----------------------------------------------------------------------------
// Production statistics: total production per day / month / year.
//
// The inverter itself only gives the DAILY yield (register 32114, reset every
// night) and the lifetime total (32106). The month and year totals are
// accumulated here, day after day, in a small JSON file under /data — the only
// writable location of the Gladys sandbox (survives container restarts).
//
// Model:
//   - the day being accumulated is (last_date, today_kwh): within a day the
//     daily register is monotonic, so a lower reading is ignored (a glitch or
//     a re-read of yesterday's buffer);
//   - at the first reading of a NEW day, the previous day is CLOSED: its last
//     known value is added to the month and year buckets and pushed to the
//     rolling `days` series;
//   - the displayed month/year total is the closed bucket + today's partial.
//
// Gaps are honest: days when nothing was read (integration offline, inverter
// unreachable) are simply absent from the series — no value is fabricated.
// The month and year totals are therefore only as complete as the reading
// history since the stats file was created.
// -----------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'huawei-sun2000-stats.json';
// The rolling daily series keeps a margin above the 30 days the widget shows.
const KEEP_DAYS = 40;
// Month buckets older than the previous year are dropped (the file stays tiny).
const KEEP_MONTHS = 24;

let store = null;
let dataDir = '/data';

/**
 * Local date of a timestamp, YYYY-MM-DD (the inverter's daily register resets
 * on LOCAL midnight; the container runs on the host's clock).
 * @param {Date} [now]
 * @returns {string}
 */
export function localDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyStore() {
  return {
    version: 1,
    last_date: null,
    today_kwh: 0,
    // Buckets of CLOSED days, keyed 'YYYY-MM' and 'YYYY'.
    months: {},
    years: {},
    // Closed days, oldest first: [{ date: 'YYYY-MM-DD', kwh }]
    days: [],
  };
}

/**
 * Point the stats at a directory (tests only: a temp dir). Resets the cache.
 * @param {string} dir
 */
export function setStatsDir(dir) {
  dataDir = dir;
  store = null;
}

async function ensureLoaded() {
  if (store !== null) {
    return store;
  }
  const file = path.join(dataDir, FILE_NAME);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    store = { ...emptyStore(), ...parsed };
    // Anything non-numeric or negative from a hand-edited file is dropped.
    store.today_kwh = Number.isFinite(store.today_kwh) && store.today_kwh >= 0 ? store.today_kwh : 0;
    if (!Array.isArray(store.days)) {
      store.days = [];
    }
    store.days = store.days.filter(
      (entry) => entry && typeof entry.date === 'string' && Number.isFinite(entry.kwh) && entry.kwh >= 0,
    );
  } catch {
    // Missing (first run) or unreadable (hand-edited): start clean.
    store = emptyStore();
  }
  return store;
}

async function persist() {
  const file = path.join(dataDir, FILE_NAME);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(store));
  await fs.rename(tmp, file);
}

function addClosedDay(closedDate, kwh) {
  const monthKey = closedDate.slice(0, 7);
  const yearKey = closedDate.slice(0, 4);
  store.months[monthKey] = (store.months[monthKey] ?? 0) + kwh;
  store.years[yearKey] = (store.years[yearKey] ?? 0) + kwh;
  store.days.push({ date: closedDate, kwh });
  if (store.days.length > KEEP_DAYS) {
    store.days.splice(0, store.days.length - KEEP_DAYS);
  }
  // Prune stale month buckets.
  const oldestKeptMonth = monthKeyOfOffset(-KEEP_MONTHS);
  for (const key of Object.keys(store.months)) {
    if (key < oldestKeptMonth) {
      delete store.months[key];
    }
  }
}

function monthKeyOfOffset(offset) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Record one reading of the daily-yield register (kWh). Call at every poll.
 * @param {string} date local date of the reading, YYYY-MM-DD
 * @param {number} kwh daily yield as read (>= 0)
 */
export async function recordDaily(date, kwh) {
  const value = Number(kwh);
  if (!Number.isFinite(value) || value < 0) {
    return; // an invalid reading is not an error: the next poll will tell
  }
  await ensureLoaded();
  if (store.last_date === date) {
    // Same day: the register is monotonic within a day, keep the max.
    store.today_kwh = Math.max(store.today_kwh, value);
  } else if (store.last_date === null) {
    // First reading ever: adopt the day as it is (a partial day is honest).
    store.last_date = date;
    store.today_kwh = value;
  } else {
    // A new day: close the previous one with its last known value, then start
    // the new one. Days never observed (offline) are skipped, not invented.
    addClosedDay(store.last_date, store.today_kwh);
    store.last_date = date;
    store.today_kwh = value;
  }
  try {
    await persist();
  } catch {
    // A read-only /data must not break polling: the totals degrade to the
    // in-memory values and start over on the next boot.
  }
}

/**
 * Consistent snapshot of the accumulated statistics. Async on the first call
 * of a process (the store is lazily loaded from /data).
 * @returns {Promise<object>} {
 *   date, today, month, year (kWh),
 *   days: last 30 closed days [{ date, kwh }],
 *   months: months of the running year YTD [{ month: 'YYYY-MM', kwh }] (≤ 10)
 *   — the running month is included, closed days + today's partial
 * }
 */
export async function snapshot() {
  const data = await ensureLoaded();
  if (data === null || data.last_date === null) {
    return { date: null, today: 0, month: 0, year: 0, days: [], months: [] };
  }
  const todayMonth = data.last_date.slice(0, 7);
  const todayYear = data.last_date.slice(0, 4);
  // The month/year totals = closed-day bucket + today's partial.
  const month = (data.months[todayMonth] ?? 0) + data.today_kwh;
  const year = (data.years[todayYear] ?? 0) + data.today_kwh;
  const months = Object.entries(data.months)
    .filter(([key]) => key.startsWith(todayYear))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-(10 - 1))
    .map(([key, kwh]) => ({ month: key, kwh }));
  if (!months.some((entry) => entry.month === todayMonth)) {
    months.push({ month: todayMonth, kwh: data.today_kwh });
  }
  months.sort((a, b) => (a.month < b.month ? -1 : 1));
  return {
    date: data.last_date,
    today: data.today_kwh,
    month,
    year,
    days: data.days.slice(-30).map((entry) => ({ ...entry })),
    months,
  };
}

/** Forget everything (tests only). */
export function resetStats() {
  store = null;
}
