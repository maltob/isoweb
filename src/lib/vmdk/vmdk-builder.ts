// High-performance VMDK (monolithicSparse) builder
// Creates VMware / VirtualBox / QEMU compatible virtual hard disks with FAT32 or exFAT
import { BlobAccumulatorWriter, ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import { FileSystemRegistry } from '../filesystem/fs-registry';
import {
  VMDK_DEFAULT_GRAIN_SIZE,
  VMDK_FLAG_NL_TEST,
  VMDK_GTES_PER_GT,
  VMDK_MAGIC,
  VMDK_SECTOR_SIZE,
  VMDK_VERSION,
} from './vmdk-types';

export type VmdkFsType = 'fat32' | 'exfat' | 'ntfs' | 'xfs';

export interface VmdkBuilderOptions {
  fsType: VmdkFsType;
  volumeLabel?: string;
  capacitySectors?: number; // Total virtual disk sectors (e.g. 2,097,152 = 1GB)
  diskName?: string;
}

export class VmdkBuilder {
  private root: VNode;
  private options: VmdkBuilderOptions;

  constructor(root: VNode, options: VmdkBuilderOptions) {
    this.root = root;
    const vol = (options.volumeLabel || 'vmdk_disk').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    this.options = {
      capacitySectors: 2097152, // 1GB default
      diskName: `${vol}.vmdk`,
      volumeLabel: 'VMDK_DISK',
      ...options,
    };
  }

  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    const capacitySectors = this.options.capacitySectors || 2097152;
    const grainSize = VMDK_DEFAULT_GRAIN_SIZE; // 128 sectors = 64 KB
    const grainBytes = grainSize * VMDK_SECTOR_SIZE;
    const gtesPerGt = VMDK_GTES_PER_GT; // 512 entries
    const sectorsPerGtCoverage = gtesPerGt * grainSize; // 65,536 sectors (32 MB)

    const numGrainTables = Math.ceil(capacitySectors / sectorsPerGtCoverage);
    const numGdEntries = numGrainTables;
    const gdSectors = Math.max(1, Math.ceil((numGdEntries * 4) / VMDK_SECTOR_SIZE));
    const gtSectors = numGrainTables * Math.ceil((gtesPerGt * 4) / VMDK_SECTOR_SIZE);

    // Layout:
    // Sector 0: Sparse Header (1 sector)
    // Sectors 1..20: Descriptor (20 sectors)
    // Sector 21: Redundant Grain Directory (gdSectors)
    // Sector 21 + gdSectors: Primary Grain Directory (gdSectors)
    // Sector 21 + 2 * gdSectors: Grain Tables (gtSectors)
    const descriptorOffset = 1;
    const descriptorSize = 20;
    const rgdOffset = descriptorOffset + descriptorSize;
    const gdOffset = rgdOffset + gdSectors;
    const gtOffset = gdOffset + gdSectors;
    const rawOverHead = gtOffset + gtSectors;
    // Align overhead to grain boundary
    const overHead = Math.ceil(rawOverHead / grainSize) * grainSize;

    onProgress?.(0.05, 'Building partition filesystem...');

    // 1. Build partition image (Partition 1 starts at Sector 2048 = 1MB offset)
    const partitionStartSector = 2048;
    const partitionSectors = capacitySectors - partitionStartSector;

    const driver = FileSystemRegistry.getDriver(this.options.fsType);
    const fsBuilder = driver.createBuilder(this.root, {
      volumeLabel: this.options.volumeLabel || 'VMDK_DISK',
      partitionSectors,
      partitionStartSector,
      padToCapacity: false,
    });
    const acc = new BlobAccumulatorWriter('application/octet-stream');
    await fsBuilder.buildToStream(acc, (r, s) => {
      onProgress?.(0.05 + r * 0.45, `Building ${driver.name}: ${s}`);
    });
    const partitionBlob = acc.getBlob();

    onProgress?.(0.55, 'Creating VMDK sparse tables...');

    // 2. Generate MBR Sector (Virtual Sector 0)
    const mbrSector = new Uint8Array(VMDK_SECTOR_SIZE);
    // Partition 1 Entry (offset 446)
    mbrSector[446] = 0x80; // Active/Bootable
    // CHS start for LBA 2048 with 255 heads, 63 sectors/track:
    // Cyl 0, Head 32 (0x20), Sector 33 (0x21)
    mbrSector[447] = 0x20; // Start Head (32)
    mbrSector[448] = 0x21; // Start Sector (33)
    mbrSector[449] = 0x00; // Start Cyl (0)
    mbrSector[450] = driver.mbrPartitionType ?? (this.options.fsType === 'fat32' ? 0x0c : 0x07);
    mbrSector[451] = 0xfe; // End Head
    mbrSector[452] = 0xff; // End Sector/Cylinder
    mbrSector[453] = 0xff;
    this.writeUint32LE(mbrSector, 454, partitionStartSector); // Starting LBA
    this.writeUint32LE(mbrSector, 458, partitionSectors); // Total Sectors
    mbrSector[510] = 0x55;
    mbrSector[511] = 0xaa;

    // 3. Scan grains and allocate sparse tables
    // Virtual space:
    // Grain 0: contains MBR (Sector 0) and padding
    // Grains 1..15: Padding up to Sector 2048 (1MB)
    // Grains 16+: Partition filesystem data
    const partitionBytes = new Uint8Array(await partitionBlob.arrayBuffer());
    const partitionGrains = Math.ceil(partitionBytes.byteLength / grainBytes);

    // Map virtual grains to physical file sectors
    const grainTableEntries: number[] = new Array(numGrainTables * gtesPerGt).fill(0);
    let currentPhysicalSector = overHead;
    const grainsToWrite: { virtualGrain: number; physicalSector: number; data: Uint8Array }[] = [];

    // Grain 0 (MBR)
    const grain0Data = new Uint8Array(grainBytes);
    grain0Data.set(mbrSector, 0);
    grainTableEntries[0] = currentPhysicalSector;
    grainsToWrite.push({ virtualGrain: 0, physicalSector: currentPhysicalSector, data: grain0Data });
    currentPhysicalSector += grainSize;

    // Partition Grains (Virtual Grain 16 onwards)
    const partitionStartGrain = Math.floor(partitionStartSector / grainSize); // 16
    for (let g = 0; g < partitionGrains; g++) {
      const start = g * grainBytes;
      const end = Math.min(start + grainBytes, partitionBytes.byteLength);
      const slice = partitionBytes.subarray(start, end);

      // Check if grain is all zeros (sparse optimization)
      let isZero = true;
      for (let b = 0; b < slice.length; b++) {
        if (slice[b] !== 0) {
          isZero = false;
          break;
        }
      }

      const virtualGrain = partitionStartGrain + g;
      if (!isZero && virtualGrain < grainTableEntries.length) {
        grainTableEntries[virtualGrain] = currentPhysicalSector;
        const grainData = new Uint8Array(grainBytes);
        grainData.set(slice, 0);
        grainsToWrite.push({ virtualGrain, physicalSector: currentPhysicalSector, data: grainData });
        currentPhysicalSector += grainSize;
      }
    }

    // Ensure Backup VBR at the last sector of the partition (required for NTFS)
    if (this.options.fsType === 'ntfs') {
      const primaryVbr = partitionBytes.subarray(0, 512);
      const lastSector = capacitySectors - 1;
      const lastVirtualGrain = Math.floor(lastSector / grainSize);
      const lastSectorOffsetInGrain = (lastSector % grainSize) * VMDK_SECTOR_SIZE;

      const existing = grainsToWrite.find(gw => gw.virtualGrain === lastVirtualGrain);
      if (existing) {
        existing.data.set(primaryVbr, lastSectorOffsetInGrain);
      } else if (lastVirtualGrain < grainTableEntries.length) {
        grainTableEntries[lastVirtualGrain] = currentPhysicalSector;
        const grainData = new Uint8Array(grainBytes);
        grainData.set(primaryVbr, lastSectorOffsetInGrain);
        grainsToWrite.push({ virtualGrain: lastVirtualGrain, physicalSector: currentPhysicalSector, data: grainData });
        currentPhysicalSector += grainSize;
      }
    }

    // 4. Build Sparse Extent Header (Sector 0)
    const headerBytes = new Uint8Array(VMDK_SECTOR_SIZE);
    this.writeUint32LE(headerBytes, 0, VMDK_MAGIC);
    this.writeUint32LE(headerBytes, 4, VMDK_VERSION);
    this.writeUint32LE(headerBytes, 8, VMDK_FLAG_NL_TEST);
    this.writeUint64LE(headerBytes, 12, capacitySectors);
    this.writeUint64LE(headerBytes, 20, grainSize);
    this.writeUint64LE(headerBytes, 28, descriptorOffset);
    this.writeUint64LE(headerBytes, 36, descriptorSize);
    this.writeUint32LE(headerBytes, 44, gtesPerGt);
    this.writeUint64LE(headerBytes, 48, rgdOffset);
    this.writeUint64LE(headerBytes, 56, gdOffset);
    this.writeUint64LE(headerBytes, 64, overHead);
    headerBytes[72] = 0; // uncleanShutdown
    headerBytes[73] = 0x0a; // singleEndLineChar ('\n')
    headerBytes[74] = 0x20; // nonEndLineChar (' ')
    headerBytes[75] = 0x0d; // doubleEndLineChar1 ('\r')
    headerBytes[76] = 0x0a; // doubleEndLineChar2 ('\n')

    // 5. Build Text Descriptor (Sectors 1..20)
    // VMware SCSI (lsilogic) geometry MUST specify 255 heads and 63 sectors/track
    const heads = 255;
    const sectors = 63;
    const cylinders = Math.max(1, Math.floor(capacitySectors / (heads * sectors)));
    const descriptorText = [
      '# Disk DescriptorFile',
      'version=1',
      'CID=7f2c84a1',
      'parentCID=ffffffff',
      'createType="monolithicSparse"',
      '',
      '# Extent description',
      `RW ${capacitySectors} SPARSE "${this.options.diskName}"`,
      '',
      '# The Disk Data Base',
      '#DDB',
      'ddb.adapterType = "lsilogic"',
      `ddb.geometry.cylinders = "${cylinders}"`,
      'ddb.geometry.heads = "255"',
      'ddb.geometry.sectors = "63"',
      'ddb.virtualHWVersion = "7"',
      '',
    ].join('\r\n');

    const descriptorBytes = new Uint8Array(descriptorSize * VMDK_SECTOR_SIZE);
    for (let i = 0; i < descriptorText.length; i++) {
      descriptorBytes[i] = descriptorText.charCodeAt(i);
    }

    // 6. Build Grain Directory (GD) and Redundant GD (RGD)
    const gdBytes = new Uint8Array(gdSectors * VMDK_SECTOR_SIZE);
    const gtSectorsPerTable = Math.ceil((gtesPerGt * 4) / VMDK_SECTOR_SIZE);
    for (let i = 0; i < numGrainTables; i++) {
      const gtSectorOffset = gtOffset + i * gtSectorsPerTable;
      this.writeUint32LE(gdBytes, i * 4, gtSectorOffset);
    }

    // 7. Build Grain Tables (GTs)
    const allGtBytes = new Uint8Array(gtSectors * VMDK_SECTOR_SIZE);
    for (let i = 0; i < grainTableEntries.length; i++) {
      this.writeUint32LE(allGtBytes, i * 4, grainTableEntries[i]);
    }

    // 8. Stream the VMDK image
    onProgress?.(0.7, 'Streaming VMDK header and metadata...');
    await writer.write(headerBytes);
    await writer.write(descriptorBytes);

    // Redundant GD (RGD)
    await writer.write(gdBytes);
    // Primary GD
    await writer.write(gdBytes);
    // Grain Tables
    await writer.write(allGtBytes);

    // Pad up to overhead sector
    const sectorsWritten = gtOffset + gtSectors;
    const padToOverhead = (overHead - sectorsWritten) * VMDK_SECTOR_SIZE;
    if (padToOverhead > 0) {
      await writer.write(new Uint8Array(padToOverhead));
    }

    // 9. Stream allocated grains
    onProgress?.(0.85, 'Streaming VMDK data grains...');
    for (let i = 0; i < grainsToWrite.length; i++) {
      const grain = grainsToWrite[i];
      await writer.write(grain.data);
    }

    onProgress?.(1.0, 'VMDK generation complete.');
  }

  async buildBlob(onProgress?: (ratio: number, status: string) => void): Promise<Blob> {
    const accumulator = new BlobAccumulatorWriter('application/x-vmdk');
    await this.buildToStream(accumulator, onProgress);
    return accumulator.getBlob();
  }

  private writeUint32LE(buf: Uint8Array, offset: number, val: number) {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
    buf[offset + 2] = (val >> 16) & 0xff;
    buf[offset + 3] = (val >> 24) & 0xff;
  }

  private writeUint64LE(buf: Uint8Array, offset: number, val: number) {
    this.writeUint32LE(buf, offset, val & 0xffffffff);
    this.writeUint32LE(buf, offset + 4, Math.floor(val / 0x100000000));
  }
}
