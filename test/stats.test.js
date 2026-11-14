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
import { localDate, recordDaily, resetStats, setStatsDir, snapshot } from '../src/stats.js';

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
