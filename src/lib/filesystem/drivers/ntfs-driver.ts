import { NtfsBuilder } from '../../ntfs/ntfs-builder';
import { NtfsParser } from '../../ntfs/ntfs-parser';
import { NTFS_OEM_NAME } from '../../ntfs/ntfs-types';
import { RandomAccessReader } from '../../reader';
import { VNode } from '../../types';
import { FileSystemDriver, IFileSystemBuilder, IFileSystemParser, PartitionBuilderOptions } from '../fs-types';

export class NtfsDriver implements FileSystemDriver {
  id = 'ntfs' as const;
  name = 'NTFS (New Technology File System)';
  description = 'Standard Windows NT filesystem with Master File Table ($MFT) and robust journaling architecture';
  mbrPartitionType = 0x07; // IFS / NTFS

  createBuilder(root: VNode, options: PartitionBuilderOptions): IFileSystemBuilder {
    return new NtfsBuilder(root, options);
  }

  createParser(reader: RandomAccessReader, partitionStartSector: number = 0): IFileSystemParser {
    return new NtfsParser(reader, partitionStartSector);
  }

  async detect(reader: RandomAccessReader, sectorOffset: number = 0): Promise<boolean> {
    if (reader.size < (sectorOffset + 1) * 512) return false;
    const bootBytes = await reader.read(sectorOffset * 512, 512);
    const oem = String.fromCharCode(...bootBytes.subarray(3, 11));
    const sig = bootBytes[510] | (bootBytes[511] << 8);
    return oem === NTFS_OEM_NAME && sig === 0xaa55;
  }
}
