// FAT12 / FAT16 / FAT32 & MBR specification types

export const FAT_SECTOR_SIZE = 512;
export const BOOT_SIGNATURE = 0xaa55;

export enum FatType {
  FAT12 = 'fat12',
  FAT16 = 'fat16',
  FAT32 = 'fat32',
}

export enum FatFileAttributes {
  ReadOnly = 0x01,
  Hidden = 0x02,
  System = 0x04,
  VolumeId = 0x08,
  Directory = 0x10,
  Archive = 0x20,
  Lfn = 0x0f, // ReadOnly | Hidden | System | VolumeId
}

export interface BpbInfo {
  bytesPerSector: number;
  sectorsPerCluster: number;
  reservedSectorCount: number;
  fatCount: number;
  rootEntryCount: number;
  totalSectors: number;
  mediaType: number;
  sectorsPerFat: number;
  sectorsPerTrack: number;
  headCount: number;
  hiddenSectors: number;
  // Computed
  fatType: FatType;
  rootDirSectors: number;
  firstDataSector: number;
  dataSectors: number;
  totalClusters: number;
  volumeLabel: string;
  // Partition offset in disk image (0 for unpartitioned/floppy)
  partitionOffsetBytes: number;
}

export interface MbrPartitionEntry {
  status: number; // 0x80 = bootable
  type: number; // 0x01 FAT12, 0x04/0x06/0x0E FAT16, 0x0B/0x0C FAT32
  firstLbaSector: number;
  sectorCount: number;
}

export interface FatDirEntry {
  shortName: string;
  fullName: string;
  attributes: number;
  startCluster: number;
  fileSize: number;
  modifiedTime: Date;
  isDirectory: boolean;
}
