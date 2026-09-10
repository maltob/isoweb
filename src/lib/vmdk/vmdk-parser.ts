// High-performance VMDK parser for VMware, VirtualBox, and QEMU virtual disks
// Translates sparse grains to virtual sectors and mounts partitioned FAT32 or exFAT filesystems
import { ExFatParser } from '../exfat/exfat-parser';
import { FatParser } from '../fat/fat-parser';
import { RandomAccessReader } from '../reader';
import { DiskImageInfo, VNode } from '../types';
import {
  VMDK_DEFAULT_GRAIN_SIZE,
  VMDK_GTES_PER_GT,
  VMDK_MAGIC,
  VMDK_SECTOR_SIZE,
} from './vmdk-types';

export class VmdkVirtualReader implements RandomAccessReader {
  private baseReader: RandomAccessReader;
  readonly grainSize: number; // in sectors
  private grainSizeBytes: number;
  readonly gtesPerGt: number;
  private grainTableEntries: number[]; // maps virtual grain to physical sector
  readonly size: number; // in bytes

  constructor(
    baseReader: RandomAccessReader,
    capacitySectors: number,
    grainSize: number,
    gtesPerGt: number,
    grainTableEntries: number[]
  ) {
    this.baseReader = baseReader;
    this.size = capacitySectors * VMDK_SECTOR_SIZE;
    this.grainSize = grainSize;
    this.grainSizeBytes = grainSize * VMDK_SECTOR_SIZE;
    this.gtesPerGt = gtesPerGt;
    this.grainTableEntries = grainTableEntries;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset >= this.size) return new Uint8Array(0);

    const actualLength = Math.min(length, this.size - offset);
    const result = new Uint8Array(actualLength);
    let bytesRead = 0;

    while (bytesRead < actualLength) {
      const currentOffset = offset + bytesRead;
      const virtualGrain = Math.floor(currentOffset / this.grainSizeBytes);
      const grainOffset = currentOffset % this.grainSizeBytes;
      const bytesInThisGrain = Math.min(actualLength - bytesRead, this.grainSizeBytes - grainOffset);

      const physicalSector = virtualGrain < this.grainTableEntries.length ? this.grainTableEntries[virtualGrain] : 0;
      if (physicalSector === 0) {
        // Unallocated / sparse grain: fills with zeros
        result.fill(0, bytesRead, bytesRead + bytesInThisGrain);
      } else {
        const physicalByteOffset = physicalSector * VMDK_SECTOR_SIZE + grainOffset;
        const chunk = await this.baseReader.read(physicalByteOffset, bytesInThisGrain);
        result.set(chunk, bytesRead);
      }

      bytesRead += bytesInThisGrain;
    }

    return result;
  }
}

export interface VmdkParseResult {
  root: VNode;
  info: DiskImageInfo;
  virtualReader: VmdkVirtualReader;
  fatParser?: FatParser;
  exfatParser?: ExFatParser;
}

export class VmdkParser {
  private reader: RandomAccessReader;

  constructor(reader: RandomAccessReader) {
    this.reader = reader;
  }

  async parse(): Promise<VmdkParseResult> {
    const headerBytes = await this.reader.read(0, 512);
    const magic = this.readUint32LE(headerBytes, 0);

    if (magic !== VMDK_MAGIC) {
      throw new Error(`Not a valid VMDK monolithicSparse image (magic: 0x${magic.toString(16)})`);
    }

    const capacitySectors = this.readUint32LE(headerBytes, 12);
    const grainSize = this.readUint32LE(headerBytes, 20) || VMDK_DEFAULT_GRAIN_SIZE;
    const gtesPerGt = this.readUint32LE(headerBytes, 44) || VMDK_GTES_PER_GT;
    const gdOffset = this.readUint32LE(headerBytes, 56);

    const sectorsPerGtCoverage = gtesPerGt * grainSize;
    const numGrainTables = Math.ceil(capacitySectors / sectorsPerGtCoverage);

    // Read Grain Directory (GD)
    const gdBytes = await this.reader.read(gdOffset * VMDK_SECTOR_SIZE, numGrainTables * 4);
    const gtOffsets: number[] = [];
    for (let i = 0; i < numGrainTables; i++) {
      gtOffsets.push(this.readUint32LE(gdBytes, i * 4));
    }

    // Read Grain Tables (GTs)
    const grainTableEntries: number[] = [];
    for (let i = 0; i < numGrainTables; i++) {
      const gtSector = gtOffsets[i];
      if (gtSector === 0) {
        for (let g = 0; g < gtesPerGt; g++) grainTableEntries.push(0);
      } else {
        const gtBytes = await this.reader.read(gtSector * VMDK_SECTOR_SIZE, gtesPerGt * 4);
        for (let g = 0; g < gtesPerGt; g++) {
          grainTableEntries.push(this.readUint32LE(gtBytes, g * 4));
        }
      }
    }

    // Create virtual reader for the full virtual hard disk
    const virtualReader = new VmdkVirtualReader(
      this.reader,
      capacitySectors,
      grainSize,
      gtesPerGt,
      grainTableEntries
    );

    // Inspect virtual Sector 0 (MBR)
    const mbr = await virtualReader.read(0, 512);
    let partitionLba = 2048;
    let partitionType = 0x0c; // default FAT32

    if (mbr[510] === 0x55 && mbr[511] === 0xaa) {
      partitionType = mbr[450];
      const lba = mbr[454] | (mbr[455] << 8) | (mbr[456] << 16) | (mbr[457] << 24);
      if (lba > 0) partitionLba = lba;
    }

    // Check if partition is exFAT (Type 0x07 or "EXFAT   " at partition boot)
    const partBoot = await virtualReader.read(partitionLba * 512, 512);
    const oemName = String.fromCharCode(...partBoot.subarray(3, 11));

    if (oemName === 'EXFAT   ' || partitionType === 0x07) {
      const exfatParser = new ExFatParser(virtualReader, partitionLba);
      const res = await exfatParser.parse();
      res.info.format = 'vmdk-exfat';
      res.info.formatName = 'VMDK Virtual Disk (exFAT Partition)';
      return { root: res.root, info: res.info, virtualReader, exfatParser };
    } else {
      // Parse as FAT32
      const fatParser = new FatParser(virtualReader);
      const res = await fatParser.parse();
      res.info.format = 'vmdk-fat32';
      res.info.formatName = 'VMDK Virtual Disk (FAT32 Partition)';
      return { root: res.root, info: res.info, virtualReader, fatParser };
    }
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
}
