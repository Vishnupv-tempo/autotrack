import type { OpfsVideoEntry, StorageUsageInfo } from '../types/tracking';

const OPFS_FOLDER_NAME = 'pitchtrace-videos';
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|mkv|ogg)$/i;

/** Fallback in-memory storage if Origin Private File System is blocked by sandbox permissions */
const memoryFallbackStore = new Map<string, File>();

async function getVideoDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    return null;
  }

  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_FOLDER_NAME, { create: true });
  } catch {
    return null;
  }
}

export async function isOpfsAvailable(): Promise<boolean> {
  const dir = await getVideoDirectory();
  return dir !== null;
}

export async function listOpfsVideos(): Promise<OpfsVideoEntry[]> {
  const dir = await getVideoDirectory();
  if (!dir) {
    return Array.from(memoryFallbackStore.values())
      .map((file) => ({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type || 'video/mp4',
        storageKind: 'memory' as const,
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  const entries: OpfsVideoEntry[] = [];
  // TypeScript's DOM lib types vary on FileSystemDirectoryHandle async iterator
  const dirAny = dir as unknown as {
    entries: () => AsyncIterable<[string, FileSystemHandle]>;
  };

  for await (const [name, handle] of dirAny.entries()) {
    if (handle.kind === 'file' && VIDEO_EXTENSIONS.test(name)) {
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      entries.push({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type || guessMimeType(file.name),
        storageKind: 'opfs',
      });
    }
  }

  return entries.sort((a, b) => b.lastModified - a.lastModified);
}

export async function saveFileToOpfs(
  fileOrBlob: File | Blob,
  requestedName?: string,
  onProgress?: (percent: number) => void
): Promise<OpfsVideoEntry> {
  const safeName = sanitizeFileName(
    requestedName || (fileOrBlob instanceof File ? fileOrBlob.name : `match_${Date.now()}.webm`)
  );
  const mimeType = fileOrBlob.type || guessMimeType(safeName);
  const dir = await getVideoDirectory();

  if (!dir) {
    const wrapped =
      fileOrBlob instanceof File
        ? new File([fileOrBlob], safeName, { type: mimeType, lastModified: Date.now() })
        : new File([fileOrBlob], safeName, { type: mimeType, lastModified: Date.now() });
    memoryFallbackStore.set(safeName, wrapped);
    onProgress?.(100);
    return {
      name: wrapped.name,
      size: wrapped.size,
      lastModified: wrapped.lastModified,
      type: mimeType,
      storageKind: 'memory',
    };
  }

  const fileHandle = await dir.getFileHandle(safeName, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    const total = fileOrBlob.size;
    if (total > 0 && typeof fileOrBlob.stream === 'function') {
      const reader = fileOrBlob.stream().getReader();
      let written = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await writable.write(value);
          written += value.byteLength;
          onProgress?.(Math.min(99, Math.round((written / total) * 100)));
        }
      }
    } else {
      await writable.write(fileOrBlob);
    }
    await writable.close();
    onProgress?.(100);
  } catch (err) {
    await writable.abort();
    throw err;
  }

  const savedFile = await fileHandle.getFile();
  return {
    name: savedFile.name,
    size: savedFile.size,
    lastModified: savedFile.lastModified,
    type: savedFile.type || mimeType,
    storageKind: 'opfs',
  };
}

export async function getOpfsVideoFile(fileName: string): Promise<File | null> {
  const dir = await getVideoDirectory();
  if (!dir) {
    return memoryFallbackStore.get(fileName) ?? null;
  }

  try {
    const fileHandle = await dir.getFileHandle(fileName);
    return await fileHandle.getFile();
  } catch {
    return memoryFallbackStore.get(fileName) ?? null;
  }
}

export async function deleteOpfsVideo(fileName: string): Promise<void> {
  memoryFallbackStore.delete(fileName);
  const dir = await getVideoDirectory();
  if (!dir) return;

  try {
    await dir.removeEntry(fileName);
  } catch {
    // Ignore if already removed
  }
}

export async function getOpfsStorageEstimate(): Promise<StorageUsageInfo> {
  const opfsReady = await isOpfsAvailable();
  if (!opfsReady) {
    let total = 0;
    memoryFallbackStore.forEach((f) => {
      total += f.size;
    });
    return {
      usageBytes: total,
      quotaBytes: 512 * 1024 * 1024,
      backend: 'memory',
    };
  }

  try {
    const estimate = await navigator.storage.estimate();
    return {
      usageBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? 0,
      backend: 'opfs',
    };
  } catch {
    return {
      usageBytes: 0,
      quotaBytes: 0,
      backend: 'opfs',
    };
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (VIDEO_EXTENSIONS.test(cleaned)) {
    return cleaned;
  }
  return `${cleaned}.mp4`;
}

function guessMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.ogg')) return 'video/ogg';
  return 'video/mp4';
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, idx);
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}
