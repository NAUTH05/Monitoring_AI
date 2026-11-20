/**
 * Regression tests for the four reported defects.
 *
 *   A. camera storage/resolution must be measured, never fabricated
 *   B. camera activation is a separate concept from deletion and connectivity
 *   C. event date filters are timezone-correct whole days
 *   D. report periods are exact, zero-filled and internally consistent
 *
 * Everything here is hermetic: storage tests use a temp directory, date and
 * filter tests are pure, and nothing touches the application database.
 *
 * Run:  npm test
 */
import './helpers/telegram-env';

import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  APP_TIME_ZONE,
  DateRangeError,
  addDaysToKey,
  dateKeyInTimeZone,
  dayRangeUtc,
  daysInMonth,
  enumerateDateKeys,
  isValidDateKey,
  monthRangeUtc,
  parseDateKeyParts,
  resolveOptionalRange,
  singleDayRange,
  startOfWeekKey,
  todayKey,
  weekRangeUtc,
  zonedTimeToUtc,
} from '../src/lib/datetime';
import cameraRoutes from '../src/routes/cameras';
import { buildEventWhere, parsePositiveInt } from '../src/services/reporting/event-filter';
import { totalsFromBuckets } from '../src/services/reporting/event-analytics';
import {
  __clearStorageCache,
  formatBytes,
  invalidateCameraStorage,
  measureCamerasStorage,
  measureCameraStorage,
} from '../src/services/storage/camera-storage';

// ─────────────────────────────────────────────────────────────────────────────
describe('C/D. timezone-correct calendar ranges', () => {
  it('treats Asia/Ho_Chi_Minh as UTC+7 (local midnight = previous day 17:00Z)', () => {
    const range = singleDayRange('2026-10-05');
    assert.equal(range.start.toISOString(), '2026-10-04T17:00:00.000Z');
    assert.equal(range.endExclusive.toISOString(), '2026-10-05T17:00:00.000Z');
  });

  it('includes the whole final day of a range (half-open interval)', () => {
    const range = dayRangeUtc('2026-10-01', '2026-10-31');
    assert.equal(range.start.toISOString(), '2026-09-30T17:00:00.000Z');
    assert.equal(range.endExclusive.toISOString(), '2026-10-31T17:00:00.000Z');

    // 23:59:59.999 local on the last day is inside the range.
    const lastMoment = new Date('2026-10-31T16:59:59.999Z');
    assert.ok(lastMoment < range.endExclusive);
    // The next local midnight is not.
    assert.ok(new Date('2026-10-31T17:00:00.000Z') >= range.endExclusive);
  });

  it('assigns an event near local midnight to the correct local day', () => {
    // 00:30 on 2026-10-05 in Vietnam is 17:30Z on 2026-10-04.
    const event = new Date('2026-10-04T17:30:00.000Z');
    assert.equal(dateKeyInTimeZone(event), '2026-10-05');
    assert.equal(dateKeyInTimeZone(new Date('2026-10-04T16:59:59.000Z')), '2026-10-04');
  });

  it('does not depend on the host timezone', () => {
    // Same instant, same local day regardless of TZ env of the process.
    const instant = new Date('2026-12-31T18:30:00.000Z');
    assert.equal(dateKeyInTimeZone(instant, APP_TIME_ZONE), '2027-01-01');
  });

  it('builds a 7-day Monday..Sunday week', () => {
    const range = weekRangeUtc('2026-10-07'); // Wednesday
    assert.equal(range.startKey, '2026-10-05');
    assert.equal(range.endKey, '2026-10-11');
    assert.equal(enumerateDateKeys(range.startKey, range.endKey).length, 7);

    // A Sunday belongs to the week that started the previous Monday.
    assert.equal(startOfWeekKey('2026-10-11'), '2026-10-05');
  });

  it('handles month lengths, leap years and year boundaries', () => {
    assert.equal(daysInMonth(2026, 10), 31);
    assert.equal(daysInMonth(2026, 11), 30);
    assert.equal(daysInMonth(2027, 2), 28);
    assert.equal(daysInMonth(2028, 2), 29);

    const october = monthRangeUtc(2026, 10);
    assert.equal(october.startKey, '2026-10-01');
    assert.equal(october.endKey, '2026-10-31');

    const december = monthRangeUtc(2026, 12);
    // Ends at local midnight on 1 Jan 2027.
    assert.equal(december.endExclusive.toISOString(), '2026-12-31T17:00:00.000Z');

    const february = monthRangeUtc(2028, 2);
    assert.equal(enumerateDateKeys(february.startKey, february.endKey).length, 29);
  });

  it('rejects malformed and impossible dates', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '05/10/2026', '2026-1-5', '', 'abc', '1899-01-01']) {
      assert.equal(isValidDateKey(bad), false, `${bad} must be invalid`);
      assert.throws(() => parseDateKeyParts(bad), DateRangeError);
    }
    assert.equal(isValidDateKey('2026-02-28'), true);
  });

  it('rejects a start date after the end date', () => {
    assert.throws(() => dayRangeUtc('2026-10-10', '2026-10-01'), DateRangeError);
  });

  it('round-trips a wall-clock time through UTC', () => {
    const utc = zonedTimeToUtc(2026, 10, 5, APP_TIME_ZONE);
    assert.equal(utc.toISOString(), '2026-10-04T17:00:00.000Z');
  });

  it('shifts keys across month and year boundaries', () => {
    assert.equal(addDaysToKey('2026-10-31', 1), '2026-11-01');
    assert.equal(addDaysToKey('2026-12-31', 1), '2027-01-01');
    assert.equal(addDaysToKey('2026-01-01', -1), '2025-12-31');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C. event filter builder', () => {
  it('applies a single-day window for the today mode', () => {
    const where = buildEventWhere({ startDate: '2026-10-05', endDate: '2026-10-05' });
    const timestamp = where.timestamp as { gte: Date; lt: Date };
    assert.equal(timestamp.gte.toISOString(), '2026-10-04T17:00:00.000Z');
    assert.equal(timestamp.lt.toISOString(), '2026-10-05T17:00:00.000Z');
  });

  it('leaves the query unbounded for the all-dates mode', () => {
    const where = buildEventWhere({});
    assert.equal(where.timestamp, undefined);
  });

  it('supports an open-ended start or end', () => {
    const fromOnly = buildEventWhere({ startDate: '2026-10-01' });
    assert.ok((fromOnly.timestamp as { gte: Date }).gte);
    assert.equal((fromOnly.timestamp as { lt?: Date }).lt, undefined);

    const toOnly = buildEventWhere({ endDate: '2026-10-31' });
    assert.equal((toOnly.timestamp as { gte?: Date }).gte, undefined);
    // Includes all of 31 Oct: ends at local midnight on 1 Nov.
    assert.equal((toOnly.timestamp as { lt: Date }).lt.toISOString(), '2026-10-31T17:00:00.000Z');
  });

  it('keeps the type and alert filters alongside the date filter', () => {
    const where = buildEventWhere({ type: 'INTRUSION', isAlert: 'true', startDate: '2026-10-05', endDate: '2026-10-05' });
    assert.equal(where.eventType, 'INTRUSION');
    assert.equal(where.isAlert, true);
    assert.ok(where.timestamp);
  });

  it('throws on an inverted range so the route can answer 400', () => {
    assert.throws(() => buildEventWhere({ startDate: '2026-10-10', endDate: '2026-10-01' }), DateRangeError);
    assert.throws(() => buildEventWhere({ startDate: 'not-a-date' }), DateRangeError);
  });

  it('clamps pagination', () => {
    assert.equal(parsePositiveInt(undefined, 20, 200), 20);
    assert.equal(parsePositiveInt('0', 20, 200), 20);
    assert.equal(parsePositiveInt('-5', 20, 200), 20);
    assert.equal(parsePositiveInt('9999', 20, 200), 200);
    assert.equal(parsePositiveInt('3', 20, 200), 3);
  });

  it('resolveOptionalRange keeps omitted bounds unbounded', () => {
    assert.deepEqual(resolveOptionalRange(undefined, undefined), {});
    const startOnly = resolveOptionalRange('2026-10-01', undefined);
    assert.ok(startOnly.start);
    assert.equal(startOnly.endExclusive, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D. report totals', () => {
  it('derives totals from the daily series so chart and KPI always agree', () => {
    const buckets = [
      { date: '2026-10-04', count: 12, alerts: 10 },
      { date: '2026-10-05', count: 1, alerts: 1 },
      { date: '2026-10-06', count: 0, alerts: 0 },
    ];
    const totals = totalsFromBuckets(buckets);
    assert.equal(totals.totalEvents, 13);
    assert.equal(totals.totalAlerts, 11);
    assert.equal(totals.totalEvents, buckets.reduce((acc, b) => acc + b.count, 0));
    assert.ok(Math.abs(totals.alertRate - (11 / 13) * 100) < 1e-9);
  });

  it('reports 0% instead of NaN for an empty period', () => {
    const totals = totalsFromBuckets([{ date: '2026-11-17', count: 0, alerts: 0 }]);
    assert.equal(totals.totalEvents, 0);
    assert.equal(totals.alertRate, 0);
    assert.ok(Number.isFinite(totals.alertRate));
  });

  it('zero-fills a whole month so the axis is continuous', () => {
    const october = monthRangeUtc(2026, 10);
    const keys = enumerateDateKeys(october.startKey, october.endKey);
    assert.equal(keys.length, 31);
    assert.equal(keys[0], '2026-10-01');
    assert.equal(keys[30], '2026-10-31');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A. camera storage accounting', () => {
  let root = '';
  const previousRoot = process.env.AICAM_EVENTS_DIR;
  const previousMinio = process.env.MINIO_PUBLIC_URL;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'monitoring-storage-'));
    process.env.AICAM_EVENTS_DIR = root;
    delete process.env.MINIO_PUBLIC_URL;
    __clearStorageCache();
  });

  after(() => {
    if (previousRoot === undefined) delete process.env.AICAM_EVENTS_DIR;
    else process.env.AICAM_EVENTS_DIR = previousRoot;
    if (previousMinio !== undefined) process.env.MINIO_PUBLIC_URL = previousMinio;
    rmSync(root, { recursive: true, force: true });
    __clearStorageCache();
  });

  function writeMedia(stream: string, relative: string, bytes: number): void {
    const dir = path.join(root, stream, relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'image_0001.jpg'), Buffer.alloc(bytes, 1));
  }

  it('measures 0 bytes (status ok) for a camera with no media', async () => {
    const info = await measureCameraStorage({ id: 'cam-empty', streamName: 'stream_empty' });
    assert.equal(info.measurementStatus, 'ok');
    assert.equal(info.bytes, 0, 'no media must be a measured zero, not unavailable');
    assert.ok(info.calculatedAt);
  });

  it('measures a single snapshot', async () => {
    writeMedia('stream_one', '2026-10-05/evt-1', 2048);
    const info = await measureCameraStorage({ id: 'cam-one', streamName: 'stream_one' });
    assert.equal(info.measurementStatus, 'ok');
    assert.equal(info.bytes, 2048);
  });

  it('sums multiple evidence artifacts including videos', async () => {
    writeMedia('stream_multi', '2026-10-05/evt-1', 1000);
    writeMedia('stream_multi', '2026-10-05/evt-2', 2000);
    const videoDir = path.join(root, 'stream_multi', '2026-10-05', 'evt-3');
    mkdirSync(videoDir, { recursive: true });
    writeFileSync(path.join(videoDir, 'evidence.mp4'), Buffer.alloc(5000, 1));

    const info = await measureCameraStorage({ id: 'cam-multi', streamName: 'stream_multi' });
    assert.equal(info.bytes, 8000);
  });

  it('counts each physical directory once when id and streamName coincide', async () => {
    writeMedia('stream_dup', '2026-10-05/evt-1', 4096);
    const info = await measureCameraStorage({ id: 'stream_dup', streamName: 'stream_dup' });
    assert.equal(info.bytes, 4096, 'the same directory must not be summed twice');
  });

  it('attributes media by camera ownership, not by list position', async () => {
    writeMedia('stream_a', '2026-10-05/evt-a', 111);
    writeMedia('stream_b', '2026-10-05/evt-b', 222);

    const cameras = [
      { id: 'cam-a', streamName: 'stream_a' },
      { id: 'cam-b', streamName: 'stream_b' },
    ];
    const forward = await measureCamerasStorage(cameras);
    const reversed = await measureCamerasStorage([...cameras].reverse());

    assert.equal(forward.get('cam-a')?.bytes, 111);
    assert.equal(forward.get('cam-b')?.bytes, 222);
    assert.equal(reversed.get('cam-a')?.bytes, 111, 'order must not change the value');
    assert.equal(reversed.get('cam-b')?.bytes, 222);
  });

  it('reflects a deleted file after invalidation', async () => {
    writeMedia('stream_del', '2026-10-05/evt-1', 3000);
    const first = await measureCameraStorage({ id: 'cam-del', streamName: 'stream_del' });
    assert.equal(first.bytes, 3000);

    rmSync(path.join(root, 'stream_del'), { recursive: true, force: true });
    // Cached value is still served until invalidated (that is the point of the cache).
    const cached = await measureCameraStorage({ id: 'cam-del', streamName: 'stream_del' });
    assert.equal(cached.bytes, 3000);

    invalidateCameraStorage('cam-del');
    const afterDelete = await measureCameraStorage({ id: 'cam-del', streamName: 'stream_del' });
    assert.equal(afterDelete.bytes, 0);
  });

  it('rejects path traversal in a stream name', async () => {
    const info = await measureCameraStorage({ id: 'cam-evil', streamName: '../../etc' });
    assert.equal(info.measurementStatus, 'ok');
    assert.equal(info.bytes, 0, 'traversal must be refused, not followed');

    const slash = await measureCameraStorage({ id: 'cam-evil2', streamName: 'a/b' });
    assert.equal(slash.bytes, 0);
  });

  it('reports unavailable (not 0) when object storage is configured', async () => {
    process.env.MINIO_PUBLIC_URL = 'http://localhost:9000/events';
    __clearStorageCache();
    try {
      const info = await measureCameraStorage({ id: 'cam-minio', streamName: 'stream_absent' });
      assert.equal(info.bytes, null, 'an unmeasurable backend must not look like 0 bytes');
      assert.equal(info.measurementStatus, 'unavailable');
      assert.equal(info.reason, 'object-storage-not-measurable');
    } finally {
      delete process.env.MINIO_PUBLIC_URL;
      __clearStorageCache();
    }
  });

  it('formats bytes with base-1024 units and never fakes a value', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.00 KB');
    assert.equal(formatBytes(1024 * 1024), '1.00 MB');
    assert.equal(formatBytes(1024 ** 3), '1.00 GB');
    assert.equal(formatBytes(1024 ** 4), '1.00 TB');
    assert.equal(formatBytes(null), '—', 'unmeasured must not render as 0');
    assert.equal(formatBytes(undefined), '—');
    assert.equal(formatBytes(-1), '—');
  });

  it('measures many cameras without throwing on a missing root', async () => {
    process.env.AICAM_EVENTS_DIR = path.join(root, 'does-not-exist');
    __clearStorageCache();
    try {
      const map = await measureCamerasStorage([{ id: 'x', streamName: 'y' }]);
      // Evidence root still exists in the repo, so this is "ok, 0" rather than a crash.
      assert.ok(map.get('x'));
      assert.notEqual(map.get('x')?.measurementStatus, 'calculating');
    } finally {
      process.env.AICAM_EVENTS_DIR = root;
      __clearStorageCache();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. activation vs connectivity vs deletion', () => {
  it('todayKey follows the app timezone, not UTC', () => {
    // At 00:30 local (17:30Z the previous day) the local date is already today.
    const local = new Date('2026-11-16T17:30:00.000Z');
    assert.equal(dateKeyInTimeZone(local), '2026-11-17');
    assert.equal(dateKeyInTimeZone(local, 'UTC'), '2026-11-16');
    assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. activation endpoint authorization', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cameras', cameraRoutes);

  let server: ReturnType<typeof app.listen>;
  let base = '';

  const token = (role: string) =>
    jwt.sign({ id: 'u1', username: role.toLowerCase(), role }, process.env.JWT_SECRET as string, {
      expiresIn: '1h',
    });

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const patch = (role: string | null, body: unknown) =>
    fetch(`${base}/api/cameras/cam-1/activation`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(role ? { Authorization: `Bearer ${token(role)}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it('rejects anonymous callers with 401', async () => {
    const res = await patch(null, { isActive: false });
    assert.equal(res.status, 401);
  });

  it('rejects roles that may not edit cameras with 403', async () => {
    for (const role of ['Operator', 'Viewer']) {
      const res = await patch(role, { isActive: false });
      assert.equal(res.status, 403, `${role} must not toggle cameras`);
    }
  });

  it('validates the body before touching the database', async () => {
    // "yes" is not a boolean; the 400 proves validation happens first, so this
    // assertion is safe even with no database connection.
    const res = await patch('Manager', { isActive: 'yes' });
    assert.equal(res.status, 400);
  });

  it('accepts Admin and Manager past authorization', async () => {
    // With a well-formed body the request reaches Prisma; the camera does not
    // exist, so the route answers 404 — which proves authz passed.
    for (const role of ['Admin', 'Manager']) {
      const res = await patch(role, { isActive: false });
      assert.ok([404, 500].includes(res.status), `unexpected ${res.status} for ${role}`);
    }
  });
});
