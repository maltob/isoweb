// Disk image detector and loader
import { FatParser } from './fat/fat-parser';
import { IsoParser } from './iso/iso-parser';
import { ISO_SECTOR_SIZE, ISO_STANDARD_ID } from './iso/iso-types';
import { BlobReader, OpfsReader, RandomAccessReader } from './reader';
import { DiskFormat } from './types';
import { VirtualFS } from './virtual-fs/virtual-fs';

export class DiskImageLoader {
  /**
   * Automatically detects and loads an ISO or IMG file
   */
  static async load(
    reader: RandomAccessReader,
    fileNameHint: string = ''
  ): Promise<VirtualFS> {
    const format = await this.detectFormat(reader, fileNameHint);

    if (format === 'iso') {
      const parser = new IsoParser(reader);
      const { root, info } = await parser.parse();
      return new VirtualFS(root, 'iso', info, reader);
    } else {
      const parser = new FatParser(reader);
      const { root, info } = await parser.parse();
      return new VirtualFS(root, info.format, info, reader, parser);
    }
  }

  static async loadFromFile(file: File): Promise<VirtualFS> {
    const reader = new BlobReader(file);
    return await this.load(reader, file.name);
  }

  static async loadFromOpfs(fileHandle: FileSystemFileHandle): Promise<VirtualFS> {
    const reader = await OpfsReader.create(fileHandle);
    const file = await fileHandle.getFile();
    return await this.load(reader, file.name);
  }

  private static async detectFormat(
    reader: RandomAccessReader,
    fileNameHint: string
  ): Promise<DiskFormat> {
    // 1. Check for ISO 9660 signature 'CD001' at sector 16 (0x8000)
    if (reader.size >= 17 * ISO_SECTOR_SIZE) {
      const pvdHeader = await reader.read(16 * ISO_SECTOR_SIZE, 6);
      const sig = String.fromCharCode(...pvdHeader.subarray(1, 6));
      if (sig === ISO_STANDARD_ID) {
        return 'iso';
      }
    }

    // 2. Check extension hint
    const lowerName = fileNameHint.toLowerCase();
    if (lowerName.endsWith('.iso')) {
      return 'iso';
    }

    // 3. Check for FAT / MBR boot signature 0x55AA at offset 510
    if (reader.size >= 512) {
      const sector0 = await reader.read(0, 512);
      if (sector0[510] === 0x55 && sector0[511] === 0xaa) {
        // Distinguish FAT12/16/32 if possible
        const rootEntryCount = sector0[17] | (sector0[18] << 8);
        const sectorsPerFat = sector0[22] | (sector0[23] << 8);
        if (sectorsPerFat === 0) {
          return 'fat32';
        }
        if (rootEntryCount === 224 && reader.size <= 2880 * 512) {
          return 'fat12';
        }
        return 'fat16';
      }
    }

    // Default fallback
    if (lowerName.endsWith('.iso')) return 'iso';
    return 'fat12';
  }
}
