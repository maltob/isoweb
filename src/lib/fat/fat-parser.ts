// High-performance FAT12 / FAT16 / FAT32 & MBR parser
import { RandomAccessReader } from '../reader';
import { DiskFormat, DiskImageInfo, VNode } from '../types';
import {
  BOOT_SIGNATURE,
  BpbInfo,
  FAT_SECTOR_SIZE,
  FatFileAttributes,
  FatType,
  MbrPartitionEntry,
} from './fat-types';

export class FatParser {
  private reader: RandomAccessReader;
  private bpb!: BpbInfo;
  private fatCache: Map<number, number> = new Map();
  private hasMbr: boolean = false;
  private partitionTypeStr: string = '';

  constructor(reader: RandomAccessReader) {
    this.reader = reader;
  }

  async parse(): Promise<{ root: VNode; info: DiskImageInfo }> {
    // 1. Detect MBR vs direct volume boot record
    const sector0 = await this.reader.read(0, FAT_SECTOR_SIZE);
    if (sector0.length < FAT_SECTOR_SIZE) {
      throw new Error('Image too small to be a valid disk image.');
    }

    const bootSig = sector0[510] | (sector0[511] << 8);
    if (bootSig !== BOOT_SIGNATURE) {
      throw new Error('Missing boot sector signature (0x55AA).');
    }

    let partitionOffset = 0;
    const partition = this.detectMbrPartition(sector0);
    if (partition && partition.firstLbaSector > 0) {
      const candidateOffset = partition.firstLbaSector * FAT_SECTOR_SIZE;
      if (candidateOffset + FAT_SECTOR_SIZE <= this.reader.size) {
        const partSector0 = await this.reader.read(candidateOffset, FAT_SECTOR_SIZE);
        const partSig = partSector0[510] | (partSector0[511] << 8);
        if (partSig === BOOT_SIGNATURE && this.isValidBpb(partSector0)) {
          partitionOffset = candidateOffset;
          this.hasMbr = true;
          this.partitionTypeStr = `MBR Type 0x${partition.type.toString(16).padStart(2, '0').toUpperCase()}`;
        }
      }
    }

    const vbrSector = partitionOffset === 0 ? sector0 : await this.reader.read(partitionOffset, FAT_SECTOR_SIZE);
    this.bpb = this.parseBpb(vbrSector, partitionOffset);

    // 2. Parse Root Directory
    const rootNode: VNode = {
      id: 'fat-root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      children: [],
    };

    if (this.bpb.fatType === FatType.FAT32) {
      // FAT32 root dir is located in cluster chain, starting at rootCluster (usually cluster 2)
      const rootCluster = this.readUint32LE(vbrSector, 44);
      await this.parseClusterDirectory(rootCluster, rootNode, '/');
    } else {
      // FAT12 / FAT16 root dir is located in a dedicated root directory sector table
      await this.parseFixedRootDirectory(rootNode);
    }

    rootNode.size = this.calculateTreeSize(rootNode);

    const formatKey: DiskFormat =
      this.bpb.fatType === FatType.FAT12
        ? 'fat12'
        : this.bpb.fatType === FatType.FAT16
        ? 'fat16'
        : 'fat32';

    const info: DiskImageInfo = {
      format: formatKey,
      formatName: this.bpb.fatType.toUpperCase(),
      volumeLabel: this.bpb.volumeLabel || 'NO NAME',
      totalSize: this.reader.size,
      sectorSize: this.bpb.bytesPerSector,
      totalSectors: this.bpb.totalSectors,
      clusterSize: this.bpb.sectorsPerCluster * this.bpb.bytesPerSector,
      hasMbr: this.hasMbr,
      partitionType: this.partitionTypeStr || undefined,
      isBootable: sector0[0] !== 0x00,
      bootSystem: this.hasMbr ? 'MBR / BIOS' : 'BIOS Boot Sector',
    };

    return { root: rootNode, info };
  }

  /**
   * Reads raw file bytes by traversing cluster chains
   */
  async readFileData(node: VNode): Promise<Uint8Array> {
    if (node.data) return node.data;
    if (node.startCluster === undefined || node.size <= 0) {
      return new Uint8Array(0);
    }

    const clusterSize = this.bpb.sectorsPerCluster * this.bpb.bytesPerSector;
    const result = new Uint8Array(node.size);
    let bytesRead = 0;
    let currentCluster = node.startCluster;

    while (
      bytesRead < node.size &&
      currentCluster >= 2 &&
      !this.isEndOfClusterChain(currentCluster)
    ) {
      const clusterOffset = this.getClusterOffset(currentCluster);
      const toRead = Math.min(clusterSize, node.size - bytesRead);
      const clusterData = await this.reader.read(clusterOffset, toRead);
      result.set(clusterData, bytesRead);
      bytesRead += toRead;

      currentCluster = await this.getNextCluster(currentCluster);
    }

    return result;
  }

  private detectMbrPartition(sector0: Uint8Array): MbrPartitionEntry | null {
    // Check partition entries at 0x1BE, 0x1CE, 0x1DE, 0x1EE
    for (let i = 0; i < 4; i++) {
      const offset = 446 + i * 16;
      const status = sector0[offset];
      const type = sector0[offset + 4];
      const firstLba = this.readUint32LE(sector0, offset + 8);
      const sectorCount = this.readUint32LE(sector0, offset + 12);

      // Known FAT partition types: 0x01 (FAT12), 0x04/0x06/0x0E (FAT16), 0x0B/0x0C (FAT32)
      if (
        (type === 0x01 || type === 0x04 || type === 0x06 || type === 0x0b || type === 0x0c || type === 0x0e) &&
        firstLba > 0 &&
        sectorCount > 0
      ) {
        return { status, type, firstLbaSector: firstLba, sectorCount };
      }
    }
    return null;
  }

  private isValidBpb(sector: Uint8Array): boolean {
    const bytesPerSector = this.readUint16LE(sector, 11);
    const sectorsPerCluster = sector[13];
    const reservedSectors = this.readUint16LE(sector, 14);
    const fatCount = sector[16];

    return (
      bytesPerSector === 512 &&
      sectorsPerCluster > 0 &&
      (sectorsPerCluster & (sectorsPerCluster - 1)) === 0 &&
      reservedSectors > 0 &&
      fatCount > 0
    );
  }

  private parseBpb(sector: Uint8Array, partitionOffset: number): BpbInfo {
    const bytesPerSector = this.readUint16LE(sector, 11) || 512;
    const sectorsPerCluster = sector[13] || 1;
    const reservedSectorCount = this.readUint16LE(sector, 14);
    const fatCount = sector[16] || 2;
    const rootEntryCount = this.readUint16LE(sector, 17);
    let totalSectors = this.readUint16LE(sector, 19);
    if (totalSectors === 0) {
      totalSectors = this.readUint32LE(sector, 32);
    }
    if (totalSectors === 0) {
      totalSectors = Math.floor(this.reader.size / bytesPerSector);
    }

    const mediaType = sector[21];
    let sectorsPerFat = this.readUint16LE(sector, 22);
    let isFat32 = false;
    if (sectorsPerFat === 0) {
      sectorsPerFat = this.readUint32LE(sector, 36);
      isFat32 = true;
    }

    const sectorsPerTrack = this.readUint16LE(sector, 24);
    const headCount = this.readUint16LE(sector, 26);
    const hiddenSectors = this.readUint32LE(sector, 28);

    const rootDirSectors = Math.ceil((rootEntryCount * 32) / bytesPerSector);
    const firstDataSector = reservedSectorCount + fatCount * sectorsPerFat + rootDirSectors;
    const dataSectors = totalSectors - firstDataSector;
    const totalClusters = Math.floor(dataSectors / sectorsPerCluster);

    let fatType: FatType;
    if (isFat32 || totalClusters >= 65525) {
      fatType = FatType.FAT32;
    } else if (totalClusters >= 4085) {
      fatType = FatType.FAT16;
    } else {
      fatType = FatType.FAT12;
    }

    let volumeLabel = '';
    if (fatType === FatType.FAT32) {
      volumeLabel = this.readAscii(sector, 71, 11).trim();
    } else {
      volumeLabel = this.readAscii(sector, 43, 11).trim();
    }

    return {
      bytesPerSector,
      sectorsPerCluster,
      reservedSectorCount,
      fatCount,
      rootEntryCount,
      totalSectors,
      mediaType,
      sectorsPerFat,
      sectorsPerTrack,
      headCount,
      hiddenSectors,
      fatType,
      rootDirSectors,
      firstDataSector,
      dataSectors,
      totalClusters,
      volumeLabel: volumeLabel || (fatType === FatType.FAT12 ? 'FLOPPY' : 'DOS_DISK'),
      partitionOffsetBytes: partitionOffset,
    };
  }

  private async parseFixedRootDirectory(rootNode: VNode): Promise<void> {
    const rootOffset =
      this.bpb.partitionOffsetBytes +
      (this.bpb.reservedSectorCount + this.bpb.fatCount * this.bpb.sectorsPerFat) *
        this.bpb.bytesPerSector;
    const rootLength = this.bpb.rootEntryCount * 32;

    const data = await this.reader.read(rootOffset, rootLength);
    await this.parseDirectoryEntries(data, rootNode, '/');
  }

  private async parseClusterDirectory(cluster: number, parentNode: VNode, currentPath: string): Promise<void> {
    const clusterSize = this.bpb.sectorsPerCluster * this.bpb.bytesPerSector;
    const chunks: Uint8Array[] = [];
    let current = cluster;
    const visited = new Set<number>();

    while (current >= 2 && !this.isEndOfClusterChain(current) && !visited.has(current)) {
      visited.add(current);
      const offset = this.getClusterOffset(current);
      const data = await this.reader.read(offset, clusterSize);
      chunks.push(data);
      current = await this.getNextCluster(current);
    }

    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      combined.set(c, off);
      off += c.length;
    }

    await this.parseDirectoryEntries(combined, parentNode, currentPath);
  }

  private async parseDirectoryEntries(
    buffer: Uint8Array,
    parentNode: VNode,
    currentPath: string
  ): Promise<void> {
    let lfnParts: { seq: number; chars: string }[] = [];

    for (let offset = 0; offset + 32 <= buffer.length; offset += 32) {
      const entry = buffer.subarray(offset, offset + 32);
      const firstByte = entry[0];

      // 0x00 = end of directory
      if (firstByte === 0x00) {
        break;
      }
      // 0xE5 = deleted entry
      if (firstByte === 0xe5) {
        lfnParts = [];
        continue;
      }

      const attr = entry[11];

      // Long File Name (LFN) entry
      if (attr === FatFileAttributes.Lfn) {
        const seq = firstByte & 0x1f;
        const chars = this.extractLfnChars(entry);
        lfnParts.push({ seq, chars });
        continue;
      }

      // Volume ID entry
      if ((attr & FatFileAttributes.VolumeId) !== 0) {
        const volLabel = this.readAscii(entry, 0, 11).trim();
        if (volLabel) {
          this.bpb.volumeLabel = volLabel;
        }
        lfnParts = [];
        continue;
      }

      // Standard Directory / File Entry
      let filename = '';
      if (lfnParts.length > 0) {
        // Sort LFN parts by sequence number descending
        lfnParts.sort((a, b) => a.seq - b.seq);
        filename = lfnParts.map((p) => p.chars).join('');
        lfnParts = [];
      } else {
        filename = this.format83Name(entry);
      }

      // Skip '.' and '..'
      if (filename === '.' || filename === '..') {
        continue;
      }

      const isDir = (attr & FatFileAttributes.Directory) !== 0;
      const fstClusHI = this.bpb.fatType === FatType.FAT32 ? this.readUint16LE(entry, 20) : 0;
      const fstClusLO = this.readUint16LE(entry, 26);
      const startCluster = (fstClusHI << 16) | fstClusLO;
      const fileSize = isDir ? 0 : this.readUint32LE(entry, 28);
      const modifiedTime = this.parseFatDateTime(
        this.readUint16LE(entry, 24),
        this.readUint16LE(entry, 22)
      );

      const nodePath = currentPath === '/' ? `/${filename}` : `${currentPath}/${filename}`;
      const shortName = this.format83Name(entry);

      const node: VNode = {
        id: `fat-${startCluster}-${fileSize}-${filename}`,
        name: filename,
        path: nodePath,
        isDirectory: isDir,
        size: fileSize,
        modifiedTime,
        startCluster,
        shortName,
        flags: attr,
        children: isDir ? [] : undefined,
      };

      parentNode.children!.push(node);

      // Recursively parse subdirectory
      if (isDir && startCluster >= 2) {
        await this.parseClusterDirectory(startCluster, node, nodePath);
      }
    }
  }

  private extractLfnChars(entry: Uint8Array): string {
    let result = '';
    const readChar = (off: number) => {
      const code = entry[off] | (entry[off + 1] << 8);
      if (code === 0x0000 || code === 0xffff) return '';
      return String.fromCharCode(code);
    };

    // 5 chars at offset 1
    for (let i = 0; i < 5; i++) result += readChar(1 + i * 2);
    // 6 chars at offset 14
    for (let i = 0; i < 6; i++) result += readChar(14 + i * 2);
    // 2 chars at offset 28
    for (let i = 0; i < 2; i++) result += readChar(28 + i * 2);

    return result;
  }

  private format83Name(entry: Uint8Array): string {
    const rawName = this.readAscii(entry, 0, 8).trimEnd();
    const rawExt = this.readAscii(entry, 8, 3).trimEnd();
    return rawExt ? `${rawName}.${rawExt}` : rawName;
  }

  private getClusterOffset(cluster: number): number {
    const firstDataSector = this.bpb.firstDataSector;
    const sector = firstDataSector + (cluster - 2) * this.bpb.sectorsPerCluster;
    return this.bpb.partitionOffsetBytes + sector * this.bpb.bytesPerSector;
  }

  private async getNextCluster(cluster: number): Promise<number> {
    if (this.fatCache.has(cluster)) {
      return this.fatCache.get(cluster)!;
    }

    const fatOffset =
      this.bpb.partitionOffsetBytes + this.bpb.reservedSectorCount * this.bpb.bytesPerSector;

    if (this.bpb.fatType === FatType.FAT12) {
      const fatEntryOffset = Math.floor((cluster * 3) / 2);
      const bytes = await this.reader.read(fatOffset + fatEntryOffset, 2);
      const val = bytes[0] | (bytes[1] << 8);
      const next = cluster % 2 === 0 ? val & 0x0fff : (val >> 4) & 0x0fff;
      this.fatCache.set(cluster, next);
      return next;
    } else if (this.bpb.fatType === FatType.FAT16) {
      const bytes = await this.reader.read(fatOffset + cluster * 2, 2);
      const next = bytes[0] | (bytes[1] << 8);
      this.fatCache.set(cluster, next);
      return next;
    } else {
      // FAT32
      const bytes = await this.reader.read(fatOffset + cluster * 4, 4);
      const next = this.readUint32LE(bytes, 0) & 0x0fffffff;
      this.fatCache.set(cluster, next);
      return next;
    }
  }

  private isEndOfClusterChain(cluster: number): boolean {
    if (this.bpb.fatType === FatType.FAT12) {
      return cluster >= 0x0ff8;
    } else if (this.bpb.fatType === FatType.FAT16) {
      return cluster >= 0xfff8;
    } else {
      return cluster >= 0x0ffffff8;
    }
  }

  private parseFatDateTime(dateWord: number, timeWord: number): Date {
    const year = 1980 + ((dateWord >> 9) & 0x7f);
    const month = Math.max(0, ((dateWord >> 5) & 0x0f) - 1);
    const day = Math.max(1, dateWord & 0x1f);

    const hours = (timeWord >> 11) & 0x1f;
    const minutes = (timeWord >> 5) & 0x3f;
    const seconds = (timeWord & 0x1f) * 2;

    return new Date(year, month, day, hours, minutes, seconds);
  }

  private readUint16LE(buf: Uint8Array, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8);
  }

  private readUint32LE(buf: Uint8Array, offset: number): number {
    return (
      (buf[offset] |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 24)) >>>
      0
    );
  }

  private readAscii(buf: Uint8Array, offset: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(buf[offset + i]);
    }
    return s;
  }

  private calculateTreeSize(node: VNode): number {
    if (!node.isDirectory) return node.size;
    let sum = 0;
    if (node.children) {
      for (const child of node.children) {
        sum += this.calculateTreeSize(child);
      }
    }
    return sum;
  }
}
