// High-performance ISO 9660 + Joliet parser
import { RandomAccessReader } from '../reader';
import { DiskImageInfo, VNode } from '../types';
import {
  ISO_SECTOR_SIZE,
  ISO_STANDARD_ID,
  ISO_SYSTEM_AREA_SECTORS,
  IsoDirectoryRecord,
  IsoFileFlags,
  VolumeDescriptorType,
} from './iso-types';

export class IsoParser {
  private reader: RandomAccessReader;
  private isJoliet: boolean = false;
  private jolietLevel: number = 0;
  private volumeLabel: string = 'CDROM';

  getJolietLevel(): number {
    return this.jolietLevel;
  }
  private totalSectors: number = 0;
  private isBootable: boolean = false;
  private bootSystem: string = '';

  constructor(reader: RandomAccessReader) {
    this.reader = reader;
  }

  async parse(): Promise<{ root: VNode; info: DiskImageInfo }> {
    let currentSector = ISO_SYSTEM_AREA_SECTORS;
    let pvdRootRecord: IsoDirectoryRecord | null = null;
    let svdRootRecord: IsoDirectoryRecord | null = null;

    // Scan Volume Descriptors
    while (true) {
      const sectorOffset = currentSector * ISO_SECTOR_SIZE;
      if (sectorOffset + ISO_SECTOR_SIZE > this.reader.size) {
        break;
      }

      const sector = await this.reader.read(sectorOffset, ISO_SECTOR_SIZE);
      const type = sector[0];
      const standardId = String.fromCharCode(...sector.subarray(1, 6));

      if (type === VolumeDescriptorType.BootRecord) {
        const bootSysId = String.fromCharCode(...sector.subarray(7, 39)).trim();
        if (bootSysId.includes('EL TORITO')) {
          this.isBootable = true;
          this.bootSystem = 'El Torito';
        }
      }

      if (standardId !== ISO_STANDARD_ID) {
        break;
      }

      if (type === VolumeDescriptorType.VolumeDescriptorSetTerminator) {
        break;
      }

      if (type === VolumeDescriptorType.PrimaryVolumeDescriptor) {
        this.totalSectors = this.readUint32LE(sector, 80);
        const rawLabel = String.fromCharCode(...sector.subarray(40, 72)).trim();
        if (rawLabel) {
          this.volumeLabel = rawLabel;
        }
        pvdRootRecord = this.parseDirectoryRecord(sector.subarray(156, 190), false);
      } else if (type === VolumeDescriptorType.SupplementaryVolumeDescriptor) {
        // Check for Joliet escape sequences (%/A, %/B, %/C, %/E)
        const esc1 = sector[88];
        const esc2 = sector[89];
        const esc3 = sector[90];
        if (esc1 === 0x25 && esc2 === 0x2f) {
          if (esc3 === 0x40 || esc3 === 0x43 || esc3 === 0x45) {
            this.isJoliet = true;
            this.jolietLevel = esc3 === 0x45 ? 3 : esc3 === 0x43 ? 2 : 1;
            const jolietLabel = this.decodeUcs2BE(sector.subarray(40, 72)).trim();
            if (jolietLabel) {
              this.volumeLabel = jolietLabel;
            }
            svdRootRecord = this.parseDirectoryRecord(sector.subarray(156, 190), true);
          }
        }
      }

      currentSector++;
      if (currentSector > 100) break; // Safeguard
    }

    const effectiveRoot = (this.isJoliet && svdRootRecord) ? svdRootRecord : pvdRootRecord;
    if (!effectiveRoot) {
      throw new Error('Invalid ISO 9660 image: No valid Primary Volume Descriptor found.');
    }

    const rootNode: VNode = {
      id: 'iso-root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: effectiveRoot.recordingDate,
      sourceSector: effectiveRoot.extentLba,
      sourceLength: effectiveRoot.dataLength,
      children: [],
    };

    // Recursively parse directory records
    await this.parseDirectory(effectiveRoot.extentLba, effectiveRoot.dataLength, rootNode, '/');

    // Calculate total size of root
    rootNode.size = this.calculateTreeSize(rootNode);

    const info: DiskImageInfo = {
      format: 'iso',
      formatName: this.isJoliet ? 'ISO 9660 (Joliet Unicode)' : 'ISO 9660',
      volumeLabel: this.volumeLabel,
      totalSize: this.reader.size,
      sectorSize: ISO_SECTOR_SIZE,
      totalSectors: this.totalSectors || Math.floor(this.reader.size / ISO_SECTOR_SIZE),
      hasJoliet: this.isJoliet,
      isBootable: this.isBootable,
      bootSystem: this.bootSystem || undefined,
    };

    return { root: rootNode, info };
  }

  private async parseDirectory(
    dirLba: number,
    dirLength: number,
    parentNode: VNode,
    currentPath: string
  ): Promise<void> {
    const buffer = await this.reader.read(dirLba * ISO_SECTOR_SIZE, dirLength);
    let offset = 0;

    while (offset < buffer.length) {
      const recordLength = buffer[offset];

      // End of sector directory records padding
      if (recordLength === 0) {
        // Advance to next sector boundary
        const nextSectorOffset = Math.ceil((offset + 1) / ISO_SECTOR_SIZE) * ISO_SECTOR_SIZE;
        if (nextSectorOffset >= buffer.length || nextSectorOffset === offset) {
          break;
        }
        offset = nextSectorOffset;
        continue;
      }

      if (offset + recordLength > buffer.length) {
        break;
      }

      const recordBytes = buffer.subarray(offset, offset + recordLength);
      const record = this.parseDirectoryRecord(recordBytes, this.isJoliet);
      offset += recordLength;

      // Skip '.' and '..'
      if (record.fileIdentifier === '.' || record.fileIdentifier === '..') {
        continue;
      }

      const isDir = (record.fileFlags & IsoFileFlags.Directory) !== 0;
      const cleanName = record.fileIdentifier;
      const nodePath = currentPath === '/' ? `/${cleanName}` : `${currentPath}/${cleanName}`;

      const node: VNode = {
        id: `iso-${record.extentLba}-${record.dataLength}-${cleanName}`,
        name: cleanName,
        path: nodePath,
        isDirectory: isDir,
        size: isDir ? 0 : record.dataLength,
        modifiedTime: record.recordingDate,
        sourceSector: record.extentLba,
        sourceLength: record.dataLength,
        flags: record.fileFlags,
        children: isDir ? [] : undefined,
      };

      parentNode.children!.push(node);

      if (isDir && record.extentLba > 0 && record.dataLength > 0) {
        // Prevent infinite loops (e.g. if extent points to itself)
        if (record.extentLba !== dirLba) {
          await this.parseDirectory(record.extentLba, record.dataLength, node, nodePath);
        }
      }
    }
  }

  private parseDirectoryRecord(record: Uint8Array, isJoliet: boolean): IsoDirectoryRecord {
    const length = record[0];
    const extendedAttrLength = record[1];
    const extentLba = this.readUint32LE(record, 2);
    const dataLength = this.readUint32LE(record, 10);
    const recordingDate = this.parseIsoDate(record.subarray(18, 25));
    const fileFlags = record[25];
    const fileUnitSize = record[26];
    const interleaveGapSize = record[27];
    const volumeSequenceNumber = this.readUint16LE(record, 28);
    const fileIdLength = record[32];

    const rawFileId = record.subarray(33, 33 + fileIdLength);
    let fileIdentifier = '';

    if (fileIdLength === 1 && rawFileId[0] === 0x00) {
      fileIdentifier = '.';
    } else if (fileIdLength === 1 && rawFileId[0] === 0x01) {
      fileIdentifier = '..';
    } else if (isJoliet) {
      fileIdentifier = this.decodeUcs2BE(rawFileId);
      // Remove ";1" version if Joliet appended it
      fileIdentifier = fileIdentifier.replace(/;\d+$/, '');
    } else {
      fileIdentifier = String.fromCharCode(...rawFileId);
      // Remove ";1" version suffix
      fileIdentifier = fileIdentifier.replace(/;\d+$/, '');
    }

    return {
      length,
      extendedAttrLength,
      extentLba,
      dataLength,
      recordingDate,
      fileFlags,
      fileUnitSize,
      interleaveGapSize,
      volumeSequenceNumber,
      fileIdLength,
      fileIdentifier,
      isJoliet,
    };
  }

  private parseIsoDate(bytes: Uint8Array): Date {
    if (bytes.length < 7) return new Date();
    const year = 1900 + bytes[0];
    const month = Math.max(0, bytes[1] - 1);
    const day = Math.max(1, bytes[2]);
    const hour = bytes[3];
    const minute = bytes[4];
    const second = bytes[5];
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  private decodeUcs2BE(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length - 1; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      if (code === 0) break;
      result += String.fromCharCode(code);
    }
    return result;
  }

  private readUint16LE(buf: Uint8Array, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8);
  }

  private readUint32LE(buf: Uint8Array, offset: number): number {
    return (
      (buf[offset] |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 24)) >>>
      0
    );
  }

  private calculateTreeSize(node: VNode): number {
    if (!node.isDirectory) return node.size;
    let sum = 0;
    if (node.children) {
      for (const child of node.children) {
        sum += this.calculateTreeSize(child);
      }
    }
    return sum;
  }
}
