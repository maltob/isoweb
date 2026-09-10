// Origin Private File System (OPFS) storage manager
import { SavedOpfsImage } from '../types';

const OPFS_FOLDER = 'vm_images';

export class OpfsManager {
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage;
  }

  private static async getImagesDirectory(): Promise<FileSystemDirectoryHandle> {
    if (!this.isSupported()) {
      throw new Error('OPFS is not supported in this browser.');
    }
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
  }

  static async createStreamWriter(fileName: string): Promise<FileSystemWritableFileStream> {
    const dir = await this.getImagesDirectory();
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    return await fileHandle.createWritable();
  }

  static async listImages(): Promise<SavedOpfsImage[]> {
    if (!this.isSupported()) return [];
    try {
      const dir = await this.getImagesDirectory();
      const images: SavedOpfsImage[] = [];

      // Iterate directory
      // @ts-expect-error entries() is standard async iterable on FileSystemDirectoryHandle
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
          const fileHandle = handle as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          const ext = name.split('.').pop()?.toLowerCase();
          const format = ext === 'iso' ? 'iso' : 'fat12';

          images.push({
            name,
            size: file.size,
            format,
            volumeLabel: name.replace(/\.[^/.]+$/, '').toUpperCase(),
            lastModified: file.lastModified,
          });
        }
      }

      return images.sort((a, b) => b.lastModified - a.lastModified);
    } catch (e) {
      console.error('Failed to list OPFS images:', e);
      return [];
    }
  }

  static async saveImage(
    fileName: string,
    blob: Blob,
    onProgress?: (ratio: number) => void
  ): Promise<void> {
    const dir = await this.getImagesDirectory();
    const fileHandle = await dir.getFileHandle(fileName, { create: true });

    // Try writable stream (standard in modern browsers)
    if ('createWritable' in fileHandle) {
      const writable = await fileHandle.createWritable();
      // Write in 1MB chunks to report progress
      const chunkSize = 1024 * 1024;
      const totalBytes = blob.size;
      let offset = 0;

      while (offset < totalBytes) {
        const slice = blob.slice(offset, offset + chunkSize);
        await writable.write(slice);
        offset += chunkSize;
        onProgress?.(Math.min(1.0, offset / totalBytes));
      }

      await writable.close();
    } else {
      // Fallback
      // @ts-expect-error sync access handle in worker or fallback
      const accessHandle = await fileHandle.createSyncAccessHandle();
      const buffer = await blob.arrayBuffer();
      accessHandle.write(buffer);
      accessHandle.flush();
      accessHandle.close();
    }
  }

  static async getImageFile(fileName: string): Promise<File> {
    const dir = await this.getImagesDirectory();
    const fileHandle = await dir.getFileHandle(fileName);
    return await fileHandle.getFile();
  }

  static async getImageFileHandle(fileName: string): Promise<FileSystemFileHandle> {
    const dir = await this.getImagesDirectory();
    return await dir.getFileHandle(fileName);
  }

  static async deleteImage(fileName: string): Promise<void> {
    const dir = await this.getImagesDirectory();
    await dir.removeEntry(fileName);
  }

  static async getStorageQuota(): Promise<{ usedBytes: number; quotaBytes: number; ratio: number }> {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const usedBytes = estimate.usage || 0;
      const quotaBytes = estimate.quota || 1;
      return {
        usedBytes,
        quotaBytes,
        ratio: Math.min(1, usedBytes / quotaBytes),
      };
    }
    return { usedBytes: 0, quotaBytes: 1, ratio: 0 };
  }
}
