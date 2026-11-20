/**
 * Shared event filter builder.
 *
 * Extracted from the route so the date semantics can be unit-tested without an
 * HTTP server, and so `/api/events` and `/api/events/stats` can never drift
 * apart (the statistics must describe exactly the list the user is looking at).
 */
import { Prisma } from '@prisma/client';
import { APP_TIME_ZONE, resolveOptionalRange } from '../../lib/datetime';

export interface EventFilterQuery {
  type?: unknown;
  cameraId?: unknown;
  isAlert?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

/**
 * Build the Prisma filter for the given query.
 *
 * `startDate` / `endDate` are calendar days (`YYYY-MM-DD`) in the application
 * timezone, converted to a half-open `[start, nextMidnight)` UTC interval:
 *  - the last day of a range is fully included,
 *  - an event at 00:30 local time belongs to that local day,
 *  - omitting both keeps the query unbounded (backward compatible).
 *
 * Throws `DateRangeError` for malformed or inverted dates.
 */
export function buildEventWhere(query: EventFilterQuery): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = {};

  if (typeof query.type === 'string' && query.type) {
    where.eventType = query.type as never;
  }
  if (typeof query.cameraId === 'string' && query.cameraId) {
    where.cameraId = query.cameraId;
  }
  if (query.isAlert !== undefined && query.isAlert !== null && query.isAlert !== '') {
    where.isAlert = query.isAlert === 'true';
  }

  const range = resolveOptionalRange(query.startDate, query.endDate, APP_TIME_ZONE);
  if (range.start || range.endExclusive) {
    where.timestamp = {
      ...(range.start ? { gte: range.start } : {}),
      ...(range.endExclusive ? { lt: range.endExclusive } : {}),
    };
  }

  return where;
}

/** Clamp pagination input so a hostile `limit` cannot scan the whole table. */
export function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
