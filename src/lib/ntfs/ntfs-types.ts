// NTFS on-disk structures and specification constants
// Reference: Microsoft NTFS Technical Reference & File System Forensic Analysis

export const NTFS_SECTOR_SIZE = 512;
export const NTFS_OEM_NAME = 'NTFS    ';
export const NTFS_FILE_RECORD_SIZE = 1024;
export const NTFS_INDEX_RECORD_SIZE = 4096;

export const NTFS_FILE_MAGIC = 0x454c4946; // 'FILE' in little-endian
export const NTFS_INDX_MAGIC = 0x58444e49; // 'INDX' in little-endian
export const NTFS_BAAD_MAGIC = 0x44414142; // 'BAAD' in little-endian

// These flags are stored in $FILE_NAME (and the view-index flag is also
// stored in $STANDARD_INFORMATION). They are not the Win32 DIRECTORY bit.
export const NTFS_FILE_ATTR_I30_INDEX_PRESENT = 0x10000000;
export const NTFS_FILE_ATTR_VIEW_INDEX_PRESENT = 0x20000000;

export enum NtfsAttributeType {
  StandardInformation = 0x10,
  AttributeList = 0x20,
  FileName = 0x30,
  ObjectId = 0x40,
  SecurityDescriptor = 0x50,
  VolumeName = 0x60,
  VolumeInformation = 0x70,
  Data = 0x80,
  IndexRoot = 0x90,
  IndexAllocation = 0xa0,
  Bitmap = 0xb0,
  End = 0xffffffff,
}

export enum NtfsFileFlags {
  ReadOnly = 0x0001,
  Hidden = 0x0002,
  System = 0x0004,
  Directory = 0x0010,
  Archive = 0x0020,
  Normal = 0x0080,
  Temporary = 0x0100,
  Sparse = 0x0200,
  Reparse = 0x0400,
  Compressed = 0x0800,
  Offline = 0x1000,
  NotContentIndexed = 0x2000,
  Encrypted = 0x4000,
}

// System file record indexes in $MFT
export enum NtfsSystemFile {
  Mft = 0,
  MftMirr = 1,
  LogFile = 2,
  Volume = 3,
  AttrDef = 4,
  RootDir = 5,
  Bitmap = 6,
  Boot = 7,
  BadClus = 8,
  BadClust = 8, // backwards compatibility alias
  Secure = 9,
  UpCase = 10,
  Extend = 11,
  Quota = 24,
  ObjId = 25,
  Reparse = 26,
  UserFirst = 16,
}

export interface NtfsGeometry {
  totalSectors: number;
  bytesPerSector: number; // 512
  sectorsPerCluster: number; // 8 = 4096 bytes
  clusterSizeBytes: number; // 4096
  logFileClusterCount: number;
  mftCluster: number; // Starting cluster of $MFT
  mftMirrCluster: number; // Starting cluster of $MFTMirr
  mftRecordSize: number; // 1024
  indexRecordSize: number; // 4096
  serialNumber: bigint;
  volumeLabel: string;
}

// Windows FILETIME: 100-nanosecond intervals since January 1, 1601 (UTC)
const FILETIME_EPOCH_DIFF = 116444736000000000n;

export function dateToFileTime(date: Date): bigint {
  const ms = BigInt(date.getTime());
  return ms * 10000n + FILETIME_EPOCH_DIFF;
}

export function fileTimeToDate(fileTime: bigint): Date {
  if (fileTime <= FILETIME_EPOCH_DIFF) return new Date(0);
  const ms = Number((fileTime - FILETIME_EPOCH_DIFF) / 10000n);
  return new Date(ms);
}
