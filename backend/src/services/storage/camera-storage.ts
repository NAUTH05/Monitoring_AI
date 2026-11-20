/**
 * Camera storage accounting.
 *
 * "Storage" means the **actual bytes of persisted media that belong to a
 * camera**, measured from the filesystem — never estimated from event counts,
 * bitrate or array position.
 *
 * Where the media lives (verified against the running deployment):
 *   - AI-Cam episodes: `<AICAM_EVENTS_DIR>/<streamName>/<YYYY-MM-DD>/<eventId>/…`
 *     (served by `GET /api/aicam-media/*`). The first path segment is the
 *     camera's go2rtc `streamName`.
 *   - Manual capture: `backend/evidence/{snap|rec}_<streamName>_<timestamp>.<ext>`
 *     (served by `GET /evidence/*`).
 *
 * Both are attributed by the camera's `streamName` (falling back to the camera
 * id, which older deployments used as the folder name).
 *
 * Measurement states are explicit:
 *   - `ok`          → `bytes` is a real number (0 means "measured, nothing there")
 *   - `unavailable` → we could NOT measure; `bytes` is null and must not be shown
 *                     as 0
 *   - `calculating` → a measurement is in flight (only used by callers that
 *                     render before the first pass finishes)
 */
import { promises as fs } from 'fs';
import path from 'path';

export type StorageMeasurementStatus = 'ok' | 'unavailable' | 'calculating';

export interface CameraStorageInfo {
  /** Measured bytes, or null when the measurement failed. */
  bytes: number | null;
  measurementStatus: StorageMeasurementStatus;
  /** ISO timestamp of the measurement, or null when it never succeeded. */
  calculatedAt: string | null;
  /** Machine-readable reason when `measurementStatus === 'unavailable'`. */
  reason?: string | null;
}

export interface StorageTarget {
  id: string;
  streamName?: string | null;
}

const CACHE_TTL_MS = 30_000;
const MAX_ENTRIES_PER_CAMERA = 100_000;
const CONCURRENCY = 4;

interface CacheEntry {
  info: CameraStorageInfo;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop cached measurements (all, or one camera). */
export function invalidateCameraStorage(cameraId?: string): void {
  if (cameraId) cache.delete(cameraId);
  else cache.clear();
}

/** Directory the AI runtime writes evidence into. */
function aicamRoot(): string {
  const configured = process.env.AICAM_EVENTS_DIR;
  if (configured && configured.trim()) {
    return path.resolve(process.cwd(), configured.trim());
  }
  // Same default the media proxy uses when the env var is absent.
  return path.resolve(process.cwd(), '../ai-cam/data/events');
}

/** Directory the manual capture endpoints write into (`backend/evidence`). */
function evidenceRoot(): string {
  return path.join(__dirname, '../../evidence');
}

/**
 * Reject anything that could escape the media root. Folder names come from the
 * database, so a corrupted `streamName` must not become a path traversal.
 */
function safeSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('\0')) return null;
  // Only the characters the runtime actually uses for stream names.
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(trimmed)) return null;
  return trimmed;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readdirSafe(target: string) {
  try {
    return await fs.readdir(target, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * Sum regular-file sizes under `dir`, without following symlinks.
 * Returns `{ bytes, entries, failed }`; `failed` means at least one entry could
 * not be stat'ed, which makes the total untrustworthy.
 */
async function sumDirectory(dir: string): Promise<{ bytes: number; entries: number; failed: boolean }> {
  let bytes = 0;
  let entries = 0;
  let failed = false;

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const children = await readdirSafe(current);
    if (!children) {
      failed = true;
      continue;
    }

    for (const child of children) {
      entries += 1;
      if (entries > MAX_ENTRIES_PER_CAMERA) return { bytes, entries, failed: true };

      const full = path.join(current, child.name);
      if (child.isSymbolicLink()) continue;

      if (child.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!child.isFile()) continue;

      try {
        const stat = await fs.stat(full);
        bytes += stat.size;
      } catch {
        // A file can disappear between readdir and stat (rotation, cleanup).
        failed = true;
      }
    }
  }

  return { bytes, entries, failed };
}

/** Sum evidence files whose name starts with `snap_<stream>_` / `rec_<stream>_`. */
async function sumEvidenceFiles(
  root: string,
  segment: string,
): Promise<{ bytes: number; failed: boolean }> {
  const children = await readdirSafe(root);
  if (!children) return { bytes: 0, failed: false }; // missing dir is not an error

  const prefixes = [`snap_${segment}_`, `rec_${segment}_`];
  let bytes = 0;
  let failed = false;

  for (const child of children) {
    if (!child.isFile() || child.isSymbolicLink()) continue;
    if (!prefixes.some((prefix) => child.name.startsWith(prefix))) continue;

    try {
      const stat = await fs.stat(path.join(root, child.name));
      bytes += stat.size;
    } catch {
      failed = true;
    }
  }

  return { bytes, failed };
}

async function measureOne(target: StorageTarget): Promise<CameraStorageInfo> {
  const segments = Array.from(
    new Set([safeSegment(target.streamName), safeSegment(target.id)].filter(Boolean) as string[]),
  );

  const aicam = aicamRoot();
  const evidence = evidenceRoot();

  const [aicamExists, evidenceExists] = await Promise.all([isDirectory(aicam), isDirectory(evidence)]);

  // Neither media root exists: the deployment is misconfigured, which is NOT
  // the same thing as "this camera has no media".
  if (!aicamExists && !evidenceExists) {
    return {
      bytes: null,
      measurementStatus: 'unavailable',
      calculatedAt: null,
      reason: 'media-root-missing',
    };
  }

  let totalBytes = 0;
  let failed = false;
  // One physical file counted once, even if both a stream name and an id match.
  const seen = new Set<string>();

  for (const segment of segments) {
    const dir = path.join(aicam, segment);
    // Defence in depth: the join must stay inside the media root.
    if (!dir.startsWith(aicam + path.sep)) continue;

    if (aicamExists && (await isDirectory(dir))) {
      const result = await sumDirectory(dir);
      totalBytes += result.bytes;
      failed = failed || result.failed;
      seen.add(dir);
    }

    if (evidenceExists) {
      const result = await sumEvidenceFiles(evidence, segment);
      totalBytes += result.bytes;
      failed = failed || result.failed;
    }
  }

  if (failed) {
    return {
      bytes: null,
      measurementStatus: 'unavailable',
      calculatedAt: null,
      reason: 'read-error',
    };
  }

  // Object storage configured but nothing on disk: the media may live in MinIO,
  // which this service cannot enumerate without an S3 credential/SDK. Reporting
  // 0 here would be a lie, so the measurement is explicitly unavailable.
  const objectStorageConfigured = Boolean(
    process.env.MINIO_PUBLIC_URL || process.env.MINIO_HOST || process.env.MINIO_BUCKET,
  );
  if (totalBytes === 0 && objectStorageConfigured) {
    return {
      bytes: null,
      measurementStatus: 'unavailable',
      calculatedAt: null,
      reason: 'object-storage-not-measurable',
    };
  }

  return {
    bytes: totalBytes,
    measurementStatus: 'ok',
    calculatedAt: new Date().toISOString(),
    reason: null,
  };
}

/**
 * Measure several cameras with bounded concurrency, using the short-lived cache.
 * Never throws: a failure becomes an `unavailable` measurement for that camera.
 */
export async function measureCamerasStorage(
  targets: StorageTarget[],
  options: { force?: boolean } = {},
): Promise<Map<string, CameraStorageInfo>> {
  const result = new Map<string, CameraStorageInfo>();
  const now = Date.now();

  const pending: StorageTarget[] = [];
  for (const target of targets) {
    const cached = cache.get(target.id);
    if (!options.force && cached && cached.expiresAt > now) {
      result.set(target.id, cached.info);
    } else {
      pending.push(target);
    }
  }

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;

      const target = pending[index];
      let info: CameraStorageInfo;
      try {
        info = await measureOne(target);
      } catch {
        info = {
          bytes: null,
          measurementStatus: 'unavailable',
          calculatedAt: null,
          reason: 'measurement-failed',
        };
      }

      cache.set(target.id, { info, expiresAt: Date.now() + CACHE_TTL_MS });
      result.set(target.id, info);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, worker),
  );

  return result;
}

/** Convenience wrapper for a single camera. */
export async function measureCameraStorage(
  target: StorageTarget,
  options: { force?: boolean } = {},
): Promise<CameraStorageInfo> {
  const map = await measureCamerasStorage([target], options);
  return (
    map.get(target.id) ?? {
      bytes: null,
      measurementStatus: 'unavailable',
      calculatedAt: null,
      reason: 'measurement-failed',
    }
  );
}

/** Human-readable byte size using base-1024 units (UI and logs). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const decimals = exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

/** Exposed for tests: the cache is process-wide. */
export function __clearStorageCache(): void {
  cache.clear();
}

/** Last cached measurement for a camera, without triggering any I/O. */
export function peekCachedStorage(cameraId: string): CameraStorageInfo | null {
  const entry = cache.get(cameraId);
  if (!entry) return null;
  return entry.expiresAt > Date.now() ? entry.info : null;
}
