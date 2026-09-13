// Virtual Filesystem & State Controller for active disk image
import { ExFatBuilder } from '../exfat/exfat-builder';
import { ExFatParser } from '../exfat/exfat-parser';
import { FatBuilder } from '../fat/fat-builder';
import { FatParser } from '../fat/fat-parser';
import { FatType } from '../fat/fat-types';
import { IsoBuilder } from '../iso/iso-builder';
import { ISO_SECTOR_SIZE } from '../iso/iso-types';
import { RandomAccessReader } from '../reader';
import { OpfsManager } from '../storage/opfs';
import { BlobAccumulatorWriter, FileSystemAccessStreamWriter, ImageStreamWriter } from '../storage/stream-writer';
import { DiskFormat, DiskImageInfo, ImageExportOptions, VNode } from '../types';
import { VmdkBuilder } from '../vmdk/vmdk-builder';
import { VhdxBuilder } from '../vhdx/vhdx-builder';
import { ZipArchiver } from './zip-export';

export class VirtualFS {
  private root: VNode;
  private format: DiskFormat;
  private imageInfo: DiskImageInfo;
  private sourceReader?: RandomAccessReader;
  private sourceFatParser?: FatParser;
  private sourceExFatParser?: ExFatParser;

  constructor(
    root: VNode,
    format: DiskFormat,
    imageInfo: DiskImageInfo,
    sourceReader?: RandomAccessReader,
    sourceFatParser?: FatParser,
    sourceExFatParser?: ExFatParser
  ) {
    this.root = root;
    this.format = format;
    this.imageInfo = imageInfo;
    this.sourceReader = sourceReader;
    this.sourceFatParser = sourceFatParser;
    this.sourceExFatParser = sourceExFatParser;
  }

  getRoot(): VNode {
    return this.root;
  }

  getFormat(): DiskFormat {
    return this.format;
  }

  getImageInfo(): DiskImageInfo {
    return this.imageInfo;
  }

  setVolumeLabel(label: string): void {
    this.imageInfo.volumeLabel = label;
  }

  /**
   * Creates a new, blank image structure
   */
  static createNew(
    format: DiskFormat,
    volumeLabel: string = 'NEW_DISK',
    sizePreset?: string,
    hasMbr?: boolean
  ): VirtualFS {
    const rootNode: VNode = {
      id: 'root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      children: [],
    };

    let sectorSize = 512;
    let totalSectors = 2880;
    let formatName = 'FAT12 Floppy (1.44MB)';

    if (format === 'iso') {
      sectorSize = 2048;
      totalSectors = 1000;
      formatName = 'ISO 9660 + Joliet';
    } else if (format === 'fat12') {
      if (sizePreset === '2.88M') {
        totalSectors = 5760;
        formatName = 'FAT12 Floppy (2.88MB)';
      } else if (sizePreset === '720K') {
        totalSectors = 1440;
        formatName = 'FAT12 Floppy (720KB)';
      } else {
        totalSectors = 2880;
        formatName = 'FAT12 Floppy (1.44MB)';
      }
    } else if (format === 'fat16') {
      // e.g. 32MB default
      const mb = sizePreset ? parseInt(sizePreset, 10) : 32;
      totalSectors = Math.floor((mb * 1024 * 1024) / 512);
      formatName = `FAT16 Disk Image (${mb}MB)`;
    } else if (format === 'fat32') {
      // e.g. 512MB default
      const mb = sizePreset ? parseInt(sizePreset, 10) : 512;
      totalSectors = Math.floor((mb * 1024 * 1024) / 512);
      formatName = `FAT32 Disk Image (${mb}MB)`;
    } else if (format === 'exfat') {
      const mb = sizePreset ? parseInt(sizePreset, 10) : 1024;
      totalSectors = Math.floor((mb * 1024 * 1024) / 512);
      formatName = `exFAT Disk Image (${mb}MB)`;
    } else if (format === 'vmdk-fat32') {
      const mb = sizePreset ? parseInt(sizePreset, 10) : 1024;
      totalSectors = Math.floor((mb * 1024 * 1024) / 512);
      formatName = `VMDK Virtual Disk - FAT32 (${mb >= 1024 ? `${mb / 1024}GB` : `${mb}MB`})`;
    } else if (format === 'vmdk-exfat') {
      const mb = sizePreset ? parseInt(sizePreset, 10) : 2048;
      totalSectors = Math.floor((mb * 1024 * 1024) / 512);
      formatName = `VMDK Virtual Disk - exFAT (${mb >= 1024 ? `${mb / 1024}GB` : `${mb}MB`})`;
    } else if (format === 'vhdx-fat32') {
      const mb = sizePreset ? parseInt(sizePreset, 10) : 1024;
      totalSectors = Math.floor((mb * 1024 * 1024) / 512);
      formatName = `VHDX Virtual Disk - FAT32 (${mb >= 1024 ? `${mb / 1024}GB` : `${mb}MB`})`;
    } else if (format === 'vhdx-exfat') {
      const mb = sizePreset ? parseInt(sizePreset, 10) : 2048;
      totalSectors = Math.floor((mb * 1024 * 1024) / 512);
      formatName = `VHDX Virtual Disk - exFAT (${mb >= 1024 ? `${mb / 1024}GB` : `${mb}MB`})`;
    }

    const isMbrFormat =
      hasMbr !== undefined
        ? hasMbr
        : format === 'fat16' || format === 'fat32' || format.startsWith('vmdk') || format.startsWith('vhdx');

    const info: DiskImageInfo = {
      format,
      formatName,
      volumeLabel: volumeLabel.toUpperCase().slice(0, format === 'iso' ? 32 : 11),
      totalSize: totalSectors * sectorSize,
      sectorSize,
      totalSectors,
      clusterSize: format === 'iso' ? undefined : 512,
      hasJoliet: format === 'iso',
      isBootable: false,
      hasMbr: isMbrFormat,
    };

    return new VirtualFS(rootNode, format, info);
  }

  /**
   * Finds a node by absolute path (e.g. "/DOCS/README.TXT")
   */
  findNode(path: string): VNode | null {
    if (path === '/' || path === '') return this.root;

    const parts = path.split('/').filter(Boolean);
    let current = this.root;

    for (const part of parts) {
      if (!current.isDirectory || !current.children) return null;
      const found = current.children.find(
        (c) => c.name.toLowerCase() === part.toLowerCase()
      );
      if (!found) return null;
      current = found;
    }

    return current;
  }

  /**
   * Adds a file to a folder (supports in-memory Uint8Array or zero-RAM File pointer)
   */
  addFile(
    parentPath: string,
    name: string,
    data?: Uint8Array,
    modifiedTime: Date = new Date(),
    fileRef?: File
  ): VNode {
    const parent = this.findNode(parentPath);
    if (!parent || !parent.isDirectory) {
      throw new Error(`Parent directory "${parentPath}" not found.`);
    }

    // Check if file with same name exists; replace if so
    const existingIndex = parent.children!.findIndex(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );

    const cleanPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
    const size = fileRef ? fileRef.size : data ? data.byteLength : 0;

    const newNode: VNode = {
      id: `vnode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      path: cleanPath,
      isDirectory: false,
      size,
      modifiedTime: fileRef ? new Date(fileRef.lastModified) : modifiedTime,
      data,
      fileRef,
    };

    if (existingIndex >= 0) {
      parent.children![existingIndex] = newNode;
    } else {
      parent.children!.push(newNode);
    }

    this.recalculateSizes();
    return newNode;
  }

  /**
   * Creates a new subfolder
   */
  createDirectory(parentPath: string, name: string): VNode {
    const parent = this.findNode(parentPath);
    if (!parent || !parent.isDirectory) {
      throw new Error(`Parent directory "${parentPath}" not found.`);
    }

    const cleanName = name.trim();
    if (!cleanName) throw new Error('Directory name cannot be empty.');

    const existing = parent.children!.find(
      (c) => c.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (existing) {
      if (existing.isDirectory) return existing;
      throw new Error(`A file with name "${cleanName}" already exists.`);
    }

    const cleanPath = parentPath === '/' ? `/${cleanName}` : `${parentPath}/${cleanName}`;
    const newDir: VNode = {
      id: `vnode-dir-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      path: cleanPath,
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      children: [],
    };

    parent.children!.push(newDir);
    return newDir;
  }

  /**
   * Deletes a node by path
   */
  deleteNode(path: string): boolean {
    if (path === '/' || path === '') return false;

    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parent = this.findNode(parentPath);
    if (!parent || !parent.children) return false;

    const index = parent.children.findIndex((c) => c.path === path);
    if (index >= 0) {
      parent.children.splice(index, 1);
      this.recalculateSizes();
      return true;
    }
    return false;
  }

  /**
   * Renames a node
   */
  renameNode(path: string, newName: string): boolean {
    const node = this.findNode(path);
    if (!node || path === '/') return false;

    const cleanName = newName.trim();
    if (!cleanName) return false;

    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    node.name = cleanName;
    node.path = parentPath === '/' ? `/${cleanName}` : `${parentPath}/${cleanName}`;

    if (node.isDirectory && node.children) {
      this.updateChildPaths(node);
    }
    return true;
  }

  private updateChildPaths(dir: VNode): void {
    for (const child of dir.children || []) {
      child.path = `${dir.path}/${child.name}`;
      if (child.isDirectory && child.children) {
        this.updateChildPaths(child);
      }
    }
  }

  /**
   * Reads the full binary bytes of a file node (handles lazy streaming)
   */
  async getFileBytes(node: VNode): Promise<Uint8Array> {
    if (node.isDirectory) return new Uint8Array(0);
    if (node.data) return node.data;
    if (node.fileRef) {
      const buffer = await node.fileRef.arrayBuffer();
      return new Uint8Array(buffer);
    }

    // From ISO source
    if (this.format === 'iso' && this.sourceReader && node.sourceSector !== undefined && node.sourceLength !== undefined) {
      return await this.sourceReader.read(node.sourceSector * ISO_SECTOR_SIZE, node.sourceLength);
    }

    // From FAT source
    if (this.sourceFatParser && node.startCluster !== undefined) {
      return await this.sourceFatParser.readFileData(node);
    }

    // From exFAT source
    if (this.sourceExFatParser && node.startCluster !== undefined) {
      return await this.sourceExFatParser.readFileData(node);
    }

    return new Uint8Array(0);
  }

  /**
   * Builds the disk image directly into a streaming writer (OPFS, Disk, or Memory)
   * Uses almost zero RAM even for multi-gigabyte disk images!
   */
  /**
   * Dynamically changes the active format of the virtual filesystem
   */
  setFormat(format: DiskFormat): void {
    this.format = format;
    this.imageInfo.format = format;
    if (format === 'iso') {
      this.imageInfo.formatName = 'ISO 9660 + Joliet';
      this.imageInfo.sectorSize = 2048;
      this.imageInfo.hasJoliet = true;
      this.imageInfo.hasMbr = false;
    } else if (format.startsWith('vmdk')) {
      const isExfat = format === 'vmdk-exfat';
      this.imageInfo.formatName = `VMDK Virtual Disk - ${isExfat ? 'exFAT' : 'FAT32'}`;
      this.imageInfo.sectorSize = 512;
      this.imageInfo.hasJoliet = false;
      this.imageInfo.hasMbr = true;
    } else if (format.startsWith('vhdx')) {
      const isExfat = format === 'vhdx-exfat';
      this.imageInfo.formatName = `VHDX Virtual Disk - ${isExfat ? 'exFAT' : 'FAT32'}`;
      this.imageInfo.sectorSize = 512;
      this.imageInfo.hasJoliet = false;
      this.imageInfo.hasMbr = true;
    } else if (format === 'exfat') {
      this.imageInfo.formatName = 'exFAT Disk Image';
      this.imageInfo.sectorSize = 512;
      this.imageInfo.hasJoliet = false;
      this.imageInfo.hasMbr = true;
    } else {
      this.imageInfo.formatName = `${format.toUpperCase()} Disk Image`;
      this.imageInfo.sectorSize = 512;
      this.imageInfo.hasJoliet = false;
      this.imageInfo.hasMbr = format !== 'fat12';
    }
  }

  /**
   * Builds the disk image directly into a streaming writer (OPFS, Disk, or Memory)
   * Uses almost zero RAM even for multi-gigabyte disk images!
   */
  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void,
    targetFormatOrOptions?: DiskFormat | ImageExportOptions
  ): Promise<void> {
    const opts: ImageExportOptions =
      typeof targetFormatOrOptions === 'string'
        ? { format: targetFormatOrOptions }
        : targetFormatOrOptions || {};
    const fmt = opts.format || this.format;
    const label = opts.volumeLabel || this.imageInfo.volumeLabel;
    const userCapacitySectors = opts.capacityMb ? Math.floor((opts.capacityMb * 1024 * 1024) / 512) : undefined;

    if (fmt === 'vhdx-fat32' || fmt === 'vhdx-exfat') {
      const minCapacity = Math.max(
        2097152, // 1 GB minimum default
        Math.ceil((this.root.size * 1.5) / 512) + 4096
      );
      const capacitySectors = userCapacitySectors && userCapacitySectors >= minCapacity
        ? userCapacitySectors
        : this.imageInfo.totalSectors && this.imageInfo.totalSectors >= minCapacity
        ? this.imageInfo.totalSectors
        : minCapacity;

      const builder = new VhdxBuilder(this.root, {
        fsType: fmt === 'vhdx-fat32' ? 'fat32' : 'exfat',
        volumeLabel: label || 'VHDX_DISK',
        capacitySectors,
      });
      await builder.buildToStream(writer, onProgress);
    } else if (fmt === 'vmdk-fat32' || fmt === 'vmdk-exfat') {
      const minCapacity = Math.max(
        2097152, // 1 GB minimum default
        Math.ceil((this.root.size * 1.5) / 512) + 4096
      );
      const capacitySectors = userCapacitySectors && userCapacitySectors >= minCapacity
        ? userCapacitySectors
        : this.imageInfo.totalSectors && this.imageInfo.totalSectors >= minCapacity
        ? this.imageInfo.totalSectors
        : minCapacity;

      const vmdkDiskName = `${(label || 'vmdk_disk').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.vmdk`;
      const builder = new VmdkBuilder(this.root, {
        fsType: fmt === 'vmdk-fat32' ? 'fat32' : 'exfat',
        volumeLabel: label || 'VMDK_DISK',
        capacitySectors,
        diskName: vmdkDiskName,
      });
      await builder.buildToStream(writer, onProgress);
    } else if (fmt === 'exfat') {
      const sectors = userCapacitySectors || this.imageInfo.totalSectors || Math.max(2097152, Math.ceil((this.root.size * 1.5) / 512));
      const builder = new ExFatBuilder(this.root, label || 'EXFAT', sectors);
      await builder.buildToStream(writer, onProgress);
    } else if (fmt === 'iso') {
      const builder = new IsoBuilder(
        this.root,
        {
          volumeLabel: label || 'CDROM',
          enableJoliet: this.imageInfo.hasJoliet !== false,
        },
        this.sourceReader
      );
      await builder.buildToStream(writer, onProgress);
    } else {
      const fatType =
        fmt === 'fat12'
          ? FatType.FAT12
          : fmt === 'fat16'
          ? FatType.FAT16
          : FatType.FAT32;

      let sectors = userCapacitySectors || this.imageInfo.totalSectors;
      const minRequiredSectors = Math.ceil((this.root.size * 1.3) / 512) + 2048;
      const isCompatible =
        sectors &&
        sectors >= minRequiredSectors &&
        (fatType === FatType.FAT12
          ? sectors <= 5760
          : fatType === FatType.FAT16
          ? sectors >= 4096 && sectors <= 4194304
          : sectors >= 67000);

      if (!isCompatible) {
        if (fatType === FatType.FAT12) {
          sectors = 2880;
        } else if (fatType === FatType.FAT16) {
          sectors = Math.max(65536, Math.min(4194304, minRequiredSectors));
        } else {
          sectors = Math.max(131072, minRequiredSectors);
        }
      }

      const builder = new FatBuilder(
        this.root,
        {
          fatType,
          volumeLabel: label || 'DOS_DISK',
          totalSectors: sectors,
          hasMbr: this.imageInfo.hasMbr !== undefined ? this.imageInfo.hasMbr : fmt !== 'fat12',
        },
        this.sourceFatParser
      );
      await builder.buildToStream(writer, onProgress);
    }
  }

  /**
   * Builds the image directly into browser's OPFS persistent storage (Zero RAM!)
   */
  async buildToOpfs(
    fileName: string,
    onProgress?: (ratio: number, status: string) => void,
    targetFormatOrOptions?: DiskFormat | ImageExportOptions
  ): Promise<void> {
    const streamWriter = await OpfsManager.createStreamWriter(fileName);
    const accessWriter = new FileSystemAccessStreamWriter(streamWriter);
    try {
      await this.buildToStream(accessWriter, onProgress, targetFormatOrOptions);
    } finally {
      await accessWriter.close();
    }
  }

  /**
   * Builds the image directly to the user's hard drive / SSD via File System Access API (Zero RAM!)
   */
  async buildToDisk(
    fileHandle: FileSystemFileHandle,
    onProgress?: (ratio: number, status: string) => void,
    targetFormatOrOptions?: DiskFormat | ImageExportOptions
  ): Promise<void> {
    const writable = await fileHandle.createWritable();
    const accessWriter = new FileSystemAccessStreamWriter(writable);
    try {
      await this.buildToStream(accessWriter, onProgress, targetFormatOrOptions);
    } finally {
      await accessWriter.close();
    }
  }

  /**
   * Builds and exports the disk image as a Blob
   */
  async buildImageBlob(
    onProgress?: (ratio: number, status: string) => void,
    targetFormatOrOptions?: DiskFormat | ImageExportOptions
  ): Promise<Blob> {
    const opts: ImageExportOptions =
      typeof targetFormatOrOptions === 'string'
        ? { format: targetFormatOrOptions }
        : targetFormatOrOptions || {};
    const fmt = opts.format || this.format;
    const mimeType = fmt.startsWith('vhdx')
      ? 'application/x-vhdx'
      : fmt.startsWith('vmdk')
      ? 'application/x-vmdk'
      : fmt === 'iso'
      ? 'application/x-iso9660-image'
      : 'application/octet-stream';
    const accumulator = new BlobAccumulatorWriter(mimeType);
    await this.buildToStream(accumulator, onProgress, targetFormatOrOptions);
    return accumulator.getBlob();
  }

  /**
   * Exports all files and folders as a downloadable ZIP
   */
  async exportAsZip(onProgress?: (ratio: number, name: string) => void): Promise<Blob> {
    return await ZipArchiver.buildZip(
      this.root,
      (node) => this.getFileBytes(node),
      onProgress
    );
  }

  private recalculateSizes(): void {
    let fileSectors = 0;
    let dirCount = 0;

    const calc = (node: VNode): number => {
      if (!node.isDirectory) {
        const sz = node.data?.byteLength ?? node.size;
        node.size = sz;
        if (this.format === 'iso') {
          fileSectors += Math.max(1, Math.ceil(sz / ISO_SECTOR_SIZE));
        }
        return sz;
      }
      dirCount++;
      let total = 0;
      for (const child of node.children || []) {
        total += calc(child);
      }
      node.size = total;
      return total;
    };

    calc(this.root);

    if (this.format === 'iso') {
      // ISO 9660 overhead:
      // 16 sectors System Area + 3 descriptors + 2 path tables + directories
      const overheadSectors = 16 + 3 + 2 + Math.max(2, dirCount * 2);
      const totalSecs = overheadSectors + fileSectors;
      this.imageInfo.totalSectors = totalSecs;
      this.imageInfo.totalSize = totalSecs * ISO_SECTOR_SIZE;
    }
  }
}
