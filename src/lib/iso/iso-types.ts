// ISO 9660 & Joliet specifications and structure definitions

export const ISO_SECTOR_SIZE = 2048;
export const ISO_SYSTEM_AREA_SECTORS = 16; // First 32KB
export const ISO_STANDARD_ID = 'CD001';

export enum VolumeDescriptorType {
  BootRecord = 0,
  PrimaryVolumeDescriptor = 1,
  SupplementaryVolumeDescriptor = 2,
  VolumePartitionDescriptor = 3,
  VolumeDescriptorSetTerminator = 255,
}

export enum IsoFileFlags {
  Hidden = 1 << 0,
  Directory = 1 << 1,
  Associated = 1 << 2,
  Record = 1 << 3,
  Protection = 1 << 4,
  MultiExtent = 1 << 7,
}

export interface IsoDirectoryRecord {
  length: number;
  extendedAttrLength: number;
  extentLba: number;
  dataLength: number;
  recordingDate: Date;
  fileFlags: number;
  fileUnitSize: number;
  interleaveGapSize: number;
  volumeSequenceNumber: number;
  fileIdLength: number;
  fileIdentifier: string;
  isJoliet: boolean;
}

export interface IsoPrimaryVolumeDescriptor {
  type: number;
  standardId: string;
  version: number;
  systemId: string;
  volumeId: string;
  volumeSpaceSize: number; // in sectors
  volumeSetSize: number;
  volumeSeqNumber: number;
  logicalBlockSize: number;
  pathTableSize: number;
  typeLPathTableLba: number;
  typeMPathTableLba: number;
  rootDirRecord: IsoDirectoryRecord;
  volumeSetId: string;
  publisherId: string;
  preparerId: string;
  applicationId: string;
}

export interface ElToritoBootDescriptor {
  bootSystemId: string;
  bootCatalogLba: number;
}
