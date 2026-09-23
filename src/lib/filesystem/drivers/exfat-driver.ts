import { ExFatBuilder } from '../../exfat/exfat-builder';
import { ExFatParser } from '../../exfat/exfat-parser';
import { EXFAT_OEM_NAME } from '../../exfat/exfat-types';
import { RandomAccessReader } from '../../reader';
import { VNode } from '../../types';
import { FileSystemDriver, IFileSystemBuilder, IFileSystemParser, PartitionBuilderOptions } from '../fs-types';

export class ExFatDriver implements FileSystemDriver {
  id = 'exfat' as const;
  name = 'exFAT (Extensible File Allocation Table)';
  description = 'High-performance modern flash and virtual disk filesystem supporting files > 4GB';
  mbrPartitionType = 0x07; // IFS / exFAT

  createBuilder(root: VNode, options: PartitionBuilderOptions): IFileSystemBuilder {
    return new ExFatBuilder(
      root,
      options.volumeLabel,
      options.partitionSectors,
      options.padToCapacity ?? true,
      options.partitionStartSector ?? 0
    );
  }

  createParser(reader: RandomAccessReader, partitionStartSector: number = 0): IFileSystemParser {
    return new ExFatParser(reader, partitionStartSector);
  }

  async detect(reader: RandomAccessReader, sectorOffset: number = 0): Promise<boolean> {
    if (reader.size < (sectorOffset + 1) * 512) return false;
    const bootBytes = await reader.read(sectorOffset * 512, 512);
    const oem = String.fromCharCode(...bootBytes.subarray(3, 11));
    const sig = bootBytes[510] | (bootBytes[511] << 8);
    return oem === EXFAT_OEM_NAME && sig === 0xaa55;
  }
}
