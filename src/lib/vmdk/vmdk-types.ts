// VMware Virtual Machine Disk (VMDK) specification types
// Supports monolithicSparse and monolithicFlat formats compatible with VMware, VirtualBox, and QEMU

export const VMDK_MAGIC = 0x564d444b; // 'KDMV' in little-endian (0x4b, 0x44, 0x4d, 0x56)
export const VMDK_VERSION = 1;
export const VMDK_FLAG_NL_TEST = 3; // Standard newline detector flags
export const VMDK_SECTOR_SIZE = 512;
export const VMDK_DEFAULT_GRAIN_SIZE = 128; // 128 sectors = 64 KB per grain
export const VMDK_GTES_PER_GT = 512; // 512 entries per Grain Table (each GT covers 512 * 64KB = 32 MB)

export interface VmdkHeader {
  magicNumber: number; // 4 bytes
  version: number; // 4 bytes
  flags: number; // 4 bytes
  capacity: number; // 8 bytes (uint64, in sectors)
  grainSize: number; // 8 bytes (uint64, in sectors)
  descriptorOffset: number; // 8 bytes (sector offset)
  descriptorSize: number; // 8 bytes (sector count)
  numGTEsPerGT: number; // 4 bytes
  rgdOffset: number; // 8 bytes (sector offset)
  gdOffset: number; // 8 bytes (sector offset)
  overHead: number; // 8 bytes (sector count)
  uncleanShutdown: number; // 1 byte
  singleEndLineChar: number; // 1 byte ('\n')
  nonEndLineChar: number; // 1 byte (' ')
  doubleEndLineChar1: number; // 1 byte ('\r')
  doubleEndLineChar2: number; // 1 byte ('\n')
  compressAlgorithm: number; // 2 bytes (0 = none)
}

export interface VmdkGeometry {
  cylinders: number;
  heads: number;
  sectors: number;
  capacitySectors: number;
}
