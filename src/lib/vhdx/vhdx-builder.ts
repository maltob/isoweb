// High-performance Microsoft VHDX (Virtual Hard Disk v2) Builder
// Builds dynamic (sparse) VHDX images formatted with FAT32 or exFAT partitions.
// 100% browser-only and zero-RAM streaming compatible.

import { BlobAccumulatorWriter, ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import { FileSystemRegistry } from '../filesystem/fs-registry';
import {
  computeCrc32c,
  generateRandomGuid,
  guidToBytes,
  VHDX_ALIGNMENT,
  VHDX_DEFAULT_BLOCK_SIZE,
  VHDX_FILE_SIGNATURE,
  VHDX_HEADER_SIGNATURE,
  VHDX_LOGICAL_SECTOR_SIZE,
  VHDX_METADATA_SIGNATURE,
  VHDX_PHYSICAL_SECTOR_SIZE,
  VhdxPayloadBlockState,
  VhdxSectorBitmapBlockState,
  VHDX_REGION_SIGNATURE,
  GUID_BAT_REGION,
  GUID_FILE_PARAMETERS,
  GUID_LOGICAL_SECTOR_SIZE,
  GUID_METADATA_REGION,
  GUID_PHYSICAL_SECTOR_SIZE,
  GUID_VIRTUAL_DISK_ID,
  GUID_VIRTUAL_DISK_SIZE,
} from './vhdx-types';

export interface VhdxBuilderOptions {
  fsType: 'fat32' | 'exfat' | 'ntfs' | 'xfs';
  volumeLabel?: string;
  capacitySectors?: number; // Virtual disk capacity in 512-byte sectors (default: 1 GB = 2097152 sectors)
}

export class VhdxBuilder {
  private root: VNode;
  private options: Required<VhdxBuilderOptions>;

  constructor(root: VNode, options: VhdxBuilderOptions) {
    this.root = root;
    this.options = {
      fsType: options.fsType,
      volumeLabel: options.volumeLabel || 'VHDX_DISK',
      capacitySectors: Math.max(options.capacitySectors || 2097152, 67000), // Min ~33.5 MB
    };
  }

  /**
   * Builds the VHDX dynamic image directly to a stream writer with Zero RAM buffering
   */
  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    onProgress?.(0.05, 'Formatting virtual partition...');

    const blockSize = VHDX_DEFAULT_BLOCK_SIZE; // 1 MB
    const logicalSectorSize = VHDX_LOGICAL_SECTOR_SIZE; // 512
    const virtualDiskSize = this.options.capacitySectors * logicalSectorSize;

    // 1. Build the filesystem partition
    // Virtual partition starts at Sector 2048 (1 MB offset)
    const partitionStartSector = 2048;
    const partitionSectors = this.options.capacitySectors - partitionStartSector;

    const driver = FileSystemRegistry.getDriver(this.options.fsType);
    const fsBuilder = driver.createBuilder(this.root, {
      volumeLabel: this.options.volumeLabel,
      partitionSectors,
      partitionStartSector,
      padToCapacity: false,
    });
    const acc = new BlobAccumulatorWriter('application/octet-stream');
    await fsBuilder.buildToStream(acc, (r, s) => {
      onProgress?.(0.05 + r * 0.25, s);
    });
    const partitionBlob = acc.getBlob();

    onProgress?.(0.3, 'Allocating VHDX structures & BAT...');

    // 2. Build Virtual Sector 0 MBR Partition Table
    const mbrSector = new Uint8Array(512);
    // Partition entry 1 at offset 446
    mbrSector[446] = 0x80; // Active / Bootable
    // CHS start for LBA 2048 with 255 heads, 63 sectors/track:
    // Cyl 0, Head 32 (0x20), Sector 33 (0x21)
    mbrSector[447] = 0x20; // Head 32
    mbrSector[448] = 0x21; // Sector 33
    mbrSector[449] = 0x00; // Cyl 0
    mbrSector[450] = driver.mbrPartitionType ?? (this.options.fsType === 'fat32' ? 0x0c : 0x07);
    mbrSector[451] = 0xfe; // End Head
    mbrSector[452] = 0xff; // End Sec/Cyl
    mbrSector[453] = 0xff;
    this.writeUint32LE(mbrSector, 454, partitionStartSector); // Starting LBA (2048)
    this.writeUint32LE(mbrSector, 458, partitionSectors); // Total Sectors
    mbrSector[510] = 0x55;
    mbrSector[511] = 0xaa;

    // 3. Analyze virtual space blocks (1 MB each)
    const totalPayloadBlocks = Math.ceil(virtualDiskSize / blockSize);
    // ChunkRatio = (2^23 * logicalSectorSize) / blockSize = (8388608 * 512) / 1048576 = 4096
    const chunkRatio = Math.floor((Math.pow(2, 23) * logicalSectorSize) / blockSize);
    const totalChunks = Math.ceil(totalPayloadBlocks / chunkRatio);
    const totalBatEntries = totalPayloadBlocks + totalChunks;
    const batByteSize = totalBatEntries * 8;
    const batRegionSize = Math.max(VHDX_ALIGNMENT, Math.ceil(batByteSize / VHDX_ALIGNMENT) * VHDX_ALIGNMENT);

    // Layout plan (all 1MB aligned):
    // 0x000000: File Type ID (64KB), Header 1 (64KB), Header 2 (64KB), Region Table 1 (64KB), Region Table 2 (64KB) -> up to 1MB
    // 0x100000 (1 MB): Metadata Region (1 MB)
    // 0x200000 (2 MB): BAT Region (batRegionSize)
    // Physical payload offset starts at 0x200000 + batRegionSize
    const metadataRegionOffset = 1 * VHDX_ALIGNMENT; // 1 MB
    const metadataRegionLength = 1 * VHDX_ALIGNMENT; // 1 MB
    const batRegionOffset = metadataRegionOffset + metadataRegionLength; // 2 MB
    let currentPhysicalOffset = batRegionOffset + batRegionSize;

    // Read partition data
    const partitionBlocks = Math.ceil(partitionBlob.size / blockSize);

    // Prepare BAT entries (uint64 LE array)
    // Each entry: bits 0..2 = state, bits 20..63 = physical file offset in MB
    const batEntries = new BigUint64Array(totalBatEntries);

    // In MS-VHDX dynamic virtual disks, all sparse/unallocated payload blocks
    // MUST have state = PAYLOAD_BLOCK_ZERO (2), so reads return zeros.
    for (let p = 0; p < totalPayloadBlocks; p++) {
      const batIndex = p + Math.floor(p / chunkRatio);
      batEntries[batIndex] = BigInt(VhdxPayloadBlockState.Zero);
    }

    // Sector bitmap entries in BAT: In dynamic disks, state = SB_BLOCK_NOT_PRESENT (0)
    for (let c = 0; c < totalChunks; c++) {
      const sbBatIndex = (c + 1) * chunkRatio + c;
      if (sbBatIndex < totalBatEntries) {
        batEntries[sbBatIndex] = BigInt(VhdxSectorBitmapBlockState.NotPresent);
      }
    }

    // Block 0: Contains Sector 0 MBR and beginning of partition (or padding up to Sector 2048)
    const block0Data = new Uint8Array(blockSize);
    block0Data.set(mbrSector, 0);
    // If partitionStartSector (2048) is 1MB, the partition data begins right at Block 1!
    // But if partition starts at < 1MB, Block 0 has MBR at 0 and partition start data.
    const partitionStartBytes = partitionStartSector * logicalSectorSize;
    if (partitionStartBytes < blockSize) {
      const copyLen = Math.min(partitionBlob.size, blockSize - partitionStartBytes);
      const overlapSlice = await partitionBlob.slice(0, copyLen).arrayBuffer();
      block0Data.set(new Uint8Array(overlapSlice), partitionStartBytes);
    }

    // Allocate Block 0
    const block0BatIndex = 0; // entry index for block 0
    const block0OffsetMb = BigInt(currentPhysicalOffset / VHDX_ALIGNMENT);
    batEntries[block0BatIndex] = (block0OffsetMb << 20n) | BigInt(VhdxPayloadBlockState.FullyPresent);
    currentPhysicalOffset += blockSize;

    // Pass 1: Scan 1MB slices of partitionBlob to determine non-zero blocks (Low RAM!)
    const activePartitionBlocks: number[] = [];
    for (let p = 0; p < partitionBlocks; p++) {
      const pStart = p * blockSize;
      const pEnd = Math.min(pStart + blockSize, partitionBlob.size);
      const slice = new Uint8Array(await partitionBlob.slice(pStart, pEnd).arrayBuffer());

      // Check if block contains non-zero data
      let isZero = true;
      for (let b = 0; b < slice.byteLength; b++) {
        if (slice[b] !== 0) {
          isZero = false;
          break;
        }
      }

      const virtualBlockIdx = p + 1; // since block 0 is MBR
      if (virtualBlockIdx < totalPayloadBlocks) {
        const batIndex = virtualBlockIdx + Math.floor(virtualBlockIdx / chunkRatio);
        if (!isZero) {
          const offsetMb = BigInt(currentPhysicalOffset / VHDX_ALIGNMENT);
          batEntries[batIndex] = (offsetMb << 20n) | BigInt(VhdxPayloadBlockState.FullyPresent);
          activePartitionBlocks.push(p);
          currentPhysicalOffset += blockSize;
        }
      }
    }

    // Ensure Backup VBR at the last sector of the partition (required for NTFS)
    const isNtfs = this.options.fsType === 'ntfs';
    let needsDedicatedBackupBlock = false;
    let backupBlockIndex = -1;
    let backupSectorOffsetInBlock = 0;
    let primaryVbrBytes: Uint8Array | null = null;

    if (isNtfs) {
      primaryVbrBytes = new Uint8Array(await partitionBlob.slice(0, 512).arrayBuffer());
      const backupVbrSector = partitionStartSector + partitionSectors - 1;
      const backupVbrByteOffset = backupVbrSector * logicalSectorSize;
      backupBlockIndex = Math.floor(backupVbrByteOffset / blockSize);
      backupSectorOffsetInBlock = backupVbrByteOffset % blockSize;

      if (backupBlockIndex === 0) {
        block0Data.set(primaryVbrBytes, backupSectorOffsetInBlock);
      } else {
        const partitionBlockIndex = backupBlockIndex - 1;
        if (!activePartitionBlocks.includes(partitionBlockIndex)) {
          needsDedicatedBackupBlock = true;
          const batIndex = backupBlockIndex + Math.floor(backupBlockIndex / chunkRatio);
          const offsetMb = BigInt(currentPhysicalOffset / VHDX_ALIGNMENT);
          batEntries[batIndex] = (offsetMb << 20n) | BigInt(VhdxPayloadBlockState.FullyPresent);
          currentPhysicalOffset += blockSize;
        }
      }
    }

    onProgress?.(0.5, 'Writing VHDX headers and metadata...');

    // 4. Build File Type ID (0x00000, 64 KB)
    const fileTypeIdSector = new Uint8Array(64 * 1024);
    for (let i = 0; i < 8; i++) fileTypeIdSector[i] = VHDX_FILE_SIGNATURE.charCodeAt(i);
    // Creator: UTF-16LE "DISKWEB "
    const creatorStr = 'DISKWEB ';
    for (let i = 0; i < creatorStr.length; i++) {
      fileTypeIdSector[8 + i * 2] = creatorStr.charCodeAt(i);
      fileTypeIdSector[8 + i * 2 + 1] = 0;
    }

    // 5. Build Headers 1 & 2 (0x10000 and 0x20000, each 64 KB)
    const fileWriteGuid = guidToBytes(generateRandomGuid());
    const dataWriteGuid = guidToBytes(generateRandomGuid());

    const buildHeaderSector = (seqNumber: bigint): Uint8Array => {
      const hSector = new Uint8Array(64 * 1024);
      // Signature: 'head' (4 bytes)
      this.writeUint32LE(hSector, 0, VHDX_HEADER_SIGNATURE);
      // Checksum: at offset 4 (zero during computation)
      // SequenceNumber: at offset 8 (uint64 LE)
      this.writeUint64LE(hSector, 8, seqNumber);
      // FileWriteGuid: at offset 16 (16 bytes)
      hSector.set(fileWriteGuid, 16);
      // DataWriteGuid: at offset 32 (16 bytes)
      hSector.set(dataWriteGuid, 32);
      // LogGuid: at offset 48 (zeros)
      // LogVersion: at offset 64 (0 uint16)
      // Version: at offset 66 (1 uint16)
      this.writeUint16LE(hSector, 66, 1);
      // LogLength: at offset 68 (0 uint32)
      // LogOffset: at offset 72 (0 uint64)

      // Compute CRC-32C over the 4096-byte header structure
      const crc = computeCrc32c(hSector, 0, 4096);
      this.writeUint32LE(hSector, 4, crc);
      return hSector;
    };

    const header1Sector = buildHeaderSector(1n);
    const header2Sector = buildHeaderSector(2n);

    // 6. Build Region Tables 1 & 2 (0x30000 and 0x40000, each 64 KB)
    const buildRegionTableSector = (): Uint8Array => {
      const regSector = new Uint8Array(64 * 1024);
      // Signature: 'regi' (4 bytes)
      this.writeUint32LE(regSector, 0, VHDX_REGION_SIGNATURE);
      // Checksum: at offset 4 (zero during computation)
      // EntryCount: at offset 8 (2 entries)
      this.writeUint32LE(regSector, 8, 2);

      // Entry 1: BAT Region
      const batGuidBytes = guidToBytes(GUID_BAT_REGION);
      regSector.set(batGuidBytes, 16);
      this.writeUint64LE(regSector, 32, BigInt(batRegionOffset));
      this.writeUint32LE(regSector, 40, batRegionSize);
      this.writeUint32LE(regSector, 44, 1); // Required = 1

      // Entry 2: Metadata Region
      const metaGuidBytes = guidToBytes(GUID_METADATA_REGION);
      regSector.set(metaGuidBytes, 48);
      this.writeUint64LE(regSector, 64, BigInt(metadataRegionOffset));
      this.writeUint32LE(regSector, 72, metadataRegionLength);
      this.writeUint32LE(regSector, 76, 1); // Required = 1

      // Compute CRC-32C of 64KB region table with checksum field zeroed
      const crc = computeCrc32c(regSector, 0, 64 * 1024);
      this.writeUint32LE(regSector, 4, crc);
      return regSector;
    };

    const regionTable1 = buildRegionTableSector();
    const regionTable2 = buildRegionTableSector();

    // Write Sector 0..1MB (First 1MB block)
    await writer.write(fileTypeIdSector); // 0x00000..0x0FFFF (64 KB)
    await writer.write(header1Sector);    // 0x10000..0x1FFFF (64 KB)
    await writer.write(header2Sector);    // 0x20000..0x2FFFF (64 KB)
    await writer.write(regionTable1);     // 0x30000..0x3FFFF (64 KB)
    await writer.write(regionTable2);     // 0x40000..0x4FFFF (64 KB)
    // Pad up to 1 MB (0x100000)
    const preambleRemaining = VHDX_ALIGNMENT - 5 * (64 * 1024);
    if (preambleRemaining > 0) {
      await writer.write(new Uint8Array(preambleRemaining));
    }

    // 7. Build Metadata Region (0x100000, 1 MB)
    const metadataBlock = new Uint8Array(metadataRegionLength);
    // Header at offset 0:
    // Signature: 'metadata' (8 bytes uint64 LE: 0x617461646174656dn)
    this.writeUint64LE(metadataBlock, 0, VHDX_METADATA_SIGNATURE);
    this.writeUint16LE(metadataBlock, 8, 0); // Reserved
    this.writeUint16LE(metadataBlock, 10, 5); // EntryCount = 5

    // Metadata entries (32 bytes each, starting at offset 32):
    // Entry 0: File Parameters (Offset 64KB, Length 8)
    const dataOffsetBase = 64 * 1024;
    let currentMetaOffset = dataOffsetBase;

    const addMetaEntry = (idx: number, guidStr: string, length: number, isVirtualDisk: boolean = true) => {
      const entryPos = 32 + idx * 32;
      metadataBlock.set(guidToBytes(guidStr), entryPos);
      this.writeUint32LE(metadataBlock, entryPos + 16, currentMetaOffset);
      this.writeUint32LE(metadataBlock, entryPos + 20, length);
      // MS-VHDX Section 2.4.2:
      // Bit 0: IsUser = 0 (system metadata)
      // Bit 1: IsVirtualDisk = isVirtualDisk ? 1 : 0
      // Bit 2: IsRequired = 1
      const flags = (isVirtualDisk ? 2 : 0) | 4;
      this.writeUint32LE(metadataBlock, entryPos + 24, flags);
      const pos = currentMetaOffset;
      currentMetaOffset += (length + 7) & ~7; // 8-byte align offset
      return pos;
    };

    const fileParamsPos = addMetaEntry(0, GUID_FILE_PARAMETERS, 8, false);
    const diskSizePos = addMetaEntry(1, GUID_VIRTUAL_DISK_SIZE, 8, true);
    const diskIdPos = addMetaEntry(2, GUID_VIRTUAL_DISK_ID, 16, true);
    const logicalSecPos = addMetaEntry(3, GUID_LOGICAL_SECTOR_SIZE, 4, true);
    const physicalSecPos = addMetaEntry(4, GUID_PHYSICAL_SECTOR_SIZE, 4, true);

    // Value: File Parameters (BlockSize = 1MB, Flags = 0)
    this.writeUint32LE(metadataBlock, fileParamsPos, blockSize);
    this.writeUint32LE(metadataBlock, fileParamsPos + 4, 0);

    // Value: Virtual Disk Size (uint64 LE)
    this.writeUint64LE(metadataBlock, diskSizePos, BigInt(virtualDiskSize));

    // Value: Virtual Disk ID (16 bytes GUID)
    metadataBlock.set(guidToBytes(generateRandomGuid()), diskIdPos);

    // Value: Logical Sector Size (512)
    this.writeUint32LE(metadataBlock, logicalSecPos, logicalSectorSize);

    // Value: Physical Sector Size (4096)
    this.writeUint32LE(metadataBlock, physicalSecPos, VHDX_PHYSICAL_SECTOR_SIZE);

    await writer.write(metadataBlock);

    // 8. Build Block Allocation Table (BAT) Region (0x200000, batRegionSize)
    onProgress?.(0.7, 'Streaming Block Allocation Table...');
    const batBlock = new Uint8Array(batRegionSize);
    for (let i = 0; i < totalBatEntries; i++) {
      this.writeUint64LE(batBlock, i * 8, batEntries[i]);
    }
    await writer.write(batBlock);

    // 9. Stream allocated payload data blocks (1 MB aligned, streaming on-demand!)
    onProgress?.(0.85, 'Streaming payload data blocks...');
    // Write Block 0 (MBR + padding)
    await writer.write(block0Data);

    // Stream each active partition block on demand
    for (let i = 0; i < activePartitionBlocks.length; i++) {
      const p = activePartitionBlocks[i];
      const pStart = p * blockSize;
      const pEnd = Math.min(pStart + blockSize, partitionBlob.size);
      const slice = new Uint8Array(await partitionBlob.slice(pStart, pEnd).arrayBuffer());
      const blockData = slice.byteLength === blockSize ? slice : new Uint8Array(blockSize);
      if (slice.byteLength !== blockSize) {
        blockData.set(slice, 0);
      }

      // If this block contains the backup VBR, write it
      if (isNtfs && primaryVbrBytes && backupBlockIndex - 1 === p) {
        blockData.set(primaryVbrBytes, backupSectorOffsetInBlock);
      }

      await writer.write(blockData);
      onProgress?.(
        0.85 + ((i + 1) / Math.max(1, activePartitionBlocks.length)) * 0.14,
        `Streaming block ${i + 1} / ${activePartitionBlocks.length}...`
      );
    }

    // Write dedicated backup VBR block if it wasn't within active partition blocks
    if (needsDedicatedBackupBlock && primaryVbrBytes) {
      const backupBlock = new Uint8Array(blockSize);
      backupBlock.set(primaryVbrBytes, backupSectorOffsetInBlock);
      await writer.write(backupBlock);
    }

    onProgress?.(1.0, 'VHDX dynamic virtual disk created successfully.');
  }

  /**
   * Builds the entire VHDX file as an in-memory Blob
   */
  async buildBlob(onProgress?: (ratio: number, status: string) => void): Promise<Blob> {
    const accumulator = new BlobAccumulatorWriter('application/x-vhdx');
    await this.buildToStream(accumulator, onProgress);
    return accumulator.getBlob();
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

  private writeUint64LE(buf: Uint8Array, offset: number, val: bigint) {
    const low = Number(val & 0xffffffffn);
    const high = Number((val >> 32n) & 0xffffffffn);
    this.writeUint32LE(buf, offset, low);
    this.writeUint32LE(buf, offset + 4, high);
  }
}
