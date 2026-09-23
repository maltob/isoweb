// High-performance Microsoft VHDX (Virtual Hard Disk v2) Parser & Virtual Disk Reader
// Supports reading, browsing, and extracting files from dynamic and fixed VHDX images.

import { ExFatParser } from '../exfat/exfat-parser';
import { FatParser } from '../fat/fat-parser';
import { NtfsParser } from '../ntfs/ntfs-parser';
import { XfsParser } from '../xfs/xfs-parser';
import { readUint32BE, XFS_SB_MAGIC } from '../xfs/xfs-types';
import { RandomAccessReader } from '../reader';
import { DiskImageInfo, VNode } from '../types';
import { VirtualFS } from '../virtual-fs/virtual-fs';
import {
  bytesToGuid,
  computeCrc32c,
  GUID_BAT_REGION,
  GUID_FILE_PARAMETERS,
  GUID_LOGICAL_SECTOR_SIZE,
  GUID_METADATA_REGION,
  GUID_VIRTUAL_DISK_SIZE,
  VHDX_ALIGNMENT,
  VHDX_DEFAULT_BLOCK_SIZE,
  VHDX_FILE_SIGNATURE,
  VHDX_HEADER_SIGNATURE,
  VHDX_LOGICAL_SECTOR_SIZE,
  VHDX_METADATA_SIGNATURE,
  VhdxPayloadBlockState,
  VHDX_REGION_SIGNATURE,
} from './vhdx-types';

export class VhdxVirtualReader implements RandomAccessReader {
  private physicalReader: RandomAccessReader;
  private blockSize: number;
  private chunkRatio: number;
  private batEntries: BigUint64Array;
  private virtualDiskSize: number;

  constructor(
    physicalReader: RandomAccessReader,
    blockSize: number,
    chunkRatio: number,
    batEntries: BigUint64Array,
    virtualDiskSize: number
  ) {
    this.physicalReader = physicalReader;
    this.blockSize = blockSize;
    this.chunkRatio = chunkRatio;
    this.batEntries = batEntries;
    this.virtualDiskSize = virtualDiskSize;
  }

  get size(): number {
    return this.virtualDiskSize;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset >= this.virtualDiskSize) {
      return new Uint8Array(0);
    }
    const actualLength = Math.min(length, this.virtualDiskSize - offset);
    const result = new Uint8Array(actualLength);
    let resultOffset = 0;
    let currentVirtualOffset = offset;
    let remaining = actualLength;

    while (remaining > 0) {
      const blockIndex = Math.floor(currentVirtualOffset / this.blockSize);
      const inBlockOffset = currentVirtualOffset % this.blockSize;
      const bytesInThisBlock = Math.min(remaining, this.blockSize - inBlockOffset);

      // Map blockIndex to BAT entry index (accounting for interleaved sector bitmap entries)
      const batIndex = blockIndex + Math.floor(blockIndex / this.chunkRatio);

      if (batIndex < this.batEntries.length) {
        const batEntry = this.batEntries[batIndex];
        const state = Number(batEntry & 0x07n);
        const offsetMb = Number(batEntry >> 20n);

        if (state === VhdxPayloadBlockState.FullyPresent) {
          const physicalByteOffset = offsetMb * VHDX_ALIGNMENT + inBlockOffset;
          const chunk = await this.physicalReader.read(physicalByteOffset, bytesInThisBlock);
          result.set(chunk, resultOffset);
        } else {
          // Zero or unallocated payload block
          result.fill(0, resultOffset, resultOffset + bytesInThisBlock);
        }
      } else {
        result.fill(0, resultOffset, resultOffset + bytesInThisBlock);
      }

      resultOffset += bytesInThisBlock;
      currentVirtualOffset += bytesInThisBlock;
      remaining -= bytesInThisBlock;
    }

    return result;
  }
}

export class VhdxParser {
  private reader: RandomAccessReader;

  constructor(reader: RandomAccessReader) {
    this.reader = reader;
  }

  /**
   * Fast check for VHDX signature at offset 0
   */
  static async isVhdx(reader: RandomAccessReader): Promise<boolean> {
    if (reader.size < 64 * 1024) return false;
    const magic = await reader.read(0, 8);
    const str = String.fromCharCode(...magic);
    return str === VHDX_FILE_SIGNATURE;
  }

  /**
   * Parses the VHDX headers, BAT, and mounts the partition into a VirtualFS
   */
  async parse(): Promise<{
    root: VNode;
    info: DiskImageInfo;
    vfs: VirtualFS;
    virtualReader: VhdxVirtualReader;
  }> {
    // 1. Verify File Type Identifier
    const fileTypeId = await this.reader.read(0, 8);
    const magicStr = String.fromCharCode(...fileTypeId);
    if (magicStr !== VHDX_FILE_SIGNATURE) {
      throw new Error(`Invalid VHDX file signature: "${magicStr}"`);
    }

    // 2. Read Headers 1 and 2, validate CRC-32C, pick highest SequenceNumber
    const h1Bytes = await this.reader.read(0x10000, 4096);
    const h2Bytes = await this.reader.read(0x20000, 4096);

    const parseHeader = (buf: Uint8Array) => {
      const sig = this.readUint32LE(buf, 0);
      if (sig !== VHDX_HEADER_SIGNATURE) return null;

      const storedCrc = this.readUint32LE(buf, 4);
      // Zero CRC field to verify
      const copy = new Uint8Array(buf);
      this.writeUint32LE(copy, 4, 0);
      const computedCrc = computeCrc32c(copy, 0, 4096);
      if (storedCrc !== computedCrc) return null;

      const seqNumber = this.readUint64LE(buf, 8);
      return { seqNumber, buf };
    };

    const h1 = parseHeader(h1Bytes);
    const h2 = parseHeader(h2Bytes);
    if (!h1 && !h2) {
      throw new Error('No valid VHDX headers found (CRC-32C mismatch).');
    }

    // 3. Read Region Table (at 0x30000 or 0x40000)
    let regBytes = await this.reader.read(0x30000, 64 * 1024);
    let regSig = this.readUint32LE(regBytes, 0);
    if (regSig !== VHDX_REGION_SIGNATURE) {
      regBytes = await this.reader.read(0x40000, 64 * 1024);
      regSig = this.readUint32LE(regBytes, 0);
    }
    if (regSig !== VHDX_REGION_SIGNATURE) {
      throw new Error('VHDX Region Table signature not found.');
    }

    const regEntryCount = this.readUint32LE(regBytes, 8);
    let batOffset = 0;
    let batLength = 0;
    let metadataOffset = 0;
    let metadataLength = 0;

    for (let i = 0; i < regEntryCount; i++) {
      const entryPos = 16 + i * 32;
      const guid = bytesToGuid(regBytes, entryPos);
      const fOffset = Number(this.readUint64LE(regBytes, entryPos + 16));
      const fLength = this.readUint32LE(regBytes, entryPos + 24);

      if (guid === GUID_BAT_REGION) {
        batOffset = fOffset;
        batLength = fLength;
      } else if (guid === GUID_METADATA_REGION) {
        metadataOffset = fOffset;
        metadataLength = fLength;
      }
    }

    if (!batOffset || !metadataOffset) {
      throw new Error('Could not find required BAT or Metadata region in VHDX.');
    }

    // 4. Read Metadata Region
    const metaBlock = await this.reader.read(metadataOffset, Math.min(metadataLength, 128 * 1024));
    const metaSig = this.readUint64LE(metaBlock, 0);
    if (metaSig !== VHDX_METADATA_SIGNATURE) {
      throw new Error('VHDX Metadata table signature invalid.');
    }

    const metaEntryCount = this.readUint16LE(metaBlock, 10);
    let blockSize = VHDX_DEFAULT_BLOCK_SIZE;
    let virtualDiskSize = 0;
    let logicalSectorSize = VHDX_LOGICAL_SECTOR_SIZE;

    for (let i = 0; i < metaEntryCount; i++) {
      const entryPos = 32 + i * 32;
      const itemGuid = bytesToGuid(metaBlock, entryPos);
      const dataOffset = this.readUint32LE(metaBlock, entryPos + 16);

      if (itemGuid === GUID_FILE_PARAMETERS) {
        blockSize = this.readUint32LE(metaBlock, dataOffset);
      } else if (itemGuid === GUID_VIRTUAL_DISK_SIZE) {
        virtualDiskSize = Number(this.readUint64LE(metaBlock, dataOffset));
      } else if (itemGuid === GUID_LOGICAL_SECTOR_SIZE) {
        logicalSectorSize = this.readUint32LE(metaBlock, dataOffset);
      }
    }

    if (!virtualDiskSize) {
      // Fallback
      virtualDiskSize = 1073741824; // 1 GB default
    }

    // 5. Read Block Allocation Table (BAT)
    const chunkRatio = Math.floor((Math.pow(2, 23) * logicalSectorSize) / blockSize);
    const batData = await this.reader.read(batOffset, batLength);
    const totalBatEntries = Math.floor(batLength / 8);
    const batEntries = new BigUint64Array(totalBatEntries);
    for (let i = 0; i < totalBatEntries; i++) {
      batEntries[i] = this.readUint64LE(batData, i * 8);
    }

    // 6. Create Virtual Disk Reader
    const virtualReader = new VhdxVirtualReader(
      this.reader,
      blockSize,
      chunkRatio,
      batEntries,
      virtualDiskSize
    );

    // 7. Parse inner filesystem from Virtual Sector 0 MBR
    const mbr = await virtualReader.read(0, 512);
    let partitionStartSector = 2048; // Standard 1MB alignment default

    if (mbr[510] === 0x55 && mbr[511] === 0xaa) {
      // Read partition 1 LBA from MBR entry 1 (offset 446 + 8 = 454)
      const p1Lba = this.readUint32LE(mbr, 454);
      if (p1Lba > 0 && p1Lba < virtualDiskSize / logicalSectorSize) {
        partitionStartSector = p1Lba;
      }
    }

    // Inspect boot sector of Partition 1
    const p1Boot = await virtualReader.read(partitionStartSector * logicalSectorSize, 512);
    const p1Magic = readUint32BE(p1Boot, 0);
    const oemStr = String.fromCharCode(...p1Boot.subarray(3, 11));
    const isXfs = p1Magic === XFS_SB_MAGIC;
    const isExFat = oemStr.startsWith('EXFAT');
    const isNtfs = oemStr.startsWith('NTFS');

    if (isXfs) {
      const xfsParser = new XfsParser(virtualReader, partitionStartSector);
      const { root, info } = await xfsParser.parse();
      info.format = 'vhdx-xfs';
      info.formatName = `VHDX Virtual Disk - XFS (${Math.round(virtualDiskSize / (1024 * 1024))}MB)`;
      info.hasMbr = true;

      const vfs = new VirtualFS(root, 'vhdx-xfs', info, virtualReader, undefined, undefined, undefined, xfsParser);
      return { root, info, vfs, virtualReader };
    } else if (isNtfs) {
      const ntfsParser = new NtfsParser(virtualReader, partitionStartSector);
      const { root, info } = await ntfsParser.parse();
      info.format = 'vhdx-ntfs';
      info.formatName = `VHDX Virtual Disk - NTFS (${Math.round(virtualDiskSize / (1024 * 1024))}MB)`;
      info.hasMbr = true;

      const vfs = new VirtualFS(root, 'vhdx-ntfs', info, virtualReader, undefined, undefined, ntfsParser);
      return { root, info, vfs, virtualReader };
    } else if (isExFat) {
      const exfatParser = new ExFatParser(virtualReader, partitionStartSector);
      const { root, info } = await exfatParser.parse();
      info.format = 'vhdx-exfat';
      info.formatName = `VHDX Virtual Disk - exFAT (${Math.round(virtualDiskSize / (1024 * 1024))}MB)`;
      info.hasMbr = true;

      const vfs = new VirtualFS(root, 'vhdx-exfat', info, virtualReader, undefined, exfatParser);
      return { root, info, vfs, virtualReader };
    } else {
      // Mount as FAT (FAT32)
      const fatParser = new FatParser(virtualReader);
      const { root, info } = await fatParser.parse();
      info.format = 'vhdx-fat32';
      info.formatName = `VHDX Virtual Disk - FAT32 (${Math.round(virtualDiskSize / (1024 * 1024))}MB)`;
      info.hasMbr = true;

      const vfs = new VirtualFS(root, 'vhdx-fat32', info, virtualReader, fatParser);
      return { root, info, vfs, virtualReader };
    }
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

  private readUint64LE(buf: Uint8Array, offset: number): bigint {
    const low = BigInt(this.readUint32LE(buf, offset));
    const high = BigInt(this.readUint32LE(buf, offset + 4));
    return (high << 32n) | low;
  }

  private writeUint32LE(buf: Uint8Array, offset: number, val: number) {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
    buf[offset + 2] = (val >> 16) & 0xff;
    buf[offset + 3] = (val >> 24) & 0xff;
  }
}
