// -----------------------------------------------------------------------------
// Production statistics tests: day rollover, monotonic daily register,
// month/year accumulation, rolling series and file persistence. The stats
// live in a temp directory: these tests never touch /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localDate, recordDaily, recordStrings, stringsOfDay, resetStats, setStatsDir, snapshot, hourlyFor, dayTotal, monthTotal, yearTotal, daysOfMonth, monthsOfYear, dataBounds, addDays, dayDiff } from '../src/stats.js';

const DAYS = ['2026-01-30', '2026-01-31', '2026-02-01'];

function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'huawei-stats-'));
}

test('localDate formats the local date as YYYY-MM-DD', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 13, 42)), '2026-01-05');
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('a first reading is adopted as a partial day', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  assert.deepEqual(await snapshot(), {
    date: DAYS[0],
    today: 3.5,
    month: 3.5, // no closed day yet: the month bucket is empty
    year: 3.5,
    days: [],
    months: [{ month: '2026-01', kwh: 3.5 }], // the running month is listed
  });
  await rm(dir, { recursive: true, force: true });
});

test('within a day, a lower reading is ignored (monotonic register)', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  await recordDaily(DAYS[0], 1.2); // glitch: yesterday's buffer, register lag...
  await recordDaily(DAYS[0], 4.0);
  assert.equal((await snapshot()).today, 4.0);
  await rm(dir, { recursive: true, force: true });
});

test('a new day closes the previous one into month, year and series', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  await recordDaily(DAYS[1], 5.0); // next day: 2026-01-30 is closed
  const stats = await snapshot();
  assert.equal(stats.date, DAYS[1]);
  assert.equal(stats.today, 5.0);
  assert.equal(stats.month, 3.5 + 5.0, 'closed day + today, same month');
  assert.equal(stats.year, 3.5 + 5.0);
  assert.deepEqual(stats.days, [{ date: DAYS[0], kwh: 3.5 }], 'the closed day entered the series');
  assert.deepEqual(
    stats.months,
    [{ month: '2026-01', kwh: 3.5 }],
    'the closed day entered the month bucket',
  );
  await rm(dir, { recursive: true, force: true });
});

test('a month rollover moves the totals to the new month, year stays', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  await recordDaily(DAYS[1], 5.0);
  await recordDaily(DAYS[2], 2.0); // February: January is over
  const stats = await snapshot();
  assert.equal(stats.month, 2.0, 'the new month starts clean');
  assert.equal(stats.year, 3.5 + 5.0 + 2.0, 'the year accumulates across months');
  assert.deepEqual(
    stats.months.map((entry) => entry.month),
    ['2026-01', '2026-02'],
    'the months of the running year, oldest first',
  );
  await rm(dir, { recursive: true, force: true });
});

test('an offline gap skips the missing days, it does not invent them', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  await recordDaily(DAYS[2], 2.0); // 2026-01-31 was never read
  const stats = await snapshot();
  assert.deepEqual(
    stats.days.map((entry) => entry.date),
    [DAYS[0]],
    'only observed days exist',
  );
  assert.equal(stats.year, 3.5 + 2.0);
  await rm(dir, { recursive: true, force: true });
});

test('an invalid reading is ignored, not stored', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], Number.NaN);
  await recordDaily(DAYS[0], -1);
  assert.equal((await snapshot()).date, null, 'nothing was recorded');
  await rm(dir, { recursive: true, force: true });
});

test('the stats survive a restart (file persistence)', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  await recordDaily(DAYS[1], 5.0);

  // A fresh container boots: the store reloads from /data.
  setStatsDir(dir);
  const stats = await snapshot();
  assert.equal(stats.month, 3.5 + 5.0);
  assert.deepEqual(stats.days, [{ date: DAYS[0], kwh: 3.5 }]);

  const raw = JSON.parse(await readFile(path.join(dir, 'huawei-sun2000-stats.json'), 'utf8'));
  assert.equal(raw.last_date, DAYS[1]);
  assert.equal(raw.months['2026-01'], 3.5);
  assert.ok(!raw.days.some((entry) => entry.date === DAYS[1]), 'the open day is not closed yet');
  await rm(dir, { recursive: true, force: true });
});

test('a corrupt stats file starts clean instead of crashing', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'huawei-sun2000-stats.json'), '{not json');
  const stats = await snapshot();
  assert.equal(stats.date, null, 'the store started clean');
  await recordDaily(DAYS[0], 1.0);
  assert.equal((await snapshot()).today, 1.0, 'recording works after the reset');
  await rm(dir, { recursive: true, force: true });
});

test('a series capped at 30 days for the widget, 40 kept on disk', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  const first = new Date(2026, 0, 1);
  for (let offset = 0; offset < 45; offset += 1) {
    const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset);
    await recordDaily(localDate(date), 1 + offset * 0.01);
  }
  const stats = await snapshot();
  assert.equal(stats.days.length, 30, 'the widget series is capped at 30 days');
  assert.equal(stats.days[0].date, localDate(new Date(2026, 0, 15)), 'the oldest kept day');
  assert.equal(stats.days[29].date, localDate(new Date(2026, 1, 13)), 'yesterday, closed');
  assert.equal(stats.date, localDate(new Date(2026, 1, 14)), 'the open day');
  await rm(dir, { recursive: true, force: true });
});

test('resetStats clears the in-memory store (test isolation)', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 9.9);
  resetStats();
  // The store reloads the persisted file: the restart path keeps the data.
  assert.equal((await snapshot()).date, DAYS[0]);
  // Pointed at a brand-new empty directory, the store really starts clean.
  setStatsDir(await tempDir());
  assert.equal((await snapshot()).date, null);
  await rm(dir, { recursive: true, force: true });
});

// --- Navigation accessors ---------------------------------------------------

test('recordDaily books the hourly delta into the hour buckets', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  const day = localDate(); // recent: the 40-day hourly retention keeps it
  await recordDaily(day, 1.2, 1.2, 12);
  await recordDaily(day, 2.0, 0.8, 13);
  await recordDaily(day, 2.5, 0.5, 14);
  const hourly = await hourlyFor(day);
  assert.equal(hourly[12], 1.2);
  assert.equal(hourly[13], 0.8);
  assert.equal(hourly[14], 0.5);
  assert.equal(hourly.filter((h) => h > 0).length, 3);
  // A negative or zero delta books nothing.
  await recordDaily(day, 2.4, -0.1, 15);
  assert.equal((await hourlyFor(day))[15], 0);
  await rm(dir, { recursive: true, force: true });
});

test('dayTotal resolves closed days, today and unknown days', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  await recordDaily(DAYS[1], 5.0);
  assert.equal(await dayTotal(DAYS[0]), 3.5, 'the closed day');
  assert.equal(await dayTotal(DAYS[1]), 5.0, 'the open day');
  assert.equal(await dayTotal('2020-01-01'), null, 'never observed');
  await rm(dir, { recursive: true, force: true });
});

test('monthTotal and yearTotal follow the bucket + partial model', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5); // 2026-01-30
  await recordDaily(DAYS[1], 5.0); // 2026-01-31 closes 30
  await recordDaily(DAYS[2], 2.0); // 2026-02-01 closes 31
  assert.equal(await monthTotal('2026-01'), 8.5, 'the closed bucket');
  assert.equal(await monthTotal('2026-02'), 2.0, 'the running month partial');
  assert.equal(await monthTotal('2025-12'), null, 'never observed');
  assert.equal(await yearTotal('2026'), 10.5);
  assert.equal(await yearTotal('2025'), null);
  await rm(dir, { recursive: true, force: true });
});

test('daysOfMonth and monthsOfYear list what was observed, sorted', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5);
  await recordDaily(DAYS[1], 5.0);
  await recordDaily(DAYS[2], 2.0);
  assert.deepEqual(
    (await daysOfMonth('2026-01')).map((entry) => entry.date),
    ['2026-01-30', '2026-01-31'],
  );
  assert.deepEqual(
    (await monthsOfYear('2026')).map((entry) => entry.month),
    ['2026-01', '2026-02'],
  );
  assert.equal((await daysOfMonth('2026-02')).length, 1, 'today only');
  await rm(dir, { recursive: true, force: true });
});

test('dataBounds exposes the oldest recorded period (navigation clamp)', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  await recordDaily(DAYS[0], 3.5, 3.5, 10);
  await recordDaily(DAYS[1], 5.0);
  const bounds = await dataBounds();
  assert.equal(bounds.firstDay, DAYS[0]);
  assert.equal(bounds.firstMonth, '2026-01');
  assert.equal(bounds.firstYear, '2026');
  await rm(dir, { recursive: true, force: true });
});

test('a version-1 stats file is migrated, its history kept', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  const v1 = {
    version: 1,
    last_date: DAYS[1],
    today_kwh: 5.0,
    months: { '2026-01': 3.5 },
    years: { 2026: 3.5 },
    days: [{ date: DAYS[0], kwh: 3.5 }],
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'huawei-sun2000-stats.json'), JSON.stringify(v1));
  const stats = await snapshot();
  assert.equal(stats.month, 8.5, 'the closed history survived the migration');
  assert.equal(await dayTotal(DAYS[0]), 3.5);
  assert.equal(await hourlyFor(DAYS[0]), null, 'no hourly profile in a v1 file');
  await recordDaily(localDate(), 5.5, 0.5, 9);
  assert.equal((await hourlyFor(localDate()))[9], 0.5, 'hourly recording starts after the migration');
  await rm(dir, { recursive: true, force: true });
});

test('addDays and dayDiff compute over UTC days', async () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayDiff('2026-01-30', '2026-02-01'), 2);
  assert.equal(dayDiff('2026-02-01', '2026-01-30'), -2);
});

test('recordStrings integrates the per-row power into kWh', async () => {
  const dir = await tempDir();
  setStatsDir(dir);
  const day = localDate(); // recent: the 40-day retention keeps it
  // 9000 W over one hour = 9 kWh.
  await recordStrings(day, { 1: 9000, 2: 7600 }, 3600000);
  await recordStrings(day, { 1: 9000, 2: 7600 }, 3600000);
  const rows = await stringsOfDay(day);
  assert.ok(Math.abs(rows['1'] - 18) < 1e-9, 'row 1: two hours of integration');
  assert.ok(Math.abs(rows['2'] - 15.2) < 1e-9, 'row 2');
  // Invalid inputs book nothing.
  await recordStrings(day, { 1: 9000 }, -1000);
  await recordStrings(day, null, 60000);
  assert.equal(Object.keys(await stringsOfDay(day)).length, 2, 'unchanged');
  // An unobserved day resolves to null.
  assert.equal(await stringsOfDay('2020-05-05'), null);
  await rm(dir, { recursive: true, force: true });
});
