// Common interfaces for modular filesystem builders and parsers
import { ImageStreamWriter } from '../storage/stream-writer';
import { RandomAccessReader } from '../reader';
import { DiskImageInfo, VNode } from '../types';

export type SupportedPartitionFs = 'fat12' | 'fat16' | 'fat32' | 'exfat' | 'ntfs' | 'xfs';

export interface PartitionBuilderOptions {
  volumeLabel: string;
  partitionSectors: number;
  partitionStartSector?: number;
  padToCapacity?: boolean;
}

export interface IFileSystemBuilder {
  buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void>;
}

export interface IFileSystemParser {
  parse(): Promise<{ root: VNode; info: DiskImageInfo }>;
  readFileData(node: VNode): Promise<Uint8Array>;
}

export interface FileSystemDriver {
  id: SupportedPartitionFs | 'iso';
  name: string;
  description: string;
  mbrPartitionType?: number; // e.g. 0x07 (NTFS/exFAT), 0x0c (FAT32), 0x06 (FAT16), 0x01 (FAT12)
  createBuilder(root: VNode, options: PartitionBuilderOptions): IFileSystemBuilder;
  createParser(reader: RandomAccessReader, partitionStartSector?: number): IFileSystemParser;
  detect(reader: RandomAccessReader, sectorOffset?: number): Promise<boolean>;
}
