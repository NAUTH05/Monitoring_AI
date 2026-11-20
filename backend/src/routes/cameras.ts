import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Request, Response, Router } from 'express';
import { Server } from 'socket.io';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authenticate, authorize, apiKeyAuth } from '../middleware/auth';
import {
  aiSourceUrl as streamAiSourceUrl,
  buildGo2rtcSource,
  deleteStream,
  makeStreamName,
  playbackUrl,
  probeStream,
  putStream,
  streamExists,
} from '../services/go2rtc';
import {
  type CameraStorageInfo,
  invalidateCameraStorage,
  measureCamerasStorage,
  peekCachedStorage,
} from '../services/storage/camera-storage';

const router = Router();

/** Cameras are measured with bounded concurrency; a slow disk must not hang the list. */
const STORAGE_DEADLINE_MS = 1_500;

function calculatingStorage(): CameraStorageInfo {
  return { bytes: null, measurementStatus: 'calculating', calculatedAt: null, reason: null };
}

/**
 * Measure storage for the cameras on this page, but never wait longer than
 * `STORAGE_DEADLINE_MS`. Measurements continue in the background and populate
 * the cache, so the next poll shows the value instead of blocking this request.
 */
async function storageForPage(
  cameras: { id: string; streamName: string | null }[],
): Promise<Map<string, CameraStorageInfo>> {
  const measurement = measureCamerasStorage(cameras);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), STORAGE_DEADLINE_MS);
  });

  try {
    const outcome = await Promise.race([measurement.then(() => 'done' as const), deadline]);
    if (outcome === 'done') return measurement;

    // Deadline hit: report what is already known, mark the rest as calculating.
    const partial = new Map<string, CameraStorageInfo>();
    for (const camera of cameras) {
      partial.set(camera.id, peekCachedStorage(camera.id) ?? calculatingStorage());
    }
    return partial;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const cameraSchema = z.object({
  name: z.string().min(1).max(100),
  location: z.string().min(1).max(200),
  rtspUrl: z.string().min(1),
  subRtspUrl: z.string().optional(),
  status: z.enum(['ONLINE', 'OFFLINE', 'ERROR']).optional(),
});

// A camera source as described by the wizard. The user never types a go2rtc
// stream name or an `ffmpeg:device?...` string.
const sourceFields = {
  sourceType: z.enum(['rtsp', 'webcam', 'go2rtc', 'nvr']),
  rtspUrl: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  device: z.string().optional(),
  resolution: z.string().optional(),
  fps: z.number().int().positive().optional(),
  streamName: z.string().optional(),
};

const provisionSchema = z.object({
  name: z.string().min(1).max(100),
  location: z.string().min(1).max(200),
  subRtspUrl: z.string().optional(),
  modules: z.array(z.string()).optional(),
  ...sourceFields,
});

const updateSourceSchema = z.object(sourceFields).partial();

// GET /api/cameras
// Storage is MEASURED from disk (see services/storage/camera-storage.ts).
// Resolution comes from persisted camera metadata and is null when unknown —
// neither value is ever derived from the camera's position in the result set.
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', search, status, activation, refreshStorage } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    // Deleted cameras are excluded; deactivated ones stay listed (they are still
    // manageable). `isActive` is now purely administrative activation.
    const where: Record<string, unknown> = { deletedAt: null };
    if (status) where.status = status;
    if (activation === 'active') where.isActive = true;
    else if (activation === 'inactive') where.isActive = false;
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { location: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [cameras, total] = await Promise.all([
      prisma.camera.findMany({
        where,
        include: {
          cameraModules: {
            where: { isEnabled: true },
            include: { module: true },
          },
          _count: { select: { events: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit as string),
      }),
      prisma.camera.count({ where }),
    ]);

    if (refreshStorage === '1' || refreshStorage === 'true') {
      invalidateCameraStorage();
    }

    const storage = await storageForPage(cameras);

    const enrichedCameras = cameras.map((cam) => {
      const info = storage.get(cam.id) ?? calculatingStorage();
      return {
        ...cam,
        // Persisted metadata only. `null` = unknown, rendered as "Unknown".
        resolution: cam.resolution ?? null,
        storage: info,
        // Backward-compatible scalar, derived ONLY from measured bytes.
        storageGb:
          info.measurementStatus === 'ok' && info.bytes !== null
            ? Number((info.bytes / 1024 ** 3).toFixed(3))
            : null,
      };
    });

    res.json({
      success: true,
      data: enrichedCameras,
      meta: { total, page: parseInt(page as string), limit: parseInt(limit as string) },
    });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch cameras' });
  }
});

// GET /api/cameras/:id/ai-config  (called by the AI-Cam runtime, x-api-key auth)
// Read-only, machine-to-machine: returns ONLY what the AI runtime needs to run
// a task (stream URL + per-module runtime config such as the ROI polygon).
// No user/account data and no secrets are exposed. The Python runtime never
// logs in as a human user.
router.get('/:id/ai-config', apiKeyAuth, async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findUnique({
      where: { id: req.params.id },
      include: { cameraModules: { include: { module: true } } },
    });

    if (!camera) {
      res.status(404).json({ success: false, message: 'Camera not found' });
      return;
    }

    // A deleted camera must not be revived by a stale runtime poll.
    if (camera.deletedAt) {
      res.status(404).json({ success: false, message: 'Camera not found' });
      return;
    }

    const modules = camera.cameraModules.map((cm) => ({
      code: cm.module.code,
      enabled: cm.isEnabled,
      config: cm.config ?? {},
    }));

    res.json({
      success: true,
      data: {
        cameraId: camera.id,
        name: camera.name,
        rtspUrl: camera.rtspUrl,
        subRtspUrl: camera.subRtspUrl,
        modules,
      },
    });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to build AI config' });
  }
});

// GET /api/cameras/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findUnique({
      where: { id: req.params.id },
      include: {
        cameraModules: { include: { module: true } },
        _count: { select: { events: true } },
      },
    });

    if (!camera || camera.deletedAt) {
      res.status(404).json({ success: false, message: 'Camera not found' });
      return;
    }

    const storage = await storageForPage([camera]);
    res.json({
      success: true,
      data: {
        ...camera,
        resolution: camera.resolution ?? null,
        storage: storage.get(camera.id) ?? calculatingStorage(),
      },
    });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch camera' });
  }
});

// POST /api/cameras/provision
// Transactional camera creation: validate source -> configure go2rtc -> verify
// the stream is available -> save the camera -> assign AI modules. If go2rtc
// fails we NEVER create a half-broken camera (and any orphan stream is removed).
router.post('/provision', authenticate, authorize('Admin', 'Manager'), async (req: Request, res: Response) => {
  let createdStreamName: string | null = null;
  let cameraCreated = false;
  try {
    const body = provisionSchema.parse(req.body);

    let streamName: string;
    if (body.sourceType === 'go2rtc') {
      if (!body.streamName) {
        res.status(400).json({ success: false, message: 'Select an existing go2rtc stream' });
        return;
      }
      if (!(await streamExists(body.streamName))) {
        res.status(400).json({ success: false, message: `go2rtc stream '${body.streamName}' was not found` });
        return;
      }
      streamName = body.streamName;
    } else {
      const src = buildGo2rtcSource(body);
      if (!src) {
        res.status(400).json({ success: false, message: 'A source URL or capture device is required' });
        return;
      }
      streamName = makeStreamName(randomUUID());
      const put = await putStream(streamName, src);
      if (!put.ok) {
        res.status(400).json({ success: false, message: `go2rtc rejected the source: ${put.error}` });
        return;
      }
      createdStreamName = streamName;
    }

    // Verify the stream is really available BEFORE persisting anything.
    if (!(await probeStream(streamName))) {
      if (createdStreamName) await deleteStream(createdStreamName);
      res.status(400).json({
        success: false,
        message: 'The stream did not become available. Check the source and try again.',
      });
      return;
    }

    const camera = await prisma.camera.create({
      data: {
        name: body.name,
        location: body.location,
        rtspUrl: playbackUrl(streamName),
        subRtspUrl: body.subRtspUrl,
        streamName,
        aiSourceUrl: streamAiSourceUrl(streamName),
        // Only what the wizard actually configured (webcam device). RTSP
        // cameras stay null = unknown instead of guessing a resolution.
        resolution: body.resolution?.trim() || null,
        status: 'ONLINE',
      },
    });
    cameraCreated = true;

    const codes = (body.modules ?? []).map((c) => c.toUpperCase());
    if (codes.length > 0) {
      const modules = await prisma.aiModule.findMany({ where: { code: { in: codes } } });
      for (const module of modules) {
        await prisma.cameraModule.upsert({
          where: { cameraId_moduleId: { cameraId: camera.id, moduleId: module.id } },
          update: { isEnabled: true },
          create: { cameraId: camera.id, moduleId: module.id, isEnabled: true },
        });
      }
    }

    const full = await prisma.camera.findUnique({
      where: { id: camera.id },
      include: { cameraModules: { include: { module: true } } },
    });
    res.status(201).json({ success: true, data: full });
  } catch (err) {
    if (createdStreamName && !cameraCreated) {
      await deleteStream(createdStreamName); // roll back the orphan stream
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, message: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to provision camera' });
  }
});

// POST /api/cameras
router.post('/', authenticate, authorize('Admin', 'Manager'), async (req: Request, res: Response) => {
  try {
    const body = cameraSchema.parse(req.body);
    const camera = await prisma.camera.create({
      data: body,
      include: { cameraModules: { include: { module: true } } },
    });
    res.status(201).json({ success: true, data: camera });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, message: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create camera' });
  }
});

// PUT /api/cameras/:id
// Editing the source updates the EXISTING managed go2rtc stream in place (no
// new camera, no orphan stream).
router.put('/:id', authenticate, authorize('Admin', 'Manager'), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.camera.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deletedAt) {
      res.status(404).json({ success: false, message: 'Camera not found' });
      return;
    }

    const body = cameraSchema.partial().parse(req.body);
    const source = updateSourceSchema.parse(req.body);
    const data: Prisma.CameraUpdateInput = { ...body };

    // Configured resolution is metadata, not a measurement: store it when the
    // wizard supplied one, otherwise leave the existing value untouched.
    if (source.resolution !== undefined) {
      data.resolution = source.resolution?.trim() || null;
    }

    if (source.sourceType) {
      const spec = { ...source, sourceType: source.sourceType };
      if (spec.sourceType === 'go2rtc') {
        if (spec.streamName) {
          if (!(await streamExists(spec.streamName))) {
            res.status(400).json({ success: false, message: `go2rtc stream '${spec.streamName}' was not found` });
            return;
          }
          data.streamName = spec.streamName;
          data.aiSourceUrl = streamAiSourceUrl(spec.streamName);
          data.rtspUrl = playbackUrl(spec.streamName);
        }
      } else {
        const src = buildGo2rtcSource(spec);
        if (!src) {
          res.status(400).json({ success: false, message: 'A source URL or capture device is required' });
          return;
        }
        const streamName = existing.streamName || makeStreamName(existing.id);
        const put = await putStream(streamName, src);
        if (!put.ok) {
          res.status(400).json({ success: false, message: `go2rtc rejected the source: ${put.error}` });
          return;
        }
        if (!(await probeStream(streamName))) {
          res.status(400).json({ success: false, message: 'The stream did not become available. Check the source and try again.' });
          return;
        }
        data.streamName = streamName;
        data.aiSourceUrl = streamAiSourceUrl(streamName);
        data.rtspUrl = playbackUrl(streamName);
      }
    }

    const camera = await prisma.camera.update({
      where: { id: req.params.id },
      data,
      include: { cameraModules: { include: { module: true } } },
    });
    res.json({ success: true, data: camera });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, message: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update camera' });
  }
});

// DELETE /api/cameras/:id
// Soft-deletes the camera and removes its MANAGED go2rtc stream when no other
// camera in the inventory still uses it (never touches a shared/external stream).
// Deletion is now explicit (`deletedAt`) so it no longer collides with the
// administrative activation switch.
router.delete('/:id', authenticate, authorize('Admin'), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findUnique({ where: { id: req.params.id } });
    if (!camera || camera.deletedAt) {
      res.status(404).json({ success: false, message: 'Camera not found' });
      return;
    }

    await prisma.camera.update({
      where: { id: req.params.id },
      data: { isActive: false, deletedAt: new Date() },
    });
    invalidateCameraStorage(camera.id);

    const streamName = camera.streamName;
    if (streamName && streamName.startsWith('cam_')) {
      // A merely deactivated camera keeps its stream so it can be reactivated;
      // only a deleted one releases it.
      const stillUsed = await prisma.camera.count({
        where: { streamName, deletedAt: null },
      });
      if (stillUsed === 0) {
        await deleteStream(streamName);
      }
    }

    res.json({ success: true, data: null });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to delete camera' });
  }
});

// PATCH /api/cameras/:id/activation
// Administrative on/off switch. Deliberately separate from:
//   - DELETE (removal from the inventory)
//   - `status` (runtime connectivity reported by heartbeats)
// The camera stays listed, editable and keeps its modules, ROI, source and
// history. The AI runtime stops/starts only this camera's worker on its next
// runtime-config poll (it already reconciles `enabled` per camera).
router.patch(
  '/:id/activation',
  authenticate,
  authorize('Admin', 'Manager'),
  async (req: Request, res: Response) => {
    try {
      const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);

      const camera = await prisma.camera.findUnique({ where: { id: req.params.id } });
      if (!camera || camera.deletedAt) {
        res.status(404).json({ success: false, message: 'Camera not found' });
        return;
      }

      // Idempotent: repeating the same value is a no-op, not an error.
      if (camera.isActive === isActive) {
        res.json({ success: true, data: camera, meta: { changed: false } });
        return;
      }

      const updated = await prisma.camera.update({
        where: { id: camera.id },
        data: { isActive },
      });

      const io = req.app.get('io') as Server | undefined;
      io?.emit('camera-activation', {
        id: updated.id,
        isActive: updated.isActive,
        updatedAt: updated.updatedAt,
      });

      res.json({ success: true, data: updated, meta: { changed: true } });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ success: false, message: err.errors[0].message });
        return;
      }
      res.status(500).json({ success: false, message: 'Failed to update camera activation' });
    }
  },
);

// PATCH /api/cameras/:id/status
router.patch('/:id/status', authenticate, authorize('Admin', 'Manager'), async (req: Request, res: Response) => {
  try {
    const { status } = z.object({ status: z.enum(['ONLINE', 'OFFLINE', 'ERROR']) }).parse(req.body);
    const camera = await prisma.camera.update({
      where: { id: req.params.id },
      data: { status },
    });
    res.json({ success: true, data: camera });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, message: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update camera status' });
  }
});

// POST /api/cameras/:id/heartbeat  (called by Camera AI, protected by x-api-key)
// Updates CONNECTIVITY only. It must never touch `isActive`: a late heartbeat
// from a camera the admin just switched off must not re-enable it.
router.post('/:id/heartbeat', apiKeyAuth, async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findUnique({ where: { id: req.params.id } });
    if (!camera || camera.deletedAt) {
      res.status(404).json({ success: false, message: 'Camera not found' });
      return;
    }

    const updated = await prisma.camera.update({
      where: { id: req.params.id },
      data: { status: 'ONLINE', lastHeartbeat: new Date() },
    });

    const io = req.app.get('io') as Server;
    io.emit('camera-status', {
      id: updated.id,
      status: updated.status,
      lastHeartbeat: updated.lastHeartbeat,
    });

    res.json({ success: true, data: { id: updated.id, status: updated.status, lastHeartbeat: updated.lastHeartbeat } });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to process heartbeat' });
  }
});

export default router;
