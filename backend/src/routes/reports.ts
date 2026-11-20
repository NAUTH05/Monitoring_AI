import { Request, Response, Router } from 'express';
import prisma from '../lib/prisma';
import {
  APP_TIME_ZONE,
  DateRangeError,
  addDaysToKey,
  monthRangeUtc,
  parseDateKeyParts,
  singleDayRange,
  todayKey,
  weekRangeUtc,
} from '../lib/datetime';
import { authenticate } from '../middleware/auth';
import {
  dailyBuckets,
  eventsInRange,
  periodReport,
} from '../services/reporting/event-analytics';

const router = Router();

/**
 * All report endpoints resolve a calendar period in the application timezone and
 * hand a half-open `[start, endExclusive)` interval to the aggregation layer.
 * Missing/invalid input answers 400 instead of silently reporting a different
 * period than the one the user asked for.
 */
function badRequest(res: Response, err: unknown): boolean {
  if (err instanceof DateRangeError) {
    res.status(400).json({ success: false, message: err.message });
    return true;
  }
  return false;
}

// GET /api/reports/dashboard
router.get('/dashboard', authenticate, async (_req: Request, res: Response) => {
  try {
    const today = todayKey();
    const todayRange = singleDayRange(today);
    // Last 7 calendar days, ending today (inclusive).
    const weekStartKey = addDaysToKey(today, -6);
    const weekRange = {
      start: singleDayRange(weekStartKey).start,
      endExclusive: todayRange.endExclusive,
      startKey: weekStartKey,
      endKey: today,
    };

    const [totalCameras, onlineCameras, offlineCameras, todayAlerts, weekBuckets] = await Promise.all([
      prisma.camera.count({ where: { deletedAt: null } }),
      prisma.camera.count({ where: { status: 'ONLINE', deletedAt: null } }),
      prisma.camera.count({ where: { status: 'OFFLINE', deletedAt: null } }),
      prisma.event.count({
        where: { isAlert: true, timestamp: { gte: todayRange.start, lt: todayRange.endExclusive } },
      }),
      dailyBuckets(weekRange),
    ]);

    const weekAlerts = weekBuckets.reduce((acc, bucket) => acc + bucket.alerts, 0);

    const topCameras = await (async () => {
      const groups = await prisma.event.groupBy({
        by: ['cameraId'],
        where: { isAlert: true },
        _count: { _all: true },
      });
      groups.sort((a, b) => b._count._all - a._count._all);
      const top5 = groups.slice(0, 5);
      const cameraIds = top5.map((g) => g.cameraId);
      const cams = await prisma.camera.findMany({
        where: { id: { in: cameraIds } },
        select: { id: true, name: true },
      });
      return top5.map((g) => ({
        cameraId: g.cameraId,
        cameraName: cams.find((c) => c.id === g.cameraId)?.name ?? 'Unknown',
        count: g._count._all,
      }));
    })();

    res.json({
      success: true,
      data: {
        timeZone: APP_TIME_ZONE,
        totalCameras,
        onlineCameras,
        offlineCameras,
        todayAlerts,
        weekAlerts,
        dailyStats: weekBuckets.map((bucket) => ({ date: bucket.date, count: bucket.count })),
        topCameras,
      },
    });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats' });
  }
});

// GET /api/reports/daily?date=YYYY-MM-DD   (default: today in the app timezone)
router.get('/daily', authenticate, async (req: Request, res: Response) => {
  try {
    const dateKey = typeof req.query.date === 'string' && req.query.date ? req.query.date : todayKey();
    parseDateKeyParts(dateKey); // validates (throws DateRangeError)

    const range = singleDayRange(dateKey);
    const [report, events] = await Promise.all([periodReport(range), eventsInRange(range)]);
    const { buckets, byType, totals } = report;

    res.json({
      success: true,
      data: {
        date: dateKey,
        timeZone: APP_TIME_ZONE,
        ...totals,
        // Kept for backward compatibility: a flat {TYPE: count} map.
        byType: Object.fromEntries(byType.map((bucket) => [bucket.type, bucket.count])),
        byTypeList: byType,
        dailyData: buckets,
        events,
      },
    });
  } catch (err) {
    if (badRequest(res, err)) return;
    res.status(500).json({ success: false, message: 'Failed to fetch daily report' });
  }
});

// GET /api/reports/weekly?date=YYYY-MM-DD   (reference date; week runs Mon..Sun)
// `?startDate=` is still accepted and snapped to the containing week.
router.get('/weekly', authenticate, async (req: Request, res: Response) => {
  try {
    const raw = req.query.date ?? req.query.startDate;
    const referenceKey = typeof raw === 'string' && raw ? raw : todayKey();
    parseDateKeyParts(referenceKey); // validates

    const range = weekRangeUtc(referenceKey);
    const report = await periodReport(range);

    res.json({
      success: true,
      data: {
        timeZone: APP_TIME_ZONE,
        startDate: range.startKey,
        endDate: range.endKey,
        ...report.totals,
        dailyData: report.buckets,
        byType: report.byType,
      },
    });
  } catch (err) {
    if (badRequest(res, err)) return;
    res.status(500).json({ success: false, message: 'Failed to fetch weekly report' });
  }
});

// GET /api/reports/monthly?year=2026&month=10   (default: current month)
router.get('/monthly', authenticate, async (req: Request, res: Response) => {
  try {
    const today = parseDateKeyParts(todayKey());
    const year = req.query.year !== undefined && String(req.query.year) !== ''
      ? Number(req.query.year)
      : today.year;
    const month = req.query.month !== undefined && String(req.query.month) !== ''
      ? Number(req.query.month)
      : today.month;

    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      throw new DateRangeError('year and month must be integers');
    }

    const range = monthRangeUtc(year, month);
    const report = await periodReport(range);

    res.json({
      success: true,
      data: {
        timeZone: APP_TIME_ZONE,
        year,
        month,
        startDate: range.startKey,
        endDate: range.endKey,
        ...report.totals,
        dailyData: report.buckets,
        byType: report.byType,
      },
    });
  } catch (err) {
    if (badRequest(res, err)) return;
    res.status(500).json({ success: false, message: 'Failed to fetch monthly report' });
  }
});

export default router;
