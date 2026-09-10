// Disk image detector and loader
import { ExFatParser } from './exfat/exfat-parser';
import { FatParser } from './fat/fat-parser';
import { IsoParser } from './iso/iso-parser';
import { ISO_SECTOR_SIZE, ISO_STANDARD_ID } from './iso/iso-types';
import { BlobReader, OpfsReader, RandomAccessReader } from './reader';
import { DiskFormat } from './types';
import { VirtualFS } from './virtual-fs/virtual-fs';
import { VmdkParser } from './vmdk/vmdk-parser';
import { VMDK_MAGIC } from './vmdk/vmdk-types';

export class DiskImageLoader {
  /**
   * Automatically detects and loads an ISO, IMG, or VMDK file
   */
  static async load(
    reader: RandomAccessReader,
    fileNameHint: string = ''
  ): Promise<VirtualFS> {
    const format = await this.detectFormat(reader, fileNameHint);

    if (format === 'vmdk-fat32' || format === 'vmdk-exfat') {
      const parser = new VmdkParser(reader);
      const { root, info, virtualReader, fatParser, exfatParser } = await parser.parse();
      return new VirtualFS(root, info.format, info, virtualReader, fatParser, exfatParser);
    }

    if (format === 'exfat') {
      const parser = new ExFatParser(reader);
      const { root, info } = await parser.parse();
      return new VirtualFS(root, 'exfat', info, reader, undefined, parser);
    }

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
    const lowerName = fileNameHint.toLowerCase();

    // 1. Check for VMDK magic 'KDMV' (0x564d444b)
    if (reader.size >= 512) {
      const headerBytes = await reader.read(0, 512);
      const magic =
        (headerBytes[0] |
          (headerBytes[1] << 8) |
          (headerBytes[2] << 16) |
          (headerBytes[3] << 24)) >>>
        0;

      if (magic === VMDK_MAGIC || lowerName.endsWith('.vmdk')) {
        return 'vmdk-fat32';
      }

      // 2. Check for exFAT ("EXFAT   " at offset 3)
      const oemName = String.fromCharCode(...headerBytes.subarray(3, 11));
      if (oemName === 'EXFAT   ') {
        return 'exfat';
      }
    }

    // 3. Check for ISO 9660 signature 'CD001' at sector 16 (0x8000)
    if (reader.size >= 17 * ISO_SECTOR_SIZE) {
      const pvdHeader = await reader.read(16 * ISO_SECTOR_SIZE, 6);
      const sig = String.fromCharCode(...pvdHeader.subarray(1, 6));
      if (sig === ISO_STANDARD_ID) {
        return 'iso';
      }
    }

    // 4. Check extension hints
    if (lowerName.endsWith('.iso')) {
      return 'iso';
    }

    // 5. Check for FAT / MBR boot signature 0x55AA at offset 510
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
