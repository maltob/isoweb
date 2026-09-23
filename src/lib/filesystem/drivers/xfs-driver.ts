// Driver for modular XFS filesystem integration
import { XfsBuilder } from '../../xfs/xfs-builder';
import { XfsParser } from '../../xfs/xfs-parser';
import { readUint32BE, XFS_SB_MAGIC } from '../../xfs/xfs-types';
import { RandomAccessReader } from '../../reader';
import { VNode } from '../../types';
import {
  FileSystemDriver,
  IFileSystemBuilder,
  IFileSystemParser,
  PartitionBuilderOptions,
} from '../fs-types';

export class XfsDriver implements FileSystemDriver {
  id = 'xfs' as const;
  name = 'XFS (Extents File System)';
  description = 'High-performance 64-bit journaling filesystem widely used in Linux distributions (RHEL, Rocky, CentOS, SUSE)';
  mbrPartitionType = 0x83; // Linux Native Partition

  createBuilder(root: VNode, options: PartitionBuilderOptions): IFileSystemBuilder {
    return new XfsBuilder(root, options);
  }

  createParser(reader: RandomAccessReader, partitionStartSector: number = 0): IFileSystemParser {
    return new XfsParser(reader, partitionStartSector);
  }

  async detect(reader: RandomAccessReader, sectorOffset: number = 0): Promise<boolean> {
    if (reader.size < (sectorOffset + 1) * 512) return false;
    const sectorBytes = await reader.read(sectorOffset * 512, 512);
    const magic = readUint32BE(sectorBytes, 0);
    return magic === XFS_SB_MAGIC;
  }
}
