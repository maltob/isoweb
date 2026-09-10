// Core types for VM Disk Image builder and explorer

export type DiskFormat = 'iso' | 'fat12' | 'fat16' | 'fat32';

export interface FileMetadata {
  name: string;
  path: string; // e.g. "/EFI/BOOT/BOOTX64.EFI"
  size: number;
  isDirectory: boolean;
  modifiedTime: Date;
  lbaSector?: number; // Starting sector (ISO LBA or FAT sector)
  startCluster?: number; // FAT cluster
  flags?: number; // Attributes (hidden, read-only, directory, etc.)
  shortName?: string; // 8.3 short name if applicable
}

export interface VNode {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedTime: Date;
  children?: VNode[];
  data?: Uint8Array; // In-memory content for small edits
  fileRef?: File; // Lazy File reference from local disk (zero RAM usage!)
  // For files loaded from existing disk images (lazy chunked reading):
  sourceSector?: number;
  sourceLength?: number;
  startCluster?: number;
  // Attributes
  shortName?: string;
  flags?: number;
}

export interface DiskImageInfo {
  format: DiskFormat;
  formatName: string;
  volumeLabel: string;
  totalSize: number; // in bytes
  sectorSize: number; // usually 2048 for ISO, 512 for FAT
  totalSectors: number;
  usedSectors?: number;
  freeSectors?: number;
  clusterSize?: number; // for FAT
  hasJoliet?: boolean;
  hasRockRidge?: boolean;
  isBootable?: boolean;
  bootSystem?: string;
  hasMbr?: boolean;
  partitionType?: string;
  createdTime?: Date;
}

export interface SavedOpfsImage {
  name: string;
  size: number;
  format: DiskFormat;
  volumeLabel: string;
  lastModified: number;
}
