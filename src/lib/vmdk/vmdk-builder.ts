// High-performance VMDK (monolithicSparse) builder
// Creates VMware / VirtualBox / QEMU compatible virtual hard disks with FAT32 or exFAT
import { ExFatBuilder } from '../exfat/exfat-builder';
import { FatBuilder } from '../fat/fat-builder';
import { FatType } from '../fat/fat-types';
import { BlobAccumulatorWriter, ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import {
  VMDK_DEFAULT_GRAIN_SIZE,
  VMDK_FLAG_NL_TEST,
  VMDK_GTES_PER_GT,
  VMDK_MAGIC,
  VMDK_SECTOR_SIZE,
  VMDK_VERSION,
} from './vmdk-types';

export type VmdkFsType = 'fat32' | 'exfat';

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
    this.options = {
      capacitySectors: 2097152, // 1GB default
      diskName: 'disk.vmdk',
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

    let partitionBlob: Blob;
    if (this.options.fsType === 'fat32') {
      const fatBuilder = new FatBuilder(this.root, {
        fatType: FatType.FAT32,
        volumeLabel: this.options.volumeLabel,
        totalSectors: partitionSectors,
      });
      partitionBlob = await fatBuilder.buildBlob((r, s) => {
        onProgress?.(0.05 + r * 0.45, `Building FAT32: ${s}`);
      });
    } else {
      const exfatBuilder = new ExFatBuilder(this.root, this.options.volumeLabel, partitionSectors, false);
      const acc = new BlobAccumulatorWriter('application/octet-stream');
      await exfatBuilder.buildToStream(acc, (r, s) => {
        onProgress?.(0.05 + r * 0.45, `Building exFAT: ${s}`);
      });
      partitionBlob = acc.getBlob();
    }

    onProgress?.(0.55, 'Creating VMDK sparse tables...');

    // 2. Generate MBR Sector (Virtual Sector 0)
    const mbrSector = new Uint8Array(VMDK_SECTOR_SIZE);
    // Partition 1 Entry (offset 446)
    mbrSector[446] = 0x80; // Active/Bootable
    mbrSector[447] = 0x00; // Start Head
    mbrSector[448] = 0x02; // Start Sector/Cylinder
    mbrSector[449] = 0x00;
    mbrSector[450] = this.options.fsType === 'fat32' ? 0x0c : 0x07; // 0x0C = FAT32 LBA, 0x07 = exFAT
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
    const cylinders = Math.max(1, Math.floor(capacitySectors / (16 * 63)));
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
      'ddb.geometry.heads = "16"',
      'ddb.geometry.sectors = "63"',
      'ddb.virtualHWVersion = "4"',
      '',
    ].join('\n');

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
