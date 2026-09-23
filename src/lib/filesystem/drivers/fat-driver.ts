import { FatBuilder } from '../../fat/fat-builder';
import { FatParser } from '../../fat/fat-parser';
import { FatType } from '../../fat/fat-types';
import { RandomAccessReader } from '../../reader';
import { VNode } from '../../types';
import { FileSystemDriver, IFileSystemBuilder, IFileSystemParser, PartitionBuilderOptions } from '../fs-types';

export class Fat32Driver implements FileSystemDriver {
  id = 'fat32' as const;
  name = 'FAT32 (File Allocation Table 32)';
  description = 'Broadly compatible filesystem for UEFI boot, firmware, and USB disks (< 4GB per file)';
  mbrPartitionType = 0x0c; // FAT32 LBA

  createBuilder(root: VNode, options: PartitionBuilderOptions): IFileSystemBuilder {
    return new FatBuilder(root, {
      fatType: FatType.FAT32,
      volumeLabel: options.volumeLabel,
      totalSectors: options.partitionSectors,
      hasMbr: false,
      hiddenSectors: options.partitionStartSector ?? 0,
      padToCapacity: options.padToCapacity ?? true,
    });
  }

  createParser(reader: RandomAccessReader, _partitionStartSector: number = 0): IFileSystemParser {
    return new FatParser(reader);
  }

  async detect(reader: RandomAccessReader, sectorOffset: number = 0): Promise<boolean> {
    if (reader.size < (sectorOffset + 1) * 512) return false;
    const bootBytes = await reader.read(sectorOffset * 512, 512);
    const sig = bootBytes[510] | (bootBytes[511] << 8);
    if (sig !== 0xaa55) return false;
    const fsType = String.fromCharCode(...bootBytes.subarray(82, 90));
    return fsType.startsWith('FAT32');
  }
}
