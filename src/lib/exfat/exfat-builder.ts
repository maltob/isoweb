// High-performance exFAT volume builder
// Formats exFAT partitions with zero-RAM chunked streaming
import { ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import {
  EXFAT_OEM_NAME,
  EXFAT_SECTOR_SIZE,
  ExFatEntryType,
  ExFatFileAttributes,
  ExFatGeometry,
} from './exfat-types';

const ZERO_BUFFER_SIZE = 2 * 1024 * 1024; // 2 MB buffer for fast bulk streaming
const ZERO_BUFFER = new Uint8Array(ZERO_BUFFER_SIZE);

// Build compressed Unicode BMP Upcase Table per Microsoft exFAT specification (run-length encoded with 0xFFFF)
function buildUpcaseTable(): { bytes: Uint8Array; checksum: number } {
  const words: number[] = [];
  let i = 0;
  while (i < 65536) {
    const ch = String.fromCharCode(i);
    const upStr = ch.toUpperCase();
    const up = upStr.length === 1 ? upStr.charCodeAt(0) : i;
    if (up === i) {
      let j = i + 1;
      while (j < 65536) {
        const chJ = String.fromCharCode(j);
        const upStrJ = chJ.toUpperCase();
        const upJ = upStrJ.length === 1 ? upStrJ.charCodeAt(0) : j;
        if (upJ !== j) break;
        j++;
      }
      const run = j - i;
      if (run >= 3) {
        words.push(0xffff);
        words.push(run);
        i = j;
        continue;
      }
    }
    words.push(up);
    i++;
  }

  const bytes = new Uint8Array(words.length * 2);
  for (let k = 0; k < words.length; k++) {
    bytes[k * 2] = words[k] & 0xff;
    bytes[k * 2 + 1] = (words[k] >> 8) & 0xff;
  }

  let checksum = 0;
  for (let k = 0; k < bytes.length; k++) {
    checksum = (((checksum << 31) | (checksum >>> 1)) + bytes[k]) >>> 0;
  }

  return { bytes, checksum };
}

const { bytes: UPCASE_TABLE_BYTES, checksum: UPCASE_TABLE_CHECKSUM } = buildUpcaseTable();

interface AllocatedClusterItem {
  node: VNode;
  startCluster: number;
  clusterCount: number;
  size: number;
  isDir: boolean;
}

export class ExFatBuilder {
  private root: VNode;
  private volumeLabel: string;
  private totalSectors: number;
  private padToCapacity: boolean;
  private partitionOffset: number;

  constructor(
    root: VNode,
    volumeLabel: string = 'EXFAT_DISK',
    totalSectors: number = 2097152,
    padToCapacity: boolean = true,
    partitionOffset: number = 0
  ) {
    this.root = root;
    this.volumeLabel = volumeLabel.slice(0, 11);
    this.totalSectors = Math.max(65536, totalSectors); // Minimum 32MB for exFAT
    this.padToCapacity = padToCapacity;
    this.partitionOffset = partitionOffset;
  }

  computeGeometry(): ExFatGeometry {
    const bytesPerSector = EXFAT_SECTOR_SIZE;
    const bytesPerSectorShift = 9;

    // Cluster size: 4KB (8 sectors) for <= 256MB, 32KB (64 sectors) for larger
    const sectorsPerCluster = this.totalSectors > 524288 ? 64 : 8;
    const sectorsPerClusterShift = Math.round(Math.log2(sectorsPerCluster));
    const clusterSizeBytes = sectorsPerCluster * bytesPerSector;

    const fatOffset = 32; // Standard sector 32
    // Estimate clusters to size the FAT table
    const maxClusters = Math.floor(this.totalSectors / sectorsPerCluster);
    const estimatedFatLength = Math.max(1, Math.ceil(((maxClusters + 2) * 4) / bytesPerSector));

    // Align Cluster Heap to 2048 sectors (1MB) after the FAT table
    const alignSectors = 2048;
    const clusterHeapOffset = Math.ceil((fatOffset + estimatedFatLength) / alignSectors) * alignSectors;

    const dataSectors = Math.max(0, this.totalSectors - clusterHeapOffset);
    const clusterCount = Math.floor(dataSectors / sectorsPerCluster);
    const fatLength = Math.max(1, Math.ceil(((clusterCount + 2) * 4) / bytesPerSector));

    const bitmapSizeBytes = Math.ceil(clusterCount / 8);
    const bitmapClusterCount = Math.max(1, Math.ceil(bitmapSizeBytes / clusterSizeBytes));
    const bitmapStartCluster = 2;

    const upcaseSizeBytes = UPCASE_TABLE_BYTES.byteLength;
    const upcaseClusterCount = Math.max(1, Math.ceil(upcaseSizeBytes / clusterSizeBytes));
    const upcaseStartCluster = bitmapStartCluster + bitmapClusterCount;

    const rootDirCluster = upcaseStartCluster + upcaseClusterCount;

    return {
      totalSectors: this.totalSectors,
      bytesPerSectorShift,
      bytesPerSector,
      sectorsPerClusterShift,
      sectorsPerCluster,
      clusterSizeBytes,
      fatOffset,
      fatLength,
      clusterHeapOffset,
      clusterCount,
      bitmapStartCluster,
      bitmapClusterCount,
      bitmapSizeBytes,
      upcaseStartCluster,
      upcaseClusterCount,
      upcaseSizeBytes,
      rootDirCluster,
      volumeLabel: this.volumeLabel,
    };
  }

  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    onProgress?.(0.05, 'Calculating exFAT geometry...');
    const geo = this.computeGeometry();

    // 1. Allocate clusters
    onProgress?.(0.15, 'Allocating exFAT clusters...');
    const allocation = this.allocateClusters(geo);

    // 2. Generate Boot Region (Main 12 sectors + Backup 12 sectors)
    onProgress?.(0.25, 'Writing exFAT boot region...');
    const bootRegion = this.generateBootRegion(geo);
    await writer.write(bootRegion);

    // Pad from Sector 24 up to FatOffset (Sector 32)
    const padToFat = (geo.fatOffset - 24) * geo.bytesPerSector;
    if (padToFat > 0) {
      await writer.write(new Uint8Array(padToFat));
    }

    // 3. Write FAT Table
    onProgress?.(0.35, 'Writing exFAT File Allocation Table...');
    const fatBytes = this.generateFatTable(geo, allocation);
    await writer.write(fatBytes);

    // Pad up to ClusterHeapOffset (Sector 2048)
    const sectorsWrittenSoFar = geo.fatOffset + geo.fatLength;
    const padToHeap = Math.max(0, (geo.clusterHeapOffset - sectorsWrittenSoFar) * geo.bytesPerSector);
    if (padToHeap > 0) {
      await writer.write(new Uint8Array(padToHeap));
    }

    // 4. Cluster bitmapStartCluster..: Allocation Bitmap
    onProgress?.(0.45, 'Writing Allocation Bitmap...');
    const bitmapBytes = this.generateAllocationBitmap(geo, allocation);
    await writer.write(bitmapBytes);

    // 5. Cluster upcaseStartCluster..: Upcase Table
    onProgress?.(0.5, 'Writing Upcase Table...');
    const upcaseBytes = this.generateUpcaseTable(geo);
    await writer.write(upcaseBytes);

    // 6. Cluster rootDirCluster+: Root directory, subdirectories, and files
    onProgress?.(0.6, 'Streaming exFAT directories and files...');
    await this.streamClusterHeap(writer, geo, allocation, onProgress);

    onProgress?.(1.0, 'exFAT build complete.');
  }

  private allocateClusters(geo: ExFatGeometry) {
    const items: AllocatedClusterItem[] = [];
    const calcDirClusterCount = (dir: VNode, isRoot: boolean): number => {
      let entries = isRoot ? (this.volumeLabel ? 1 : 0) + 2 : 0; // volume label + bitmap + upcase
      for (const child of dir.children || []) {
        const nameChars = child.name.length;
        const nameEntries = Math.ceil(nameChars / 15);
        entries += 2 + nameEntries; // 1 file + 1 stream ext + N name entries
      }
      return Math.max(1, Math.ceil((entries * 32) / geo.clusterSizeBytes));
    };

    const rootClusterCount = calcDirClusterCount(this.root, true);
    const rootItem: AllocatedClusterItem = {
      node: this.root,
      startCluster: geo.rootDirCluster,
      clusterCount: rootClusterCount,
      size: rootClusterCount * geo.clusterSizeBytes,
      isDir: true,
    };
    items.push(rootItem);
    let nextCluster = geo.rootDirCluster + rootClusterCount;

    // Traverse directories and files
    const traverse = (dir: VNode) => {
      for (const child of dir.children || []) {
        if (child.isDirectory) {
          const dirClusters = calcDirClusterCount(child, false);
          const item: AllocatedClusterItem = {
            node: child,
            startCluster: nextCluster,
            clusterCount: dirClusters,
            size: dirClusters * geo.clusterSizeBytes,
            isDir: true,
          };
          items.push(item);
          nextCluster += dirClusters;
          traverse(child);
        } else {
          const size = child.fileRef?.size ?? child.data?.byteLength ?? child.sourceLength ?? child.size ?? 0;
          if (size === 0) {
            // Per exFAT spec: zero-byte files have no clusters allocated
            const item: AllocatedClusterItem = {
              node: child,
              startCluster: 0,
              clusterCount: 0,
              size: 0,
              isDir: false,
            };
            items.push(item);
          } else {
            const clusterCount = Math.max(1, Math.ceil(size / geo.clusterSizeBytes));
            const item: AllocatedClusterItem = {
              node: child,
              startCluster: nextCluster,
              clusterCount,
              size,
              isDir: false,
            };
            items.push(item);
            nextCluster += clusterCount;
          }
        }
      }
    };
    traverse(this.root);

    return { items, totalAllocatedClusters: nextCluster };
  }

  private generateBootRegion(geo: ExFatGeometry): Uint8Array {
    const mainBoot = new Uint8Array(12 * geo.bytesPerSector);

    // Sector 0: Boot Sector
    const bpb = mainBoot.subarray(0, 512);
    bpb[0] = 0xeb;
    bpb[1] = 0x76;
    bpb[2] = 0x90; // JMP SHORT 0x76, NOP
    for (let i = 0; i < 8; i++) bpb[3 + i] = EXFAT_OEM_NAME.charCodeAt(i);

    // PartitionOffset: sector offset from media origin (e.g. 2048 if partitioned)
    this.writeUint64LE(bpb, 64, this.partitionOffset);
    // VolumeLength (total sectors)
    this.writeUint64LE(bpb, 72, geo.totalSectors);
    // FatOffset
    this.writeUint32LE(bpb, 80, geo.fatOffset);
    // FatLength
    this.writeUint32LE(bpb, 84, geo.fatLength);
    // ClusterHeapOffset
    this.writeUint32LE(bpb, 88, geo.clusterHeapOffset);
    // ClusterCount
    this.writeUint32LE(bpb, 92, geo.clusterCount);
    // FirstClusterOfRootDir
    this.writeUint32LE(bpb, 96, geo.rootDirCluster);
    // VolumeSerialNumber
    this.writeUint32LE(bpb, 100, 0x5a17e001);
    // FileSystemRevision: 1.00 (0x0100)
    bpb[104] = 0x00;
    bpb[105] = 0x01;
    // VolumeFlags: 0
    bpb[106] = 0x00;
    bpb[107] = 0x00;
    // BytesPerSectorShift
    bpb[108] = geo.bytesPerSectorShift;
    // SectorsPerClusterShift
    bpb[109] = geo.sectorsPerClusterShift;
    // NumberOfFats
    bpb[110] = 1;
    // DriveSelect: 0x80
    bpb[111] = 0x80;
    // PercentInUse: 0
    bpb[112] = 0;
    // Boot signature
    bpb[510] = 0x55;
    bpb[511] = 0xaa;

    // Sectors 1-8: Extended Boot Sectors (zeros with 0x55AA signature at end)
    for (let s = 1; s <= 8; s++) {
      mainBoot[s * 512 + 510] = 0x55;
      mainBoot[s * 512 + 511] = 0xaa;
    }

    // Sector 9: OEM Parameter Sector
    mainBoot[9 * 512 + 510] = 0x55;
    mainBoot[9 * 512 + 511] = 0xaa;

    // Sector 10: Reserved Sector
    mainBoot[10 * 512 + 510] = 0x55;
    mainBoot[10 * 512 + 511] = 0xaa;

    // Sector 11: Boot Checksum Sector
    // Compute 32-bit checksum of sectors 0 through 10
    const checksum = this.computeBootChecksum(mainBoot.subarray(0, 11 * 512));
    for (let i = 0; i < 512; i += 4) {
      this.writeUint32LE(mainBoot, 11 * 512 + i, checksum);
    }

    // Backup Boot Region (Sectors 12 to 23: exact mirror of Sectors 0 to 11)
    const fullBootRegion = new Uint8Array(24 * geo.bytesPerSector);
    fullBootRegion.set(mainBoot, 0);
    fullBootRegion.set(mainBoot, 12 * geo.bytesPerSector);

    return fullBootRegion;
  }

  private computeBootChecksum(bytes: Uint8Array): number {
    let checksum = 0;
    for (let i = 0; i < bytes.length; i++) {
      // Skip VolumeFlags (bytes 106, 107) and PercentInUse (byte 112) of Sector 0
      if (i === 106 || i === 107 || i === 112) continue;
      checksum = (((checksum << 31) | (checksum >>> 1)) + bytes[i]) >>> 0;
    }
    return checksum;
  }

  private generateFatTable(
    geo: ExFatGeometry,
    allocation: ReturnType<typeof this.allocateClusters>
  ): Uint8Array {
    const fat = new Uint8Array(geo.fatLength * geo.bytesPerSector);
    // Entry 0: Media type (0xFFFFFFF8)
    this.writeUint32LE(fat, 0, 0xfffffff8);
    // Entry 1: Reserved (0xFFFFFFFF)
    this.writeUint32LE(fat, 4, 0xffffffff);

    // Bitmap cluster chain:
    for (let c = 0; c < geo.bitmapClusterCount; c++) {
      const clusterNum = geo.bitmapStartCluster + c;
      const next = c === geo.bitmapClusterCount - 1 ? 0xffffffff : clusterNum + 1;
      this.writeUint32LE(fat, clusterNum * 4, next);
    }

    // Upcase table cluster chain:
    for (let c = 0; c < geo.upcaseClusterCount; c++) {
      const clusterNum = geo.upcaseStartCluster + c;
      const next = c === geo.upcaseClusterCount - 1 ? 0xffffffff : clusterNum + 1;
      this.writeUint32LE(fat, clusterNum * 4, next);
    }

    // Allocate clusters for items
    for (const item of allocation.items) {
      if (item.clusterCount === 0 || item.startCluster === 0) continue;
      for (let c = 0; c < item.clusterCount; c++) {
        const clusterNum = item.startCluster + c;
        const next = c === item.clusterCount - 1 ? 0xffffffff : clusterNum + 1;
        this.writeUint32LE(fat, clusterNum * 4, next);
      }
    }

    return fat;
  }

  private generateAllocationBitmap(
    geo: ExFatGeometry,
    allocation: ReturnType<typeof this.allocateClusters>
  ): Uint8Array {
    const bitmap = new Uint8Array(geo.bitmapClusterCount * geo.clusterSizeBytes);

    // Bitmap clusters
    for (let c = 0; c < geo.bitmapClusterCount; c++) {
      this.setBitmapBit(bitmap, geo.bitmapStartCluster + c - 2);
    }

    // Upcase Table clusters
    for (let c = 0; c < geo.upcaseClusterCount; c++) {
      this.setBitmapBit(bitmap, geo.upcaseStartCluster + c - 2);
    }

    // Allocated items
    for (const item of allocation.items) {
      if (item.clusterCount === 0 || item.startCluster === 0) continue;
      for (let c = 0; c < item.clusterCount; c++) {
        const clusterIndex = item.startCluster + c - 2;
        this.setBitmapBit(bitmap, clusterIndex);
      }
    }

    return bitmap;
  }

  private setBitmapBit(bitmap: Uint8Array, clusterIndex: number) {
    const byteIndex = Math.floor(clusterIndex / 8);
    const bitIndex = clusterIndex % 8;
    if (byteIndex < bitmap.byteLength) {
      bitmap[byteIndex] |= 1 << bitIndex;
    }
  }

  private generateUpcaseTable(geo: ExFatGeometry): Uint8Array {
    const table = new Uint8Array(geo.upcaseClusterCount * geo.clusterSizeBytes);
    table.set(UPCASE_TABLE_BYTES, 0);
    return table;
  }

  private async streamClusterHeap(
    writer: ImageStreamWriter,
    geo: ExFatGeometry,
    allocation: ReturnType<typeof this.allocateClusters>,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    let currentCluster = geo.rootDirCluster;

    for (let i = 0; i < allocation.items.length; i++) {
      const item = allocation.items[i];
      if (item.clusterCount === 0) continue;

      const progress = 0.6 + (i / allocation.items.length) * 0.38;
      onProgress?.(progress, `Writing ${item.isDir ? 'directory' : 'file'}: ${item.node.name}`);

      if (item.isDir) {
        const dirBytes = this.generateDirectoryEntries(item.node, geo, allocation);
        await writer.write(dirBytes);
        currentCluster += item.clusterCount;
      } else {
        await this.streamFileData(item.node, writer);
        // Pad to cluster boundary
        const padBytes = (geo.clusterSizeBytes - (item.size % geo.clusterSizeBytes)) % geo.clusterSizeBytes;
        if (padBytes > 0) {
          await writer.write(new Uint8Array(padBytes));
        }
        currentCluster += item.clusterCount;
      }
    }

    if (this.padToCapacity) {
      const totalDataBytes = geo.clusterCount * geo.clusterSizeBytes;
      const bytesWrittenInData = (currentCluster - 2) * geo.clusterSizeBytes;
      const leftoverBytes = Math.max(
        0,
        (this.totalSectors - (geo.clusterHeapOffset + geo.clusterCount * geo.sectorsPerCluster)) *
          geo.bytesPerSector
      );
      let remainingBytes = Math.max(0, totalDataBytes - bytesWrittenInData) + leftoverBytes;
      if (remainingBytes > 0) {
        const totalPadBytes = remainingBytes;
        let padWritten = 0;
        let lastReportTime = 0;
        while (remainingBytes > 0) {
          const toWrite = Math.min(ZERO_BUFFER.byteLength, remainingBytes);
          await writer.write(toWrite === ZERO_BUFFER.byteLength ? ZERO_BUFFER : ZERO_BUFFER.subarray(0, toWrite));
          remainingBytes -= toWrite;
          padWritten += toWrite;

          const now = performance.now();
          if (now - lastReportTime >= 100 || remainingBytes === 0) {
            lastReportTime = now;
            const padRatio = padWritten / totalPadBytes;
            const ratio = 0.6 + padRatio * 0.39;
            const writtenMb = Math.round(padWritten / (1024 * 1024));
            const totalMb = Math.round(totalPadBytes / (1024 * 1024));
            onProgress?.(ratio, `Writing disk image: ${writtenMb} MB / ${totalMb} MB...`);
          }
        }
      }
    }
  }

  private generateDirectoryEntries(
    dirNode: VNode,
    geo: ExFatGeometry,
    allocation: ReturnType<typeof this.allocateClusters>
  ): Uint8Array {
    const item = allocation.items.find((it) => it.node === dirNode);
    const clusterCount = item?.clusterCount || 1;
    const dirBytes = new Uint8Array(clusterCount * geo.clusterSizeBytes);
    let offset = 0;

    if (dirNode === this.root) {
      // 1. Volume Label Entry (0x83)
      if (this.volumeLabel) {
        dirBytes[offset] = ExFatEntryType.VolumeLabel;
        dirBytes[offset + 1] = this.volumeLabel.length; // Character count
        for (let i = 0; i < this.volumeLabel.length; i++) {
          this.writeUint16LE(dirBytes, offset + 2 + i * 2, this.volumeLabel.charCodeAt(i));
        }
        offset += 32;
      }

      // 2. Allocation Bitmap Entry (0x81)
      dirBytes[offset] = ExFatEntryType.AllocationBitmap;
      dirBytes[offset + 1] = 0; // BitmapFlags: 0 = First FAT
      this.writeUint32LE(dirBytes, offset + 20, geo.bitmapStartCluster); // FirstCluster
      this.writeUint64LE(dirBytes, offset + 24, geo.bitmapSizeBytes); // DataLength
      offset += 32;

      // 3. Upcase Table Entry (0x82)
      dirBytes[offset] = ExFatEntryType.UpcaseTable;
      dirBytes[offset + 1] = 0;
      this.writeUint32LE(dirBytes, offset + 4, UPCASE_TABLE_CHECKSUM); // TableChecksum
      this.writeUint32LE(dirBytes, offset + 20, geo.upcaseStartCluster); // FirstCluster
      this.writeUint64LE(dirBytes, offset + 24, geo.upcaseSizeBytes); // DataLength
      offset += 32;
    }

    // Children entries
    for (const child of dirNode.children || []) {
      const item = allocation.items.find((it) => it.node === child);
      if (!item) continue;

      const name = child.name;
      const nameChars = name.length;
      const nameEntries = Math.ceil(nameChars / 15);
      const secondaryCount = 1 + nameEntries; // 1 stream extension + N name entries

      // 1. File Directory Entry (0x85)
      const fileEntryOffset = offset;
      dirBytes[fileEntryOffset] = ExFatEntryType.File;
      dirBytes[fileEntryOffset + 1] = secondaryCount;
      const attr = child.isDirectory ? ExFatFileAttributes.Directory : ExFatFileAttributes.Archive;
      this.writeUint16LE(dirBytes, fileEntryOffset + 4, attr);

      // File Timestamps (Create, Last Modified, Last Access)
      const mtime = child.modifiedTime || new Date();
      this.writeDosDateTime(dirBytes, fileEntryOffset + 8, mtime);
      this.writeDosDateTime(dirBytes, fileEntryOffset + 12, mtime);
      this.writeDosDateTime(dirBytes, fileEntryOffset + 16, mtime);
      offset += 32;

      // 2. Stream Extension Entry (0xC0)
      const streamOffset = offset;
      dirBytes[streamOffset] = ExFatEntryType.StreamExtension;
      if (item.size === 0 && !child.isDirectory) {
        // Zero-byte file per exFAT spec: AllocationPossible = 0, NoFatChain = 0, FirstCluster = 0
        dirBytes[streamOffset + 1] = 0x00;
        dirBytes[streamOffset + 3] = nameChars;
        this.writeUint16LE(dirBytes, streamOffset + 4, this.computeNameHash(name));
        this.writeUint64LE(dirBytes, streamOffset + 8, 0);
        this.writeUint32LE(dirBytes, streamOffset + 20, 0);
        this.writeUint64LE(dirBytes, streamOffset + 24, 0);
      } else {
        dirBytes[streamOffset + 1] = 0x01 | 0x02; // AllocationPossible | NoFatChain (contiguous)
        dirBytes[streamOffset + 3] = nameChars;
        this.writeUint16LE(dirBytes, streamOffset + 4, this.computeNameHash(name));
        this.writeUint64LE(dirBytes, streamOffset + 8, item.size); // ValidDataLength
        this.writeUint32LE(dirBytes, streamOffset + 20, item.startCluster);
        this.writeUint64LE(dirBytes, streamOffset + 24, item.size); // DataLength
      }
      offset += 32;

      // 3. File Name Entries (0xC1)
      for (let e = 0; e < nameEntries; e++) {
        const nameEntryOffset = offset;
        dirBytes[nameEntryOffset] = ExFatEntryType.FileName;
        dirBytes[nameEntryOffset + 1] = 0; // GeneralSecondaryFlags
        for (let c = 0; c < 15; c++) {
          const charIdx = e * 15 + c;
          const code = charIdx < nameChars ? name.charCodeAt(charIdx) : 0x0000;
          this.writeUint16LE(dirBytes, nameEntryOffset + 2 + c * 2, code);
        }
        offset += 32;
      }

      // Compute SetChecksum over secondary entries and write into File Directory Entry
      const entryCount = 1 + secondaryCount;
      const setChecksum = this.computeSetChecksum(dirBytes.subarray(fileEntryOffset, fileEntryOffset + entryCount * 32));
      this.writeUint16LE(dirBytes, fileEntryOffset + 2, setChecksum);
    }

    return dirBytes;
  }

  private computeNameHash(name: string): number {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      const ch = name[i];
      const upStr = ch.toUpperCase();
      const code = upStr.length === 1 ? upStr.charCodeAt(0) : name.charCodeAt(i);
      const b0 = code & 0xff;
      const b1 = (code >> 8) & 0xff;
      hash = (((hash & 1 ? 0x8000 : 0) + (hash >>> 1) + b0) & 0xffff);
      hash = (((hash & 1 ? 0x8000 : 0) + (hash >>> 1) + b1) & 0xffff);
    }
    return hash;
  }

  private computeSetChecksum(entries: Uint8Array): number {
    let checksum = 0;
    for (let i = 0; i < entries.length; i++) {
      // Skip SetChecksum field (bytes 2 and 3 of File Directory Entry)
      if (i === 2 || i === 3) continue;
      checksum = (((checksum & 1 ? 0x8000 : 0) + (checksum >>> 1) + entries[i]) & 0xffff);
    }
    return checksum;
  }

  private writeDosDateTime(buf: Uint8Array, offset: number, date: Date): void {
    const time =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f);
    const d =
      (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);

    this.writeUint16LE(buf, offset, time);
    this.writeUint16LE(buf, offset + 2, d);
  }

  private async streamFileData(node: VNode, writer: ImageStreamWriter): Promise<void> {
    const CHUNK_SIZE = 2 * 1024 * 1024;
    if (node.fileRef) {
      const file = node.fileRef;
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const slice = file.slice(offset, end);
        const buffer = await slice.arrayBuffer();
        await writer.write(new Uint8Array(buffer));
        offset = end;
      }
      return;
    }

    if (node.data && node.data.byteLength > 0) {
      await writer.write(node.data);
      return;
    }
  }

  private writeUint16LE(buf: Uint8Array, offset: number, val: number) {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
  }

  private writeUint32LE(buf: Uint8Array, offset: number, val: number) {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
    buf[offset + 2] = (val >> 16) & 0xff;
    buf[offset + 3] = (val >> 24) & 0xff;
  }

  private writeUint64LE(buf: Uint8Array, offset: number, val: number) {
    const low = val >>> 0;
    const high = Math.floor(val / 0x100000000);
    this.writeUint32LE(buf, offset, low);
    this.writeUint32LE(buf, offset + 4, high);
  }
}
