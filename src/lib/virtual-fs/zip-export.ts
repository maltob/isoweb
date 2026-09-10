// Zero-dependency streaming ZIP archiver for client-side extraction of entire disk images
import { VNode } from '../types';

export class ZipArchiver {
  /**
   * Builds a standard uncompressed (Store) ZIP archive from a VNode tree
   */
  static async buildZip(
    root: VNode,
    getFileBytes: (node: VNode) => Promise<Uint8Array>,
    onProgress?: (ratio: number, name: string) => void
  ): Promise<Blob> {
    const fileEntries: { path: string; node: VNode }[] = [];

    const collect = (node: VNode) => {
      for (const child of node.children || []) {
        if (child.isDirectory) {
          collect(child);
        } else {
          // relative path without leading slash
          const relPath = child.path.startsWith('/') ? child.path.slice(1) : child.path;
          fileEntries.push({ path: relPath, node: child });
        }
      }
    };
    collect(root);

    const chunks: Uint8Array[] = [];
    const centralDirectoryHeaders: Uint8Array[] = [];
    let currentOffset = 0;

    const total = fileEntries.length;
    for (let i = 0; i < total; i++) {
      const entry = fileEntries[i];
      onProgress?.(i / Math.max(1, total), entry.path);

      const data = await getFileBytes(entry.node);
      const nameBytes = new TextEncoder().encode(entry.path);
      const crc = this.crc32(data);

      // Local file header (30 bytes + filename)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      this.writeUint32LE(localHeader, 0, 0x04034b50); // Local header signature
      this.writeUint16LE(localHeader, 4, 20); // Version needed (2.0)
      this.writeUint16LE(localHeader, 6, 0); // Flags
      this.writeUint16LE(localHeader, 8, 0); // Compression (0 = Store)
      this.writeDosDateTime(localHeader, 10, entry.node.modifiedTime);
      this.writeUint32LE(localHeader, 14, crc);
      this.writeUint32LE(localHeader, 18, data.length); // Compressed size
      this.writeUint32LE(localHeader, 22, data.length); // Uncompressed size
      this.writeUint16LE(localHeader, 26, nameBytes.length);
      this.writeUint16LE(localHeader, 28, 0); // Extra field len
      localHeader.set(nameBytes, 30);

      chunks.push(localHeader);
      chunks.push(data);

      // Central directory header (46 bytes + filename)
      const cdHeader = new Uint8Array(46 + nameBytes.length);
      this.writeUint32LE(cdHeader, 0, 0x02014b50); // CD header signature
      this.writeUint16LE(cdHeader, 4, 20); // Version made by
      this.writeUint16LE(cdHeader, 6, 20); // Version needed
      this.writeUint16LE(cdHeader, 8, 0); // Flags
      this.writeUint16LE(cdHeader, 10, 0); // Compression (0 = Store)
      this.writeDosDateTime(cdHeader, 12, entry.node.modifiedTime);
      this.writeUint32LE(cdHeader, 16, crc);
      this.writeUint32LE(cdHeader, 20, data.length);
      this.writeUint32LE(cdHeader, 24, data.length);
      this.writeUint16LE(cdHeader, 28, nameBytes.length);
      this.writeUint16LE(cdHeader, 30, 0); // Extra field len
      this.writeUint16LE(cdHeader, 32, 0); // Comment len
      this.writeUint16LE(cdHeader, 34, 0); // Disk number
      this.writeUint16LE(cdHeader, 36, 0); // Internal attrs
      this.writeUint32LE(cdHeader, 38, 0); // External attrs
      this.writeUint32LE(cdHeader, 42, currentOffset); // Relative offset of local header
      cdHeader.set(nameBytes, 46);

      centralDirectoryHeaders.push(cdHeader);
      currentOffset += localHeader.length + data.length;
    }

    const cdOffset = currentOffset;
    let cdSize = 0;
    for (const h of centralDirectoryHeaders) {
      chunks.push(h);
      cdSize += h.length;
    }

    // End of Central Directory Record (22 bytes)
    const eocd = new Uint8Array(22);
    this.writeUint32LE(eocd, 0, 0x06054b50); // EOCD signature
    this.writeUint16LE(eocd, 4, 0); // Disk number
    this.writeUint16LE(eocd, 6, 0); // Disk with CD
    this.writeUint16LE(eocd, 8, total); // Total entries on disk
    this.writeUint16LE(eocd, 10, total); // Total entries
    this.writeUint32LE(eocd, 12, cdSize); // Size of central directory
    this.writeUint32LE(eocd, 16, cdOffset); // Offset of CD
    this.writeUint16LE(eocd, 20, 0); // Comment len
    chunks.push(eocd);

    onProgress?.(1.0, 'Finished');
    return new Blob(chunks, { type: 'application/zip' });
  }

  private static crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  private static writeDosDateTime(buf: Uint8Array, offset: number, date: Date): void {
    const time =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const d =
      (((date.getFullYear() - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);

    this.writeUint16LE(buf, offset, time);
    this.writeUint16LE(buf, offset + 2, d);
  }

  private static writeUint16LE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
  }

  private static writeUint32LE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
    buf[offset + 2] = (val >> 16) & 0xff;
    buf[offset + 3] = (val >> 24) & 0xff;
  }
}

// Pre-computed CRC32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c;
}
