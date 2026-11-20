import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { Server } from 'socket.io';
import { z } from 'zod';
import prisma from '../lib/prisma';
import {
  APP_TIME_ZONE,
  DateRangeError,
  singleDayRange,
  todayKey,
} from '../lib/datetime';
import { buildEventWhere, parsePositiveInt } from '../services/reporting/event-filter';
import { authenticate, apiKeyAuth } from '../middleware/auth';
import { telegramDispatcher } from '../services/telegram';
import { invalidateCameraStorage } from '../services/storage/camera-storage';

const router = Router();

const createEventSchema = z.object({
  cameraId: z.string().min(1),
  eventType: z.enum(['INTRUSION', 'FIRE', 'SMOKE', 'PPE', 'FACE', 'VEHICLE']),
  confidence: z.number().min(0).max(1),
  imageUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  timestamp: z.string().optional(),
});

// Evidence attached to an event (annotated snapshot or recorded video).
const createEvidenceSchema = z.object({
  type: z.enum(['IMAGE', 'VIDEO']),
  url: z.string().min(1),
  objectKey: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  capturedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Relations returned with every event (evidence ordered by sequence). */
const eventInclude = {
  camera: { select: { id: true, name: true, location: true } },
  alert: true,
  evidence: { orderBy: { sequence: 'asc' as const } },
};

// GET /api/events/stats
// Database-backed aggregates for the CURRENT filter, plus "today" and "all time"
// scopes so the UI never claims a total that was computed from one page.
// Registered before `/:id` so "stats" is not treated as an id.
router.get('/stats', authenticate, async (req: Request, res: Response) => {
  try {
    const where = buildEventWhere(req.query);

    // Same non-date filters, but without the date window, for the "today" scope.
    const baseWithoutDates: Prisma.EventWhereInput = { ...where };
    delete baseWithoutDates.timestamp;

    const today = todayKey();
    const todayRange = singleDayRange(today);

    const [filteredTotal, filteredAlerts, confidence, todayTotal, todayAlerts, allTotal, allAlerts] =
      await Promise.all([
        prisma.event.count({ where }),
        prisma.event.count({ where: { ...where, isAlert: true } }),
        prisma.event.aggregate({ where, _avg: { confidence: true } }),
        prisma.event.count({
          where: { ...baseWithoutDates, timestamp: { gte: todayRange.start, lt: todayRange.endExclusive } },
        }),
        prisma.event.count({
          where: {
            ...baseWithoutDates,
            isAlert: true,
            timestamp: { gte: todayRange.start, lt: todayRange.endExclusive },
          },
        }),
        prisma.event.count(),
        prisma.event.count({ where: { isAlert: true } }),
      ]);

    res.json({
      success: true,
      data: {
        timeZone: APP_TIME_ZONE,
        today,
        filtered: {
          totalEvents: filteredTotal,
          totalAlerts: filteredAlerts,
          avgConfidence: confidence._avg.confidence ?? 0,
          alertRate: filteredTotal > 0 ? (filteredAlerts / filteredTotal) * 100 : 0,
        },
        todayScope: { totalEvents: todayTotal, totalAlerts: todayAlerts },
        allTime: { totalEvents: allTotal, totalAlerts: allAlerts },
      },
    });
  } catch (err) {
    if (err instanceof DateRangeError) {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to fetch event statistics' });
  }
});

// GET /api/events
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100_000);
    const limit = parsePositiveInt(req.query.limit, 20, 200);
    const skip = (page - 1) * limit;

    const where = buildEventWhere(req.query);

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        include: eventInclude,
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      meta: { total, page, limit },
    });
  } catch (err) {
    if (err instanceof DateRangeError) {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to fetch events' });
  }
});

// GET /api/events/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: req.params.id },
      include: eventInclude,
    });

    if (!event) {
      res.status(404).json({ success: false, message: 'Event not found' });
      return;
    }

    res.json({ success: true, data: event });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch event' });
  }
});

// POST /api/events  (called by AI camera, protected by x-api-key)
router.post('/', apiKeyAuth, async (req: Request, res: Response) => {
  try {
    const body = createEventSchema.parse(req.body);

    const camera = await prisma.camera.findUnique({ where: { id: body.cameraId } });
    if (!camera) {
      res.status(404).json({ success: false, message: 'Camera not found' });
      return;
    }

    // A confirmed INTRUSION has already been validated end-to-end by the AI
    // pipeline (person detection + ROI overlap + ByteTrack + debounce + dwell),
    // so it must ALWAYS raise an alert — confidence is metadata only. Other
    // event types keep their confidence-based rule.
    const isAlert = body.eventType === 'INTRUSION' || body.confidence >= 0.8;

    const event = await prisma.event.create({
      data: {
        cameraId: body.cameraId,
        eventType: body.eventType,
        confidence: body.confidence,
        imageUrl: body.imageUrl,
        videoUrl: body.videoUrl,
        timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
        isAlert,
      },
      include: {
        camera: { select: { id: true, name: true, location: true } },
      },
    });

    // The first evidence image is the event's primary snapshot (sequence 1).
    if (body.imageUrl) {
      await prisma.evidence.create({
        data: {
          eventId: event.id,
          type: 'IMAGE',
          url: body.imageUrl,
          sequence: 1,
          capturedAt: event.timestamp,
        },
      });
      // New media on disk: the camera's storage figure is stale now.
      invalidateCameraStorage(event.cameraId);
    }

    const io = req.app.get('io') as Server;
    io.emit('new-event', event);

    if (isAlert) {
      const alert = await prisma.alert.create({
        data: { eventId: event.id },
        include: { event: { include: { camera: { select: { id: true, name: true, location: true } } } } },
      });
      io.emit('new-alert', alert);

      // Telegram fan-out. Deliberately NOT awaited: the AI-Cam ingest request
      // must return at HTTP speed and must never fail because Telegram is slow,
      // rate-limited or down. `enqueueAlert` persists PENDING delivery rows and
      // swallows its own errors; the background worker sends them.
      void telegramDispatcher
        .enqueueAlert({
          id: event.id,
          eventType: event.eventType,
          confidence: event.confidence,
          timestamp: event.timestamp,
          isAlert: event.isAlert,
          imageUrl: event.imageUrl,
          videoUrl: event.videoUrl,
          camera: event.camera,
        })
        .catch(() => undefined);
    }

    res.status(201).json({ success: true, data: event });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, message: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create event' });
  }
});

// POST /api/events/:id/evidence  (called by the AI camera, x-api-key)
// Attaches one annotated snapshot or the recorded video to an existing event.
// An intrusion episode is ONE event that accumulates a sequence of evidence.
router.post('/:id/evidence', apiKeyAuth, async (req: Request, res: Response) => {
  try {
    const body = createEvidenceSchema.parse(req.body);

    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) {
      res.status(404).json({ success: false, message: 'Event not found' });
      return;
    }

    let sequence = body.sequence;
    if (sequence === undefined) {
      const last = await prisma.evidence.findFirst({
        where: { eventId: event.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      sequence = (last?.sequence ?? 0) + 1;
    }

    const evidence = await prisma.evidence.create({
      data: {
        eventId: event.id,
        type: body.type,
        url: body.url,
        objectKey: body.objectKey,
        sequence,
        capturedAt: body.capturedAt ? new Date(body.capturedAt) : new Date(),
        durationMs: body.durationMs,
        metadata: body.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    // Mirror into Event.imageUrl / videoUrl for backwards compatibility.
    const patch: Prisma.EventUpdateInput = {};
    if (body.type === 'VIDEO' && !event.videoUrl) patch.videoUrl = body.url;
    if (body.type === 'IMAGE' && !event.imageUrl) patch.imageUrl = body.url;
    if (Object.keys(patch).length > 0) {
      await prisma.event.update({ where: { id: event.id }, data: patch });
    }

    invalidateCameraStorage(event.cameraId);

    const io = req.app.get('io') as Server;
    io.emit('new-evidence', { eventId: event.id, evidence });

    res.status(201).json({ success: true, data: evidence });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, message: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to attach evidence' });
  }
});

// PATCH /api/events/alerts/:alertId/read
// Called when a notification is opened (toast / bell / event detail).
router.patch('/alerts/:alertId/read', authenticate, async (req: Request, res: Response) => {
  try {
    const alert = await prisma.alert.update({
      where: { id: req.params.alertId },
      data: { status: 'READ' },
    });
    res.json({ success: true, data: alert });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to mark alert as read' });
  }
});

// PATCH /api/events/alerts/:alertId/acknowledge
router.patch('/alerts/:alertId/acknowledge', authenticate, async (req: Request, res: Response) => {
  try {
    const alert = await prisma.alert.update({
      where: { id: req.params.alertId },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
    });
    res.json({ success: true, data: alert });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to acknowledge alert' });
  }
});

export default router;
