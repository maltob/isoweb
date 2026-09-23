// Random-access NTFS parser for disk inspection and file extraction
// Reference: Microsoft NTFS Technical Reference & File System Forensic Analysis
import { RandomAccessReader } from '../reader';
import { DiskImageInfo, VNode } from '../types';
import { IFileSystemParser } from '../filesystem/fs-types';
import {
  fileTimeToDate,
  NTFS_FILE_MAGIC,
  NTFS_OEM_NAME,
  NtfsAttributeType,
  NtfsFileFlags,
  NtfsSystemFile,
  NTFS_FILE_ATTR_I30_INDEX_PRESENT,
} from './ntfs-types';

interface DataRun {
  lcn: number;
  clusterCount: number;
}

interface ParsedFileAttributes {
  standardInfo?: {
    mtime: Date;
    flags: number;
  };
  fileName?: {
    name: string;
    parentRecord: number;
    flags: number;
    allocatedSize: number;
    realSize: number;
  };
  volumeName?: string;
  dataResident?: Uint8Array;
  dataRuns?: DataRun[];
  dataSize?: number;
  indexAllocationRuns?: DataRun[];
  indexEntries?: {
    fileRef: number;
    name: string;
    isDir: boolean;
    size: number;
    mtime: Date;
  }[];
}

export class NtfsParser implements IFileSystemParser {
  private reader: RandomAccessReader;
  private partitionSectorOffset: number;

  private bytesPerSector: number = 512;
  private sectorsPerCluster: number = 8;
  private clusterSizeBytes: number = 4096;
  private totalSectors: number = 0;
  private mftStartCluster: number = 4;
  private mftRecordSize: number = 1024;
  private volumeLabel: string = 'NTFS_DISK';

  // Map to store non-resident data runs for lazy streaming of files
  private nodeDataMap = new Map<string, { resident?: Uint8Array; dataRuns?: DataRun[]; size: number }>();

  constructor(reader: RandomAccessReader, partitionSectorOffset: number = 0) {
    this.reader = reader;
    this.partitionSectorOffset = partitionSectorOffset;
  }

  async parse(): Promise<{ root: VNode; info: DiskImageInfo }> {
    // 1. Read and validate VBR (Sector 0)
    const vbrBytes = await this.reader.read(this.partitionSectorOffset * 512, 512);
    if (vbrBytes.length < 512) {
      throw new Error('Invalid NTFS image: unable to read boot sector.');
    }

    const oemName = String.fromCharCode(...vbrBytes.subarray(3, 11));
    const sig = vbrBytes[510] | (vbrBytes[511] << 8);
    if (oemName !== NTFS_OEM_NAME || sig !== 0xaa55) {
      throw new Error(`Not an NTFS filesystem (OEM: "${oemName}", signature: 0x${sig.toString(16)})`);
    }

    this.bytesPerSector = this.readUint16LE(vbrBytes, 11) || 512;
    this.sectorsPerCluster = vbrBytes[13] || 8;
    this.clusterSizeBytes = this.bytesPerSector * this.sectorsPerCluster;
    this.totalSectors = this.readUint64LE(vbrBytes, 40);
    this.mftStartCluster = this.readUint64LE(vbrBytes, 48);

    const mftClustersByte = vbrBytes[64];
    if (mftClustersByte >= 0x80) {
      // Negative value: size = 2^|val|
      const shift = 256 - mftClustersByte;
      this.mftRecordSize = 1 << shift;
    } else {
      this.mftRecordSize = mftClustersByte * this.clusterSizeBytes;
    }

    // 2. Read Record 3 ($Volume) to get volume label
    try {
      const volRecord = await this.readMftRecord(NtfsSystemFile.Volume);
      if (volRecord) {
        const attrs = this.parseRecordAttributes(volRecord);
        if (attrs.volumeName) {
          this.volumeLabel = attrs.volumeName;
        }
      }
    } catch {
      // fallback to default label
    }

    // 3. Parse Root Directory (Record 5)
    const root: VNode = {
      id: 'ntfs-root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      children: [],
    };

    await this.parseDirectory(NtfsSystemFile.RootDir, root, '/');

    const info: DiskImageInfo = {
      format: 'ntfs',
      formatName: 'NTFS (New Technology File System)',
      volumeLabel: this.volumeLabel,
      totalSize: this.totalSectors * this.bytesPerSector,
      sectorSize: this.bytesPerSector,
      totalSectors: this.totalSectors,
      clusterSize: this.clusterSizeBytes,
    };

    return { root, info };
  }

  private async parseDirectory(recordNum: number, parentNode: VNode, currentPath: string): Promise<void> {
    const recordBytes = await this.readMftRecord(recordNum);
    if (!recordBytes) return;

    const attrs = this.parseRecordAttributes(recordBytes);
    if (attrs.standardInfo) {
      parentNode.modifiedTime = attrs.standardInfo.mtime;
    }

    // If directory has large index ($INDEX_ALLOCATION), read and parse INDX blocks
    if (attrs.indexAllocationRuns && attrs.indexAllocationRuns.length > 0) {
      if (!attrs.indexEntries) attrs.indexEntries = [];
      for (const run of attrs.indexAllocationRuns) {
        for (let cl = 0; cl < run.clusterCount; cl++) {
          const lcn = run.lcn + cl;
          const clusterByteOffset =
            (this.partitionSectorOffset + lcn * this.sectorsPerCluster) * this.bytesPerSector;
          const indxBuf = await this.reader.read(clusterByteOffset, this.clusterSizeBytes);
          if (indxBuf.length >= 4096 && this.readUint32LE(indxBuf, 0) === 0x58444e49) {
            // Revert USA fixups across 8 sectors
            const usaOffset = this.readUint16LE(indxBuf, 4);
            const usaCount = this.readUint16LE(indxBuf, 6);
            if (usaOffset + usaCount * 2 <= indxBuf.length) {
              for (let s = 0; s < usaCount - 1 && s < 8; s++) {
                const secOffset = (s + 1) * 512 - 2;
                const fixup = this.readUint16LE(indxBuf, usaOffset + 2 + s * 2);
                indxBuf[secOffset] = fixup & 0xff;
                indxBuf[secOffset + 1] = (fixup >> 8) & 0xff;
              }
            }

            const entriesOffset = this.readUint32LE(indxBuf, 24 + 0);
            const totalIndexLen = this.readUint32LE(indxBuf, 24 + 4);
            const entriesStart = 24 + entriesOffset;
            const entriesEnd = Math.min(indxBuf.length, 24 + totalIndexLen);
            const parsed = this.parseIndexEntriesFromBuffer(indxBuf, entriesStart, entriesEnd);
            attrs.indexEntries.push(...parsed);
          }
        }
      }
    }

    for (const entry of attrs.indexEntries || []) {
      // Ignore '.' and system files with record < 16 (unless user file)
      if (entry.name === '.' || entry.name === '$I30' || entry.fileRef < NtfsSystemFile.UserFirst) {
        continue;
      }

      const nodePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      const childNode: VNode = {
        id: `ntfs-${entry.fileRef}-${entry.name}`,
        name: entry.name,
        path: nodePath,
        isDirectory: entry.isDir,
        size: entry.isDir ? 0 : entry.size,
        modifiedTime: entry.mtime,
        children: entry.isDir ? [] : undefined,
      };
      parentNode.children!.push(childNode);

      // Read child record to register file data or traverse subdirectory
      const childRecordBytes = await this.readMftRecord(entry.fileRef);
      if (childRecordBytes) {
        const recordFlags = this.readUint16LE(childRecordBytes, 22);
        const isDir = entry.isDir || (recordFlags & 0x02) !== 0;
        childNode.isDirectory = isDir;
        if (isDir && !childNode.children) {
          childNode.children = [];
          childNode.size = 0;
        }

        const childAttrs = this.parseRecordAttributes(childRecordBytes);
        if (childAttrs.standardInfo) {
          childNode.modifiedTime = childAttrs.standardInfo.mtime;
        }

        if (isDir) {
          await this.parseDirectory(entry.fileRef, childNode, nodePath);
        } else {
          // Register data mapping for file extraction
          this.nodeDataMap.set(childNode.id, {
            resident: childAttrs.dataResident,
            dataRuns: childAttrs.dataRuns,
            size: childAttrs.dataSize ?? entry.size,
          });
          if (childAttrs.dataResident) {
            childNode.data = childAttrs.dataResident;
          }
        }
      }
    }
  }

  private async readMftRecord(recordNum: number): Promise<Uint8Array | null> {
    const mftByteOffset =
      (this.partitionSectorOffset + this.mftStartCluster * this.sectorsPerCluster) * this.bytesPerSector +
      recordNum * this.mftRecordSize;

    if (mftByteOffset + this.mftRecordSize > this.reader.size) {
      return null;
    }

    const record = await this.reader.read(mftByteOffset, this.mftRecordSize);
    if (record.length < this.mftRecordSize) return null;

    // Check 'FILE' magic
    const magic = this.readUint32LE(record, 0);
    if (magic !== NTFS_FILE_MAGIC) {
      return null;
    }

    // Revert Update Sequence Array (USA) Fixups
    const usaOffset = this.readUint16LE(record, 4);
    const usaCount = this.readUint16LE(record, 6);
    if (usaOffset + usaCount * 2 <= record.length) {
      // Fixup Sector 0 (bytes 510..511)
      if (usaCount >= 2) {
        const fixup0 = this.readUint16LE(record, usaOffset + 2);
        record[510] = fixup0 & 0xff;
        record[511] = (fixup0 >> 8) & 0xff;
      }

      // Fixup Sector 1 (bytes 1022..1023)
      if (usaCount >= 3 && record.length >= 1024) {
        const fixup1 = this.readUint16LE(record, usaOffset + 4);
        record[1022] = fixup1 & 0xff;
        record[1023] = (fixup1 >> 8) & 0xff;
      }
    }

    return record;
  }

  private parseRecordAttributes(record: Uint8Array): ParsedFileAttributes {
    const result: ParsedFileAttributes = {};
    let offset = this.readUint16LE(record, 20); // first attribute offset

    while (offset + 8 <= record.length) {
      const attrType = this.readUint32LE(record, offset);
      if (attrType === NtfsAttributeType.End) break;

      const attrLen = this.readUint32LE(record, offset + 4);
      if (attrLen === 0 || offset + attrLen > record.length) break;

      const nonResident = record[offset + 8] === 1;

      if (attrType === NtfsAttributeType.StandardInformation && !nonResident) {
        const valOffset = this.readUint16LE(record, offset + 20);
        if (offset + valOffset + 40 <= record.length) {
          const mtimeFt = this.readBigUint64LE(record, offset + valOffset + 8);
          const flags = this.readUint32LE(record, offset + valOffset + 32);
          result.standardInfo = {
            mtime: fileTimeToDate(mtimeFt),
            flags,
          };
        }
      } else if (attrType === NtfsAttributeType.FileName && !nonResident) {
        const valOffset = this.readUint16LE(record, offset + 20);
        if (offset + valOffset + 66 <= record.length) {
          const parentRef = this.readBigUint64LE(record, offset + valOffset);
          const parentRec = Number(parentRef & 0xffffffffffffn);
          const allocSize = this.readUint64LE(record, offset + valOffset + 40);
          const realSize = this.readUint64LE(record, offset + valOffset + 48);
          const flags = this.readUint32LE(record, offset + valOffset + 56);
          const nameChars = record[offset + valOffset + 64];

          let name = '';
          const nameStart = offset + valOffset + 66;
          for (let c = 0; c < nameChars; c++) {
            const code = this.readUint16LE(record, nameStart + c * 2);
            name += String.fromCharCode(code);
          }

          result.fileName = {
            name,
            parentRecord: parentRec,
            flags,
            allocatedSize: allocSize,
            realSize,
          };
        }
      } else if (attrType === NtfsAttributeType.VolumeName && !nonResident) {
        const valOffset = this.readUint16LE(record, offset + 20);
        const valLen = this.readUint32LE(record, offset + 16);
        let name = '';
        const nameStart = offset + valOffset;
        for (let i = 0; i < valLen; i += 2) {
          name += String.fromCharCode(this.readUint16LE(record, nameStart + i));
        }
        result.volumeName = name;
      } else if (attrType === NtfsAttributeType.Data) {
        if (!nonResident) {
          // Resident data
          const valOffset = this.readUint16LE(record, offset + 20);
          const valLen = this.readUint32LE(record, offset + 16);
          result.dataResident = record.slice(offset + valOffset, offset + valOffset + valLen);
          result.dataSize = valLen;
        } else {
          // Non-resident data runs
          const runOffset = this.readUint16LE(record, offset + 32);
          const realSize = this.readUint64LE(record, offset + 48);
          result.dataSize = realSize;
          result.dataRuns = this.parseDataRuns(record.subarray(offset + runOffset));
        }
      } else if (attrType === NtfsAttributeType.IndexAllocation && nonResident) {
        const runOffset = this.readUint16LE(record, offset + 32);
        result.indexAllocationRuns = this.parseDataRuns(record.subarray(offset + runOffset));
      } else if (attrType === NtfsAttributeType.IndexRoot && !nonResident) {
        // $INDEX_ROOT: Parse resident entries if present
        const valOffset = this.readUint16LE(record, offset + 20);
        const valStart = offset + valOffset;
        if (valStart + 32 <= record.length) {
          const firstEntryOffset = this.readUint32LE(record, valStart + 16);
          const totalEntriesLen = this.readUint32LE(record, valStart + 20);
          const entriesStart = valStart + 16 + firstEntryOffset;
          const entriesEnd = Math.min(record.length, valStart + 16 + totalEntriesLen);
          result.indexEntries = this.parseIndexEntriesFromBuffer(record, entriesStart, entriesEnd);
        }
      }

      offset += attrLen;
    }

    return result;
  }

  private parseIndexEntriesFromBuffer(
    buffer: Uint8Array,
    startOffset: number,
    endOffset: number
  ): { fileRef: number; name: string; isDir: boolean; size: number; mtime: Date }[] {
    const entries: { fileRef: number; name: string; isDir: boolean; size: number; mtime: Date }[] = [];
    let entryPos = startOffset;

    while (entryPos + 16 <= endOffset) {
      const fileRef = this.readBigUint64LE(buffer, entryPos);
      const entryLen = this.readUint16LE(buffer, entryPos + 8);
      const fnLen = this.readUint16LE(buffer, entryPos + 10);
      const flags = this.readUint16LE(buffer, entryPos + 12);

      if (entryLen === 0) break;
      if ((flags & 0x02) !== 0) break; // End of node marker

      const recordNumber = Number(fileRef & 0xffffffffffffn);
      if (entryPos + 16 + 66 <= buffer.length && fnLen >= 66) {
        const fnStart = entryPos + 16;
        const realSize = this.readUint64LE(buffer, fnStart + 48);
        const fnFlags = this.readUint32LE(buffer, fnStart + 56);
        const nameChars = buffer[fnStart + 64];

        let entryName = '';
        for (let c = 0; c < nameChars; c++) {
          const code = this.readUint16LE(buffer, fnStart + 66 + c * 2);
          entryName += String.fromCharCode(code);
        }

        const mtimeFt = this.readBigUint64LE(buffer, fnStart + 8);
        entries.push({
          fileRef: recordNumber,
          name: entryName,
          isDir: (fnFlags & (NtfsFileFlags.Directory | NTFS_FILE_ATTR_I30_INDEX_PRESENT)) !== 0,
          size: realSize,
          mtime: fileTimeToDate(mtimeFt),
        });
      }

      entryPos += entryLen;
    }

    return entries;
  }

  private parseDataRuns(runBytes: Uint8Array): DataRun[] {
    const runs: DataRun[] = [];
    let pos = 0;
    let currentLcn = 0;

    while (pos < runBytes.length) {
      const header = runBytes[pos++];
      if (header === 0) break; // End of run list

      const countLen = header & 0x0f;
      const lcnLen = (header >> 4) & 0x0f;

      if (pos + countLen + lcnLen > runBytes.length) break;

      // Read cluster count (unsigned)
      let count = 0;
      for (let i = 0; i < countLen; i++) {
        count |= runBytes[pos++] << (i * 8);
      }

      // Read LCN delta (signed)
      let lcnDelta = 0;
      for (let i = 0; i < lcnLen; i++) {
        lcnDelta |= runBytes[pos++] << (i * 8);
      }
      // Sign extend
      if (lcnLen > 0 && (runBytes[pos - 1] & 0x80) !== 0) {
        for (let i = lcnLen; i < 4; i++) {
          lcnDelta |= 0xff << (i * 8);
        }
      }

      currentLcn += lcnDelta;
      runs.push({
        lcn: currentLcn,
        clusterCount: count,
      });
    }

    return runs;
  }

  async readFileData(node: VNode): Promise<Uint8Array> {
    if (node.isDirectory) {
      return new Uint8Array(0);
    }

    if (node.data) {
      return node.data;
    }

    const mapping = this.nodeDataMap.get(node.id);
    if (!mapping) {
      return new Uint8Array(0);
    }

    if (mapping.resident) {
      return mapping.resident;
    }

    if (!mapping.dataRuns || mapping.dataRuns.length === 0 || mapping.size === 0) {
      return new Uint8Array(0);
    }

    // Read non-resident data across cluster runs
    const result = new Uint8Array(mapping.size);
    let bytesRead = 0;

    for (const run of mapping.dataRuns) {
      if (bytesRead >= mapping.size) break;
      const runByteOffset =
        (this.partitionSectorOffset + run.lcn * this.sectorsPerCluster) * this.bytesPerSector;
      const runBytesTotal = run.clusterCount * this.clusterSizeBytes;
      const toRead = Math.min(runBytesTotal, mapping.size - bytesRead);

      const chunk = await this.reader.read(runByteOffset, toRead);
      result.set(chunk, bytesRead);
      bytesRead += chunk.byteLength;
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

  private readUint64LE(buf: Uint8Array, offset: number): number {
    const low = this.readUint32LE(buf, offset);
    const high = this.readUint32LE(buf, offset + 4);
    return high * 0x100000000 + low;
  }

  private readBigUint64LE(buf: Uint8Array, offset: number): bigint {
    const low = BigInt(this.readUint32LE(buf, offset));
    const high = BigInt(this.readUint32LE(buf, offset + 4));
    return (high << 32n) | low;
  }
}
