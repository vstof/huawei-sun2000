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
//
// Hourly detail (version 2 of the file): every poll also records the DELTA of
// the daily register into the current hour bucket, which builds a production
// profile per hour for each observed day. The energy accumulated before the
// first poll of a day (mornings, or a full day after a restart) is attributed
// to the hour of that first poll: it is the only honest place available, it
// is marked here for what it is — an approximation for the hours we did not
// observe.
// -----------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'huawei-sun2000-stats.json';
// Per-day totals are kept ~13 months: the month widget navigates back to the
// previous year, and the year widget needs every month of it.
const KEEP_DAYS = 400;
// Hourly detail is bulky and only useful to browse recent days.
const KEEP_HOURS_DAYS = 40;
// Month buckets: the running month, a full previous year, plus margin.
const KEEP_MONTHS = 25;
// Year buckets are a handful of numbers: everything is kept.
const STORE_VERSION = 2;

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
    version: STORE_VERSION,
    last_date: null,
    today_kwh: 0,
    // Buckets of CLOSED days, keyed 'YYYY-MM' and 'YYYY'.
    months: {},
    years: {},
    // Closed days, oldest first: [{ date: 'YYYY-MM-DD', kwh }]
    days: [],
    // Hourly profile per observed day: { 'YYYY-MM-DD': [24 kWh] }
    hours: {},
    // Estimated energy per PV string (row) per day: { 'YYYY-MM-DD': { 1: kWh } }
    // — an integration of the measured U x I power, not an inverter counter.
    strings: {},
    // Hourly profile per row and day: { 'YYYY-MM-DD': { 1: [24 kWh] } }
    strings_hours: {},
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
    // Migration: version 1 had no hourly profiles.
    if (parsed.version !== STORE_VERSION) {
      store.version = STORE_VERSION;
      store.hours = {};
    }
    if (store.hours === null || typeof store.hours !== 'object' || Array.isArray(store.hours)) {
      store.hours = {};
    }
    for (const [date, profile] of Object.entries(store.hours)) {
      if (!Array.isArray(profile) || profile.length !== 24 || profile.some((h) => !Number.isFinite(h) || h < 0)) {
        delete store.hours[date];
      }
    }
    if (store.strings === null || typeof store.strings !== 'object' || Array.isArray(store.strings)) {
      store.strings = {};
    }
    for (const [date, rowMap] of Object.entries(store.strings)) {
      if (
        rowMap === null ||
        typeof rowMap !== 'object' ||
        Object.values(rowMap).some((kwh) => !Number.isFinite(kwh) || kwh < 0)
      ) {
        delete store.strings[date];
      }
    }
    if (store.strings_hours === null || typeof store.strings_hours !== 'object' || Array.isArray(store.strings_hours)) {
      store.strings_hours = {};
    }
    for (const [date, rowProfiles] of Object.entries(store.strings_hours)) {
      if (
        rowProfiles === null ||
        typeof rowProfiles !== 'object' ||
        Object.values(rowProfiles).some(
          (profile) =>
            !Array.isArray(profile) || profile.length !== 24 || profile.some((h) => !Number.isFinite(h) || h < 0),
        )
      ) {
        delete store.strings_hours[date];
      }
    }
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
  // Prune the rolling series by DATE (a long offline gap must not drop the
  // recent history a restart-free installation keeps accumulating).
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffDate = localDate(cutoff);
  while (store.days.length > 0 && store.days[0].date < cutoffDate) {
    store.days.shift();
  }
  // Prune stale month buckets.
  const oldestKeptMonth = monthKeyOfOffset(-KEEP_MONTHS);
  for (const key of Object.keys(store.months)) {
    if (key < oldestKeptMonth) {
      delete store.months[key];
    }
  }
}

function pruneHours() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_HOURS_DAYS);
  const cutoffDate = localDate(cutoff);
  for (const key of Object.keys(store.hours)) {
    if (key < cutoffDate) {
      delete store.hours[key];
    }
  }
  for (const key of Object.keys(store.strings)) {
    if (key < cutoffDate) {
      delete store.strings[key];
    }
  }
  for (const key of Object.keys(store.strings_hours)) {
    if (key < cutoffDate) {
      delete store.strings_hours[key];
    }
  }
}

/**
 * Book the measured power of each PV string (row) as energy: the inverter
 * has no per-string energy counter, so this INTEGRATES the power it
 * measures (U x I) between two polls. Gaps (offline, restart) are simply
 * not integrated — an estimate must not invent what was not observed.
 * @param {string} date local date YYYY-MM-DD
 * @param {Record<number, number>} powers per-string power in W
 * @param {number} elapsedMs time covered by this reading (ms)
 * @param {number|null} [hour] local hour (0-23) of the reading, also booked
 *   into the per-row hourly profile of the day
 */
export async function recordStrings(date, powers, elapsedMs, hour = null) {
  if (!powers || typeof powers !== 'object' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return;
  }
  await ensureLoaded();
  const validHour = Number.isInteger(hour) && hour >= 0 && hour <= 23;
  let booked = false;
  for (const [row, rawPower] of Object.entries(powers)) {
    const power = Number(rawPower);
    if (!Number.isFinite(power) || power < 0 || !/^\d+$/.test(row)) {
      continue;
    }
    // W * ms -> kWh: P(W) * t(h) / 1000 = P * ms / 3 600 000 000
    const kwh = (power * elapsedMs) / 3600000000;
    if (store.strings[date] === undefined || store.strings[date] === null) {
      store.strings[date] = {};
    }
    store.strings[date][row] = (store.strings[date][row] ?? 0) + kwh;
    if (validHour) {
      if (store.strings_hours[date] === undefined || store.strings_hours[date] === null) {
        store.strings_hours[date] = {};
      }
      let profile = store.strings_hours[date][row];
      if (!Array.isArray(profile) || profile.length !== 24) {
        profile = new Array(24).fill(0);
        store.strings_hours[date][row] = profile;
      }
      profile[hour] += kwh;
    }
    booked = true;
  }
  if (!booked) {
    return;
  }
  pruneHours();
  try {
    await persist();
  } catch {
    // Same contract as recordDaily: a read-only /data must not break polling.
  }
}

/**
 * The estimated energy per string (row) of ONE day: { 1: kWh, 2: kWh } or
 * null when that day was never observed.
 * @param {string} dateKey YYYY-MM-DD
 */
export async function stringsOfDay(dateKey) {
  const data = await ensureLoaded();
  const rowMap = data.strings[dateKey];
  if (!rowMap || Object.keys(rowMap).length === 0) {
    return null;
  }
  const result = {};
  for (const [row, kwh] of Object.entries(rowMap)) {
    result[row] = kwh;
  }
  return result;
}

/**
 * The hourly profile per row of ONE day: { 1: [24 kWh], ... } or null when
 * not recorded.
 * @param {string} dateKey YYYY-MM-DD
 */
export async function stringsHourly(dateKey) {
  const data = await ensureLoaded();
  const rowProfiles = data.strings_hours[dateKey];
  if (!rowProfiles || Object.keys(rowProfiles).length === 0) {
    return null;
  }
  const result = {};
  for (const [row, profile] of Object.entries(rowProfiles)) {
    result[row] = [...profile];
  }
  return result;
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
 * @param {number|null} [hourlyDelta] kWh produced since the previous poll,
 *   to book into the current hour (an approximate attribution for the first
 *   poll of a day: see the header). Nothing is recorded when null or <= 0.
 * @param {number|null} [hour] local hour (0-23) of the reading
 */
export async function recordDaily(date, kwh, hourlyDelta = null, hour = null) {
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
  // Hourly profile: book the delta of this poll into its hour bucket.
  const delta = Number(hourlyDelta);
  if (Number.isFinite(delta) && delta > 0 && Number.isInteger(hour) && hour >= 0 && hour <= 23) {
    let profile = store.hours[date];
    if (!Array.isArray(profile) || profile.length !== 24) {
      profile = new Array(24).fill(0);
      store.hours[date] = profile;
    }
    profile[hour] += delta;
    pruneHours();
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

// --- Navigation accessors (the period widgets) --------------------------------
// All async (lazy load), all honest: a period we never observed resolves to
// null / an empty list, never an invented zero series.

/** Add n days to a YYYY-MM-DD key (UTC math: no DST surprise). */
export function addDays(dateKey, n) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** Add n months to a YYYY-MM key. */
export function addMonths(monthKey, n) {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + n, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Whole days between two YYYY-MM-DD keys (b - a). */
export function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * The oldest period still in the store — the navigation clamps on it.
 * @returns {Promise<{firstDay: string|null, firstMonth: string|null, firstYear: string|null}>}
 */
export async function dataBounds() {
  const data = await ensureLoaded();
  let firstDay = null;
  for (const key of Object.keys(data.hours)) {
    if (firstDay === null || key < firstDay) {
      firstDay = key;
    }
  }
  if (data.days.length > 0 && (firstDay === null || data.days[0].date < firstDay)) {
    firstDay = data.days[0].date;
  }
  let firstMonth = null;
  for (const key of [...Object.keys(data.months), ...Object.keys(data.hours), ...data.days.map((d) => d.date.slice(0, 7))]) {
    if (firstMonth === null || key < firstMonth) {
      firstMonth = key;
    }
  }
  let firstYear = null;
  for (const key of [...Object.keys(data.years), ...Object.keys(data.months).map((m) => m.slice(0, 4))]) {
    if (firstYear === null || key < firstYear) {
      firstYear = key;
    }
  }
  return { firstDay, firstMonth, firstYear };
}

/**
 * Total of ONE day: the closed bucket, today's partial, or null when the day
 * was never observed.
 * @param {string} dateKey YYYY-MM-DD
 */
export async function dayTotal(dateKey) {
  const data = await ensureLoaded();
  if (dateKey === data.last_date) {
    return data.today_kwh;
  }
  const closed = data.days.find((entry) => entry.date === dateKey);
  return closed ? closed.kwh : null;
}

/**
 * Total of ONE month: bucket + partial for the running month, or null when
 * nothing of that month was ever observed.
 * @param {string} monthKey YYYY-MM
 */
export async function monthTotal(monthKey) {
  const data = await ensureLoaded();
  if (data.last_date === null) {
    return null;
  }
  const bucket = data.months[monthKey];
  if (bucket === undefined && !monthKey.startsWith(data.last_date.slice(0, 7))) {
    return null;
  }
  if (monthKey === data.last_date.slice(0, 7)) {
    return (bucket ?? 0) + data.today_kwh;
  }
  return bucket ?? null;
}

/**
 * Total of ONE year, same model as the month.
 * @param {string} yearKey YYYY
 */
export async function yearTotal(yearKey) {
  const data = await ensureLoaded();
  if (data.last_date === null) {
    return null;
  }
  const bucket = data.years[yearKey];
  if (bucket === undefined && yearKey !== data.last_date.slice(0, 4)) {
    return null;
  }
  if (yearKey === data.last_date.slice(0, 4)) {
    return (bucket ?? 0) + data.today_kwh;
  }
  return bucket ?? null;
}

/**
 * The hourly profile of one day (a 24-entry copy), or null when not recorded.
 * @param {string} dateKey YYYY-MM-DD
 */
export async function hourlyFor(dateKey) {
  const data = await ensureLoaded();
  const profile = data.hours[dateKey];
  return profile ? [...profile] : null;
}

/**
 * The days of ONE month, oldest first, including today's partial. Days we
 * never read are absent (honest gaps).
 * @param {string} monthKey YYYY-MM
 */
export async function daysOfMonth(monthKey) {
  const data = await ensureLoaded();
  const result = data.days
    .filter((entry) => entry.date.startsWith(monthKey))
    .map((entry) => ({ date: entry.date, kwh: entry.kwh }));
  if (data.last_date !== null && data.last_date.startsWith(monthKey)) {
    result.push({ date: data.last_date, kwh: data.today_kwh });
  }
  return result.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * The months of ONE year, oldest first, including the running month partial.
 * @param {string} yearKey YYYY
 */
export async function monthsOfYear(yearKey) {
  const data = await ensureLoaded();
  const result = Object.entries(data.months)
    .filter(([key]) => key.startsWith(yearKey))
    .map(([month, kwh]) => ({ month, kwh }));
  if (data.last_date !== null && data.last_date.slice(0, 4) === yearKey) {
    const month = data.last_date.slice(0, 7);
    if (!result.some((entry) => entry.month === month)) {
      result.push({ month, kwh: data.today_kwh });
    }
  }
  return result.sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * A rolling window of the last `count` months, oldest first, with 0 kWh for
 * the months that were never observed (the user wants to see all of them).
 * @param {number} count
 */
export async function monthsRolling(count) {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const result = [];
  for (let offset = -(count - 1); offset <= 0; offset += 1) {
    const month = addMonths(currentMonth, offset);
    const kwh = (await monthTotal(month)) ?? 0;
    result.push({ month, kwh });
  }
  return result;
}

export async function yearsRolling(count) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const result = [];
  for (let offset = -(count - 1); offset <= 0; offset += 1) {
    const year = String(currentYear + offset);
    const kwh = (await yearTotal(year)) ?? 0;
    result.push({ year, kwh });
  }
  return result;
}
