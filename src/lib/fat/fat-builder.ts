// High-performance FAT12 / FAT16 / FAT32 disk image builder
import { BlobAccumulatorWriter, ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import { FatParser } from './fat-parser';
import {
  FAT_SECTOR_SIZE,
  FatFileAttributes,
  FatType,
} from './fat-types';

export interface FatBuilderOptions {
  fatType: FatType;
  volumeLabel?: string;
  totalSectors?: number; // default 2880 for FAT12 (1.44M)
  sectorsPerCluster?: number;
}

interface AllocatedItem {
  node: VNode;
  startCluster: number;
  clusterCount: number;
  size: number;
}

export class FatBuilder {
  private root: VNode;
  private options: FatBuilderOptions;
  private sourceParser?: FatParser;

  constructor(
    root: VNode,
    options: FatBuilderOptions,
    sourceParser?: FatParser
  ) {
    this.root = root;
    this.options = {
      volumeLabel: (options.volumeLabel || 'FLOPPY').toUpperCase().slice(0, 11),
      ...options,
    };
    this.sourceParser = sourceParser;
  }

  /**
   * Builds the FAT disk image directly into a streaming writer (OPFS, Disk, or Memory)
   * Streams sequentially so multi-gigabyte disk images use almost zero RAM!
   */
  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    onProgress?.(0.05, 'Configuring FAT filesystem geometry...');
    const geo = this.computeGeometry();

    // 1. Write Boot Sector (BPB) & reserved sectors
    onProgress?.(0.1, 'Writing boot sector and BPB...');
    const reservedBytes = new Uint8Array(geo.reservedSectors * geo.bytesPerSector);
    this.writeBootSector(reservedBytes, geo);
    await writer.write(reservedBytes);

    // 2. Allocate clusters for all files and directories
    onProgress?.(0.2, 'Allocating cluster map...');
    const allocation = await this.allocateClusters(geo);

    // 3. Generate FAT tables (FAT1 and mirror FAT2)
    onProgress?.(0.3, 'Writing File Allocation Table 1...');
    const fatBytes = this.generateFatBytes(geo, allocation.fatTable);
    await writer.write(fatBytes);

    onProgress?.(0.4, 'Writing File Allocation Table 2 (mirror)...');
    await writer.write(fatBytes);

    // 4. Fixed Root Directory (FAT12 / FAT16)
    if (geo.fatType !== FatType.FAT32) {
      onProgress?.(0.45, 'Writing root directory table...');
      const rootBytes = this.generateFixedRootDirBytes(geo, allocation);
      await writer.write(rootBytes);
    }

    // 5. Stream cluster data sequentially (Cluster 2 up to totalClusters)
    onProgress?.(0.5, 'Streaming clusters (directories & files)...');
    await this.streamAllClusters(writer, geo, allocation, onProgress);

    onProgress?.(1.0, 'Finalizing disk image stream...');
  }

  /**
   * Generates a standard FAT disk image (.img) as a Blob
   */
  async buildBlob(onProgress?: (ratio: number, status: string) => void): Promise<Blob> {
    const accumulator = new BlobAccumulatorWriter('application/octet-stream');
    await this.buildToStream(accumulator, onProgress);
    return accumulator.getBlob();
  }

  private generateFatBytes(
    geo: ReturnType<typeof this.computeGeometry>,
    fatTable: number[]
  ): Uint8Array {
    const fatBytes = new Uint8Array(geo.sectorsPerFat * geo.bytesPerSector);

    if (geo.fatType === FatType.FAT12) {
      for (let i = 0; i < fatTable.length; i++) {
        const val = fatTable[i] & 0x0fff;
        const offset = Math.floor((i * 3) / 2);
        if (i % 2 === 0) {
          fatBytes[offset] = val & 0xff;
          fatBytes[offset + 1] = (fatBytes[offset + 1] & 0xf0) | ((val >> 8) & 0x0f);
        } else {
          fatBytes[offset] = (fatBytes[offset] & 0x0f) | ((val << 4) & 0xf0);
          fatBytes[offset + 1] = (val >> 4) & 0xff;
        }
      }
    } else if (geo.fatType === FatType.FAT16) {
      for (let i = 0; i < fatTable.length; i++) {
        this.writeUint16LE(fatBytes, i * 2, fatTable[i] & 0xffff);
      }
    } else {
      // FAT32
      for (let i = 0; i < fatTable.length; i++) {
        this.writeUint32LE(fatBytes, i * 4, fatTable[i] & 0x0fffffff);
      }
    }

    return fatBytes;
  }

  private generateFixedRootDirBytes(
    geo: ReturnType<typeof this.computeGeometry>,
    allocation: Awaited<ReturnType<typeof this.allocateClusters>>
  ): Uint8Array {
    const rootBytes = new Uint8Array(geo.rootEntryCount * 32);
    let rootOffset = 0;
    rootOffset += this.writeVolumeLabelEntry(rootBytes.subarray(rootOffset), geo.volumeLabel);

    for (const child of this.root.children || []) {
      const alloc = child.isDirectory
        ? allocation.directories.find((d) => d.node === child)
        : allocation.files.find((f) => f.node === child);
      const startClus = alloc?.startCluster || 0;
      const size = child.isDirectory ? 0 : child.data?.length ?? child.fileRef?.size ?? child.size ?? 0;

      rootOffset += this.writeDirEntryWithLfn(
        rootBytes.subarray(rootOffset),
        child.name,
        child.isDirectory,
        startClus,
        size,
        child.modifiedTime
      );
    }

    return rootBytes;
  }

  private async streamAllClusters(
    writer: ImageStreamWriter,
    geo: ReturnType<typeof this.computeGeometry>,
    allocation: Awaited<ReturnType<typeof this.allocateClusters>>,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    const clusterSizeBytes = geo.sectorsPerCluster * geo.bytesPerSector;

    // Collect all cluster items sorted by startCluster
    const clusterItems: {
      startCluster: number;
      clusterCount: number;
      node: VNode;
      isDir: boolean;
      size: number;
    }[] = [];

    // FAT32 Root Directory is at cluster 2
    if (geo.fatType === FatType.FAT32) {
      clusterItems.push({
        startCluster: 2,
        clusterCount: 1,
        node: this.root,
        isDir: true,
        size: 0,
      });
    }

    // Subdirectories
    for (const dir of allocation.directories) {
      if (dir.node === this.root) continue;
      clusterItems.push({
        startCluster: dir.startCluster,
        clusterCount: 1,
        node: dir.node,
        isDir: true,
        size: 0,
      });
    }

    // Files
    for (const file of allocation.files) {
      if (file.clusterCount > 0) {
        clusterItems.push({
          startCluster: file.startCluster,
          clusterCount: file.clusterCount,
          node: file.node,
          isDir: false,
          size: file.size,
        });
      }
    }

    clusterItems.sort((a, b) => a.startCluster - b.startCluster);

    let currentCluster = 2;
    const totalItems = clusterItems.length;

    for (let i = 0; i < totalItems; i++) {
      const item = clusterItems[i];

      // Fill any gap between clusters with zeros
      while (currentCluster < item.startCluster) {
        await writer.write(new Uint8Array(clusterSizeBytes));
        currentCluster++;
      }

      const prog = 0.5 + (i / Math.max(1, totalItems)) * 0.45;
      onProgress?.(prog, `Writing cluster ${item.startCluster}: ${item.node.name}`);

      if (item.isDir) {
        const dirBytes = this.generateDirClusterBytes(item.node, geo, allocation);
        await writer.write(dirBytes);
        currentCluster += item.clusterCount;
      } else {
        await this.streamNodeFileData(item.node, writer, geo, item.size);
        currentCluster += item.clusterCount;
      }
    }

    // Fill remaining empty clusters and leftover sectors up to total dataSectors with zeros (in 64KB chunks)
    const totalDataBytes = geo.dataSectors * geo.bytesPerSector;
    const bytesWrittenInData = (currentCluster - 2) * clusterSizeBytes;
    let remainingBytes = Math.max(0, totalDataBytes - bytesWrittenInData);
    if (remainingBytes > 0) {
      const zeroChunk = new Uint8Array(Math.min(65536, clusterSizeBytes));
      while (remainingBytes > 0) {
        const toWrite = Math.min(zeroChunk.byteLength, remainingBytes);
        await writer.write(toWrite === zeroChunk.byteLength ? zeroChunk : zeroChunk.subarray(0, toWrite));
        remainingBytes -= toWrite;
      }
    }
  }

  private generateDirClusterBytes(
    dirNode: VNode,
    geo: ReturnType<typeof this.computeGeometry>,
    allocation: Awaited<ReturnType<typeof this.allocateClusters>>
  ): Uint8Array {
    const dirBytes = new Uint8Array(geo.sectorsPerCluster * geo.bytesPerSector);
    let dirOffset = 0;

    if (dirNode === this.root && geo.fatType === FatType.FAT32) {
      // Root dir in FAT32 has volume label
      dirOffset += this.writeVolumeLabelEntry(dirBytes.subarray(dirOffset), geo.volumeLabel);
    } else {
      // Subdirectory starts with '.' and '..'
      const dirAlloc = allocation.directories.find((d) => d.node === dirNode);
      const startClus = dirAlloc?.startCluster || 0;

      // '.'
      dirOffset += this.writeStandardDirEntry(
        dirBytes.subarray(dirOffset),
        '.          ',
        FatFileAttributes.Directory,
        startClus,
        0,
        dirNode.modifiedTime
      );

      // '..' (parent cluster; 0 for root)
      const parentCluster = 0;
      dirOffset += this.writeStandardDirEntry(
        dirBytes.subarray(dirOffset),
        '..         ',
        FatFileAttributes.Directory,
        parentCluster,
        0,
        this.root.modifiedTime
      );
    }

    for (const child of dirNode.children || []) {
      const alloc = child.isDirectory
        ? allocation.directories.find((d) => d.node === child)
        : allocation.files.find((f) => f.node === child);
      const startClus = alloc?.startCluster || 0;
      const size = child.isDirectory ? 0 : child.data?.length ?? child.fileRef?.size ?? child.size ?? 0;

      dirOffset += this.writeDirEntryWithLfn(
        dirBytes.subarray(dirOffset),
        child.name,
        child.isDirectory,
        startClus,
        size,
        child.modifiedTime
      );
    }

    return dirBytes;
  }

  private async streamNodeFileData(
    node: VNode,
    writer: ImageStreamWriter,
    geo: ReturnType<typeof this.computeGeometry>,
    targetSize: number
  ): Promise<void> {
    const clusterSizeBytes = geo.sectorsPerCluster * geo.bytesPerSector;
    const totalClusters = Math.max(1, Math.ceil(targetSize / clusterSizeBytes));
    const totalClusterBytes = totalClusters * clusterSizeBytes;
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks
    let bytesWritten = 0;

    if (node.fileRef) {
      const file = node.fileRef;
      let offset = 0;
      while (offset < file.size && bytesWritten < targetSize) {
        const len = Math.min(CHUNK_SIZE, targetSize - bytesWritten, file.size - offset);
        const slice = file.slice(offset, offset + len);
        const buf = await slice.arrayBuffer();
        await writer.write(new Uint8Array(buf));
        offset += len;
        bytesWritten += len;
      }
    } else if (node.data) {
      const len = Math.min(node.data.byteLength, targetSize);
      await writer.write(node.data.subarray(0, len));
      bytesWritten += len;
    } else if (this.sourceParser && node.startCluster !== undefined) {
      const data = await this.sourceParser.readFileData(node);
      const len = Math.min(data.byteLength, targetSize);
      await writer.write(data.subarray(0, len));
      bytesWritten += len;
    }

    // Pad last cluster with zeros
    const padBytes = totalClusterBytes - bytesWritten;
    if (padBytes > 0) {
      const zeroChunk = new Uint8Array(Math.min(65536, padBytes));
      let remainingPad = padBytes;
      while (remainingPad > 0) {
        const toWrite = Math.min(zeroChunk.byteLength, remainingPad);
        await writer.write(toWrite === zeroChunk.byteLength ? zeroChunk : zeroChunk.subarray(0, toWrite));
        remainingPad -= toWrite;
      }
    }
  }

  private computeGeometry() {
    const bytesPerSector = FAT_SECTOR_SIZE;
    let totalSectors = this.options.totalSectors || 2880; // 1.44M floppy by default
    let fatType = this.options.fatType;
    let sectorsPerCluster = this.options.sectorsPerCluster || 1;
    let reservedSectors = fatType === FatType.FAT32 ? 32 : 1;
    const fatCount = 2;
    let rootEntryCount = fatType === FatType.FAT32 ? 0 : fatType === FatType.FAT16 ? 512 : 224;
    let mediaType = totalSectors === 2880 ? 0xf0 : 0xf8;
    let sectorsPerTrack = totalSectors === 2880 ? 18 : 63;
    let headCount = totalSectors === 2880 ? 2 : 255;

    // Calculate sectors per FAT
    const rootDirSectors = Math.ceil((rootEntryCount * 32) / bytesPerSector);
    let sectorsPerFat = 9; // standard for 1.44M FAT12

    if (fatType === FatType.FAT16) {
      sectorsPerCluster = this.options.sectorsPerCluster || 4;
      const approxDataSectors = totalSectors - reservedSectors - rootDirSectors;
      const approxClusters = Math.floor(approxDataSectors / sectorsPerCluster);
      sectorsPerFat = Math.ceil((approxClusters * 2) / bytesPerSector);
    } else if (fatType === FatType.FAT32) {
      sectorsPerCluster = this.options.sectorsPerCluster || 8;
      const approxDataSectors = totalSectors - reservedSectors;
      const approxClusters = Math.floor(approxDataSectors / sectorsPerCluster);
      sectorsPerFat = Math.ceil((approxClusters * 4) / bytesPerSector);
    }

    const firstDataSector = reservedSectors + fatCount * sectorsPerFat + rootDirSectors;
    const dataSectors = totalSectors - firstDataSector;
    const totalClusters = Math.floor(dataSectors / sectorsPerCluster);

    return {
      bytesPerSector,
      totalSectors,
      fatType,
      sectorsPerCluster,
      reservedSectors,
      fatCount,
      rootEntryCount,
      rootDirSectors,
      mediaType,
      sectorsPerTrack,
      headCount,
      sectorsPerFat,
      firstDataSector,
      dataSectors,
      totalClusters,
      volumeLabel: this.options.volumeLabel || (fatType === FatType.FAT12 ? 'FLOPPY' : 'DOS_DISK'),
    };
  }

  private writeBootSector(disk: Uint8Array, geo: ReturnType<typeof this.computeGeometry>): void {
    // Jump instruction: EB 3C 90
    disk[0] = 0xeb;
    disk[1] = 0x3c;
    disk[2] = 0x90;

    // OEM Name
    this.writeAscii(disk, 3, 'ISOWEB  ', 8);

    // BPB Common
    this.writeUint16LE(disk, 11, geo.bytesPerSector);
    disk[13] = geo.sectorsPerCluster;
    this.writeUint16LE(disk, 14, geo.reservedSectors);
    disk[16] = geo.fatCount;
    this.writeUint16LE(disk, 17, geo.rootEntryCount);

    if (geo.totalSectors < 65536) {
      this.writeUint16LE(disk, 19, geo.totalSectors);
    } else {
      this.writeUint16LE(disk, 19, 0);
    }

    disk[21] = geo.mediaType;

    if (geo.fatType === FatType.FAT32) {
      this.writeUint16LE(disk, 22, 0); // Sectors per FAT 16 is 0 for FAT32
    } else {
      this.writeUint16LE(disk, 22, geo.sectorsPerFat);
    }

    this.writeUint16LE(disk, 24, geo.sectorsPerTrack);
    this.writeUint16LE(disk, 26, geo.headCount);
    this.writeUint32LE(disk, 28, 0); // Hidden sectors

    if (geo.totalSectors >= 65536) {
      this.writeUint32LE(disk, 32, geo.totalSectors);
    } else {
      this.writeUint32LE(disk, 32, 0);
    }

    if (geo.fatType === FatType.FAT32) {
      // Extended FAT32 BPB
      this.writeUint32LE(disk, 36, geo.sectorsPerFat);
      this.writeUint16LE(disk, 40, 0); // Ext flags
      this.writeUint16LE(disk, 42, 0); // FS version
      this.writeUint32LE(disk, 44, 2); // Root cluster = 2
      this.writeUint16LE(disk, 48, 1); // FSInfo sector = 1
      this.writeUint16LE(disk, 50, 6); // Backup boot sector = 6
      disk[64] = 0x80; // Drive number
      disk[66] = 0x29; // Extended boot signature
      this.writeUint32LE(disk, 67, 0x12345678); // Volume serial
      this.writeAscii(disk, 71, geo.volumeLabel, 11);
      this.writeAscii(disk, 82, 'FAT32   ', 8);
    } else {
      // Extended FAT12/16 BPB
      disk[36] = geo.fatType === FatType.FAT12 ? 0x00 : 0x80; // Drive number
      disk[38] = 0x29; // Extended boot signature
      this.writeUint32LE(disk, 39, 0x12345678); // Volume serial
      this.writeAscii(disk, 43, geo.volumeLabel, 11);
      this.writeAscii(disk, 54, geo.fatType === FatType.FAT12 ? 'FAT12   ' : 'FAT16   ', 8);
    }

    // Boot sector signature (0x55AA at 510)
    disk[510] = 0x55;
    disk[511] = 0xaa;
  }

  private async allocateClusters(geo: ReturnType<typeof this.computeGeometry>) {
    const clusterSizeBytes = geo.sectorsPerCluster * geo.bytesPerSector;
    const fatTable: number[] = [
      geo.mediaType | (geo.fatType === FatType.FAT32 ? 0x0ffffff0 : 0x0f00),
      geo.fatType === FatType.FAT32 ? 0x0fffffff : geo.fatType === FatType.FAT16 ? 0xffff : 0x0fff,
    ];

    let nextFreeCluster = 2;
    if (geo.fatType === FatType.FAT32) {
      // Cluster 2 reserved for root directory
      fatTable[2] = 0x0fffffff;
      nextFreeCluster = 3;
    }

    const files: AllocatedItem[] = [];
    const directories: { node: VNode; startCluster: number }[] = [];

    const allocateNode = (node: VNode) => {
      const isRoot = node === this.root;
      if (node.isDirectory) {
        let dirCluster = 0;
        if (!isRoot) {
          dirCluster = nextFreeCluster++;
          fatTable[dirCluster] =
            geo.fatType === FatType.FAT32
              ? 0x0fffffff
              : geo.fatType === FatType.FAT16
              ? 0xffff
              : 0x0fff;
          directories.push({ node, startCluster: dirCluster });
        } else if (geo.fatType === FatType.FAT32) {
          directories.push({ node, startCluster: 2 });
        }

        for (const child of node.children || []) {
          allocateNode(child);
        }
      } else {
        const size = node.data?.length ?? node.size ?? 0;
        const count = size === 0 ? 0 : Math.max(1, Math.ceil(size / clusterSizeBytes));
        let startCluster = 0;

        if (count > 0) {
          startCluster = nextFreeCluster;
          for (let c = 0; c < count; c++) {
            const current = nextFreeCluster++;
            if (c === count - 1) {
              fatTable[current] =
                geo.fatType === FatType.FAT32
                  ? 0x0fffffff
                  : geo.fatType === FatType.FAT16
                  ? 0xffff
                  : 0x0fff; // EOF
            } else {
              fatTable[current] = current + 1;
            }
          }
        }

        files.push({
          node,
          startCluster,
          clusterCount: count,
          size,
        });
      }
    };

    allocateNode(this.root);

    return { fatTable, files, directories };
  }



  private writeDirEntryWithLfn(
    dest: Uint8Array,
    fullName: string,
    isDirectory: boolean,
    startCluster: number,
    size: number,
    date: Date
  ): number {
    const short83 = this.generateShortName(fullName);
    const checksum = this.calculateLfnChecksum(short83);

    // If filename needs LFN (contains lowercase, spaces, or >8.3)
    const needsLfn =
      fullName !== short83.replace(/\s+/g, '') ||
      fullName.includes(' ') ||
      fullName.length > 12;

    let bytesWritten = 0;

    if (needsLfn) {
      const lfnEntries = this.generateLfnEntries(fullName, checksum);
      for (const entry of lfnEntries) {
        dest.set(entry, bytesWritten);
        bytesWritten += 32;
      }
    }

    const attr = isDirectory ? FatFileAttributes.Directory : FatFileAttributes.Archive;
    bytesWritten += this.writeStandardDirEntry(
      dest.subarray(bytesWritten),
      short83,
      attr,
      startCluster,
      size,
      date
    );

    return bytesWritten;
  }

  private writeStandardDirEntry(
    dest: Uint8Array,
    name83: string,
    attributes: number,
    startCluster: number,
    size: number,
    date: Date
  ): number {
    this.writeAscii(dest, 0, name83, 11);
    dest[11] = attributes;
    dest[12] = 0; // NT reserved

    const timeWord = this.dateToFatTime(date);
    const dateWord = this.dateToFatDate(date);

    this.writeUint16LE(dest, 14, timeWord);
    this.writeUint16LE(dest, 16, dateWord);
    this.writeUint16LE(dest, 18, dateWord);

    this.writeUint16LE(dest, 20, (startCluster >> 16) & 0xffff); // High cluster for FAT32
    this.writeUint16LE(dest, 22, timeWord);
    this.writeUint16LE(dest, 24, dateWord);
    this.writeUint16LE(dest, 26, startCluster & 0xffff); // Low cluster
    this.writeUint32LE(dest, 28, size);

    return 32;
  }

  private writeVolumeLabelEntry(dest: Uint8Array, label: string): number {
    const clean = label.toUpperCase().padEnd(11, ' ').slice(0, 11);
    this.writeAscii(dest, 0, clean, 11);
    dest[11] = FatFileAttributes.VolumeId;
    const now = new Date();
    this.writeUint16LE(dest, 22, this.dateToFatTime(now));
    this.writeUint16LE(dest, 24, this.dateToFatDate(now));
    return 32;
  }

  private generateShortName(name: string): string {
    const parts = name.toUpperCase().split('.');
    const base = (parts[0] || 'FILE').replace(/[^A-Z0-9_]/g, '_').slice(0, 8);
    const ext = (parts[1] || '').replace(/[^A-Z0-9_]/g, '_').slice(0, 3);
    return base.padEnd(8, ' ') + ext.padEnd(3, ' ');
  }

  private calculateLfnChecksum(shortName: string): number {
    let sum = 0;
    for (let i = 0; i < 11; i++) {
      sum = (((sum & 1) ? 0x80 : 0) + (sum >> 1) + shortName.charCodeAt(i)) & 0xff;
    }
    return sum;
  }

  private generateLfnEntries(fullName: string, checksum: number): Uint8Array[] {
    const entries: Uint8Array[] = [];
    const totalChars = fullName.length;
    const numEntries = Math.ceil(totalChars / 13);

    for (let seq = 1; seq <= numEntries; seq++) {
      const entry = new Uint8Array(32);
      const isLast = seq === numEntries;
      entry[0] = seq | (isLast ? 0x40 : 0x00);
      entry[11] = FatFileAttributes.Lfn;
      entry[12] = 0; // Type
      entry[13] = checksum;
      entry[26] = 0; // fstClusLO = 0

      const charOffset = (seq - 1) * 13;
      const getChar = (idx: number): number => {
        const p = charOffset + idx;
        if (p < totalChars) return fullName.charCodeAt(p);
        if (p === totalChars) return 0x0000;
        return 0xffff;
      };

      // 5 chars at 1..10
      for (let i = 0; i < 5; i++) {
        const c = getChar(i);
        entry[1 + i * 2] = c & 0xff;
        entry[2 + i * 2] = (c >> 8) & 0xff;
      }
      // 6 chars at 14..25
      for (let i = 0; i < 6; i++) {
        const c = getChar(5 + i);
        entry[14 + i * 2] = c & 0xff;
        entry[15 + i * 2] = (c >> 8) & 0xff;
      }
      // 2 chars at 28..31
      for (let i = 0; i < 2; i++) {
        const c = getChar(11 + i);
        entry[28 + i * 2] = c & 0xff;
        entry[29 + i * 2] = (c >> 8) & 0xff;
      }

      entries.unshift(entry); // LFN entries stored in reverse sequence
    }

    return entries;
  }



  private dateToFatTime(d: Date): number {
    return (
      ((d.getHours() & 0x1f) << 11) |
      ((d.getMinutes() & 0x3f) << 5) |
      ((Math.floor(d.getSeconds() / 2)) & 0x1f)
    );
  }

  private dateToFatDate(d: Date): number {
    return (
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      (((d.getMonth() + 1) & 0x0f) << 5) |
      (d.getDate() & 0x1f)
    );
  }

  private writeUint16LE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
  }

  private writeUint32LE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
    buf[offset + 2] = (val >> 16) & 0xff;
    buf[offset + 3] = (val >> 24) & 0xff;
  }

  private writeAscii(buf: Uint8Array, offset: number, text: string, padToLen?: number): void {
    const len = padToLen || text.length;
    for (let i = 0; i < len; i++) {
      buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0x20;
    }
  }
}
