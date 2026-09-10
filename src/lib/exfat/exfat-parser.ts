// exFAT volume parser for random-access inspection and file extraction
import { RandomAccessReader } from '../reader';
import { DiskImageInfo, VNode } from '../types';
import {
  EXFAT_BOOT_SIGNATURE,
  EXFAT_OEM_NAME,
  ExFatEntryType,
  ExFatFileAttributes,
} from './exfat-types';

export class ExFatParser {
  private reader: RandomAccessReader;
  private partitionSectorOffset: number;

  private bytesPerSector: number = 512;
  private sectorsPerCluster: number = 8;
  private clusterSizeBytes: number = 4096;
  private clusterHeapSector: number = 2048;
  private rootDirCluster: number = 4;
  private volumeLengthSectors: number = 0;
  private volumeLabel: string = '';

  constructor(reader: RandomAccessReader, partitionSectorOffset: number = 0) {
    this.reader = reader;
    this.partitionSectorOffset = partitionSectorOffset;
  }

  async parse(): Promise<{ root: VNode; info: DiskImageInfo }> {
    const bootBytes = await this.reader.read(this.partitionSectorOffset * 512, 512);
    if (bootBytes.length < 512) {
      throw new Error('Invalid exFAT image: unable to read boot sector.');
    }

    const oemName = String.fromCharCode(...bootBytes.subarray(3, 11));
    const sig = bootBytes[510] | (bootBytes[511] << 8);
    if (oemName !== EXFAT_OEM_NAME || sig !== EXFAT_BOOT_SIGNATURE) {
      throw new Error(`Not an exFAT filesystem (OEM: "${oemName}", signature: 0x${sig.toString(16)})`);
    }

    const bytesPerSectorShift = bootBytes[108];
    const sectorsPerClusterShift = bootBytes[109];
    this.bytesPerSector = 1 << bytesPerSectorShift;
    this.sectorsPerCluster = 1 << sectorsPerClusterShift;
    this.clusterSizeBytes = this.bytesPerSector * this.sectorsPerCluster;

    this.clusterHeapSector = this.readUint32LE(bootBytes, 88);
    this.rootDirCluster = this.readUint32LE(bootBytes, 96);
    this.volumeLengthSectors = this.readUint32LE(bootBytes, 72);

    const root: VNode = {
      id: 'exfat-root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      startCluster: this.rootDirCluster,
      children: [],
    };

    // Parse root directory
    await this.parseDirectory(this.rootDirCluster, root, '/');

    const info: DiskImageInfo = {
      format: 'exfat',
      formatName: 'exFAT (Extensible File Allocation Table)',
      volumeLabel: this.volumeLabel || 'EXFAT_DISK',
      totalSize: this.volumeLengthSectors * this.bytesPerSector,
      sectorSize: this.bytesPerSector,
      totalSectors: this.volumeLengthSectors,
      clusterSize: this.clusterSizeBytes,
    };

    return { root, info };
  }

  private clusterToByteOffset(cluster: number): number {
    const heapSector = this.partitionSectorOffset + this.clusterHeapSector;
    const clusterSector = heapSector + (cluster - 2) * this.sectorsPerCluster;
    return clusterSector * this.bytesPerSector;
  }

  private async parseDirectory(cluster: number, parentNode: VNode, currentPath: string): Promise<void> {
    const dirOffset = this.clusterToByteOffset(cluster);
    const dirBytes = await this.reader.read(dirOffset, this.clusterSizeBytes);

    let offset = 0;
    while (offset + 32 <= dirBytes.length) {
      const entryType = dirBytes[offset];
      if (entryType === ExFatEntryType.EndOfDirectory) {
        break; // End of directory marker
      }

      if (entryType === ExFatEntryType.VolumeLabel) {
        const charCount = dirBytes[offset + 1];
        let label = '';
        for (let i = 0; i < charCount; i++) {
          const code = this.readUint16LE(dirBytes, offset + 2 + i * 2);
          label += String.fromCharCode(code);
        }
        this.volumeLabel = label;
        offset += 32;
        continue;
      }

      if (entryType === ExFatEntryType.File) {
        const secondaryCount = dirBytes[offset + 1];
        const attr = this.readUint16LE(dirBytes, offset + 4);
        const isDir = (attr & ExFatFileAttributes.Directory) !== 0;

        // Next entry: Stream Extension (0xC0)
        let firstCluster = 0;
        let dataLength = 0;
        let fileName = '';

        if (secondaryCount >= 2 && offset + 64 <= dirBytes.length) {
          const streamOffset = offset + 32;
          if (dirBytes[streamOffset] === ExFatEntryType.StreamExtension) {
            const nameLength = dirBytes[streamOffset + 3];
            firstCluster = this.readUint32LE(dirBytes, streamOffset + 20);
            dataLength = this.readUint32LE(dirBytes, streamOffset + 24);

            // Remaining entries: File Name (0xC1)
            const nameEntryCount = secondaryCount - 1;
            for (let e = 0; e < nameEntryCount; e++) {
              const nameEntryOffset = streamOffset + 32 + e * 32;
              if (nameEntryOffset + 32 <= dirBytes.length && dirBytes[nameEntryOffset] === ExFatEntryType.FileName) {
                for (let c = 0; c < 15; c++) {
                  if (fileName.length < nameLength) {
                    const code = this.readUint16LE(dirBytes, nameEntryOffset + 2 + c * 2);
                    if (code !== 0) fileName += String.fromCharCode(code);
                  }
                }
              }
            }
          }
        }

        if (fileName) {
          const nodePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
          const childNode: VNode = {
            id: `exfat-${firstCluster}-${dataLength}-${fileName}`,
            name: fileName,
            path: nodePath,
            isDirectory: isDir,
            size: isDir ? 0 : dataLength,
            modifiedTime: new Date(),
            startCluster: firstCluster,
            sourceSector: Math.floor(this.clusterToByteOffset(firstCluster) / this.bytesPerSector),
            sourceLength: dataLength,
            children: isDir ? [] : undefined,
          };
          parentNode.children!.push(childNode);

          if (isDir && firstCluster >= 4 && firstCluster !== cluster) {
            await this.parseDirectory(firstCluster, childNode, nodePath);
          }
        }

        offset += (1 + secondaryCount) * 32;
        continue;
      }

      offset += 32;
    }
  }

  async readFileData(node: VNode): Promise<Uint8Array> {
    if (node.isDirectory || !node.startCluster || !node.size) {
      return new Uint8Array(0);
    }
    const byteOffset = this.clusterToByteOffset(node.startCluster);
    return await this.reader.read(byteOffset, node.size);
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
}
