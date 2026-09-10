// exFAT specification constants, boot sector layout, and directory entry structures
// Reference: Microsoft exFAT File System Specification

export const EXFAT_SECTOR_SIZE = 512;
export const EXFAT_OEM_NAME = 'EXFAT   ';
export const EXFAT_BOOT_SIGNATURE = 0xaa55;

export const EXFAT_MAIN_BOOT_SECTORS = 12;
export const EXFAT_BACKUP_BOOT_SECTORS = 12;
export const EXFAT_TOTAL_BOOT_SECTORS = 24;

// Directory Entry Type Codes
export enum ExFatEntryType {
  EndOfDirectory = 0x00,
  AllocationBitmap = 0x81,
  UpcaseTable = 0x82,
  VolumeLabel = 0x83,
  File = 0x85,
  StreamExtension = 0xc0,
  FileName = 0xc1,
}

// File Attributes (same as FAT)
export enum ExFatFileAttributes {
  ReadOnly = 0x01,
  Hidden = 0x02,
  System = 0x04,
  Directory = 0x10,
  Archive = 0x20,
}

export interface ExFatGeometry {
  totalSectors: number;
  bytesPerSectorShift: number; // 9 = 512 bytes
  bytesPerSector: number; // 512
  sectorsPerClusterShift: number; // e.g. 3 = 8 sectors (4KB clusters)
  sectorsPerCluster: number; // 8
  clusterSizeBytes: number; // 4096
  fatOffset: number; // sector offset where FAT starts
  fatLength: number; // sectors in FAT
  clusterHeapOffset: number; // sector offset where Cluster 2 starts (1MB aligned = 2048)
  clusterCount: number; // total clusters in heap
  rootDirCluster: number; // typically 4
  volumeLabel: string;
}
