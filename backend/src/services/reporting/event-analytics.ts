/**
 * Event analytics for the Reports module.
 *
 * All figures come from the `events` table in `smart_monitoring` (the same
 * source the Events page lists). Nothing is sampled, mocked or inferred.
 *
 * Day buckets are computed by PostgreSQL with `AT TIME ZONE`, so an event at
 * 00:30 Asia/Ho_Chi_Minh lands in that local day even though its UTC timestamp
 * is still the previous day. Doing this in SQL also keeps the query bounded:
 * one grouped scan instead of loading every row into Node.
 *
 * Totals are derived from the buckets on purpose — the sum of the daily series
 * is then guaranteed to equal the headline number, so the chart and the KPI can
 * never disagree.
 */
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import {
  APP_TIME_ZONE,
  type UtcRange,
  enumerateDateKeys,
} from '../../lib/datetime';

export interface DailyBucket {
  /** `YYYY-MM-DD` in the reporting timezone. */
  date: string;
  count: number;
  alerts: number;
}

export interface TypeBucket {
  type: string;
  count: number;
}

export interface PeriodTotals {
  totalEvents: number;
  totalAlerts: number;
  /** Alerts as a percentage of events (0 when there are no events). */
  alertRate: number;
}

/** Zero-filled daily series for a range, one bucket per calendar day. */
export async function dailyBuckets(
  range: UtcRange,
  timeZone: string = APP_TIME_ZONE,
): Promise<DailyBucket[]> {
  const rows = await prisma.$queryRaw<{ day: string; count: number; alerts: number }[]>`
    SELECT to_char(timestamp AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE is_alert)::int AS alerts
    FROM events
    WHERE timestamp >= ${range.start} AND timestamp < ${range.endExclusive}
    GROUP BY 1
    ORDER BY 1
  `;

  const byDay = new Map<string, DailyBucket>();
  for (const row of rows) {
    byDay.set(row.day, {
      date: row.day,
      count: Number(row.count) || 0,
      alerts: Number(row.alerts) || 0,
    });
  }

  // Fill gaps so a time-series axis is complete and continuous.
  return enumerateDateKeys(range.startKey, range.endKey).map(
    (date) => byDay.get(date) ?? { date, count: 0, alerts: 0 },
  );
}

/** Event counts per event type. One row per event — evidence is never joined. */
export async function typeBreakdown(range: UtcRange): Promise<TypeBucket[]> {
  const groups = await prisma.event.groupBy({
    by: ['eventType'],
    where: { timestamp: { gte: range.start, lt: range.endExclusive } },
    _count: { _all: true },
    orderBy: { _count: { eventType: 'desc' } },
  });

  return groups
    .map((group) => ({ type: group.eventType as string, count: group._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** Totals derived from the daily series (single source of truth). */
export function totalsFromBuckets(buckets: DailyBucket[]): PeriodTotals {
  let totalEvents = 0;
  let totalAlerts = 0;
  for (const bucket of buckets) {
    totalEvents += bucket.count;
    totalAlerts += bucket.alerts;
  }
  return {
    totalEvents,
    totalAlerts,
    alertRate: totalEvents > 0 ? (totalAlerts / totalEvents) * 100 : 0,
  };
}

/** Convenience: buckets + types + totals for a range, in two queries. */
export async function periodReport(
  range: UtcRange,
  timeZone: string = APP_TIME_ZONE,
): Promise<{ buckets: DailyBucket[]; byType: TypeBucket[]; totals: PeriodTotals }> {
  const [buckets, byType] = await Promise.all([dailyBuckets(range, timeZone), typeBreakdown(range)]);
  return { buckets, byType, totals: totalsFromBuckets(buckets) };
}

/** Bounded event list for the daily report (the UI shows aggregates, not rows). */
export async function eventsInRange(range: UtcRange, take = 1000) {
  return prisma.event.findMany({
    where: { timestamp: { gte: range.start, lt: range.endExclusive } },
    include: { camera: { select: { name: true, location: true } } },
    orderBy: { timestamp: 'desc' },
    take,
  });
}

export type { Prisma };
