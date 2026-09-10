// High-performance ISO 9660 + Joliet generator / builder
import { RandomAccessReader } from '../reader';
import { BlobAccumulatorWriter, ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import {
  ISO_SECTOR_SIZE,
  ISO_STANDARD_ID,
  ISO_SYSTEM_AREA_SECTORS,
  IsoFileFlags,
  VolumeDescriptorType,
} from './iso-types';

export interface IsoBuilderOptions {
  volumeLabel?: string;
  enableJoliet?: boolean;
  bootFileNode?: VNode; // Optional El Torito boot image
}

interface FlattenedDir {
  node: VNode;
  parentDirIndex: number; // 1-indexed for path table
  pvdSector: number;
  pvdSize: number;
  jolietSector: number;
  jolietSize: number;
}

export class IsoBuilder {
  private root: VNode;
  private options: IsoBuilderOptions;
  private sourceReader?: RandomAccessReader;

  constructor(root: VNode, options: IsoBuilderOptions = {}, sourceReader?: RandomAccessReader) {
    this.root = root;
    this.options = {
      volumeLabel: (options.volumeLabel || 'ISOWEB_DISK').toUpperCase().slice(0, 32),
      enableJoliet: options.enableJoliet !== false,
      ...options,
    };
    this.sourceReader = sourceReader;
  }

  /**
   * Builds the ISO image directly into a streaming writer (OPFS, Disk, or Memory)
   * Keeps RAM usage under a few megabytes even for 10+ GB ISOs!
   */
  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    onProgress?.(0.05, 'Calculating directory layout...');
    const layout = await this.calculateLayout();

    onProgress?.(0.15, 'Writing system area & volume descriptors...');

    // 1. System Area (Sectors 0-15: 32KB)
    await writer.write(new Uint8Array(ISO_SYSTEM_AREA_SECTORS * ISO_SECTOR_SIZE));

    // 2. Volume Descriptors (PVD, SVD Joliet, Terminator)
    const pvdBytes = this.buildPvd(layout);
    await writer.write(pvdBytes);

    if (this.options.enableJoliet) {
      const svdBytes = this.buildJolietSvd(layout);
      await writer.write(svdBytes);
    }

    const terminator = this.buildTerminator();
    await writer.write(terminator);

    // 3. Path Tables
    const pvdPathTableL = this.buildPathTable(layout.directories, false, true);
    await writer.write(pvdPathTableL);

    if (this.options.enableJoliet) {
      const jolietPathTableL = this.buildPathTable(layout.directories, true, true);
      await writer.write(jolietPathTableL);
    }

    // 4. Directory Records for PVD
    onProgress?.(0.3, 'Writing directory sectors...');
    for (const dir of layout.directories) {
      const dirBytes = this.buildDirectorySector(dir, layout, false);
      await writer.write(dirBytes);
    }

    // 5. Directory Records for Joliet
    if (this.options.enableJoliet) {
      for (const dir of layout.directories) {
        const dirBytes = this.buildDirectorySector(dir, layout, true);
        await writer.write(dirBytes);
      }
    }

    // 6. File Extents - Stream data in chunks without loading full file into RAM!
    const totalFiles = layout.files.length;
    for (let i = 0; i < totalFiles; i++) {
      const fileInfo = layout.files[i];
      const progress = 0.4 + (i / Math.max(1, totalFiles)) * 0.55;
      onProgress?.(progress, `Streaming file ${i + 1}/${totalFiles}: ${fileInfo.node.name}`);

      await this.streamFileData(fileInfo.node, writer);

      // Sector alignment padding (2048-byte sector boundary)
      const padBytes = fileInfo.size === 0 ? 0 : (ISO_SECTOR_SIZE - (fileInfo.size % ISO_SECTOR_SIZE)) % ISO_SECTOR_SIZE;
      if (padBytes > 0) {
        await writer.write(new Uint8Array(padBytes));
      }
    }

    onProgress?.(1.0, 'Finalizing ISO stream...');
  }

  /**
   * Builds the entire ISO image and returns it as a Blob
   */
  async buildBlob(onProgress?: (ratio: number, status: string) => void): Promise<Blob> {
    const accumulator = new BlobAccumulatorWriter('application/x-iso9660-image');
    await this.buildToStream(accumulator, onProgress);
    return accumulator.getBlob();
  }

  private async streamFileData(node: VNode, writer: ImageStreamWriter): Promise<void> {
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunk buffer

    // Case 1: Local File reference (e.g. multi-gigabyte file added by user)
    if (node.fileRef) {
      const file = node.fileRef;
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const slice = file.slice(offset, end);
        const buffer = await slice.arrayBuffer();
        await writer.write(new Uint8Array(buffer));
        offset = end;
      }
      return;
    }

    // Case 2: In-memory byte array (takes precedence if file was edited/modified)
    if (node.data && node.data.length > 0) {
      await writer.write(node.data);
      return;
    }

    // Case 3: From existing ISO image reader (zero-copy lazy stream)
    if (this.sourceReader && node.sourceSector !== undefined && node.sourceLength !== undefined) {
      const startByte = node.sourceSector * ISO_SECTOR_SIZE;
      const totalLen = node.sourceLength;
      let offset = 0;
      while (offset < totalLen) {
        const len = Math.min(CHUNK_SIZE, totalLen - offset);
        const chunk = await this.sourceReader.read(startByte + offset, len);
        await writer.write(chunk);
        offset += len;
      }
      return;
    }
  }

  private async calculateLayout() {
    // Traverse directories in breadth-first order (required by ISO 9660 path table)
    const directories: FlattenedDir[] = [];
    const files: { node: VNode; sector: number; size: number }[] = [];

    // Root directory
    directories.push({
      node: this.root,
      parentDirIndex: 1,
      pvdSector: 0,
      pvdSize: 0,
      jolietSector: 0,
      jolietSize: 0,
    });

    let queueIndex = 0;
    while (queueIndex < directories.length) {
      const current = directories[queueIndex];
      const dirIndex = queueIndex + 1; // 1-based index
      queueIndex++;

      const children = current.node.children || [];
      // Sort children: ISO 9660 specifies canonical order (uppercase ASCII / UCS-2)
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        if (child.isDirectory) {
          directories.push({
            node: child,
            parentDirIndex: dirIndex,
            pvdSector: 0,
            pvdSize: 0,
            jolietSector: 0,
            jolietSize: 0,
          });
        }
      }
    }

    // Sectors layout plan:
    // 0-15: System area (16 sectors)
    // 16: PVD (1 sector)
    // 17: SVD Joliet (1 sector) if enabled
    // 18: Terminator (1 sector)
    let currentSector = ISO_SYSTEM_AREA_SECTORS + 1 + (this.options.enableJoliet ? 1 : 0) + 1;

    // Path tables: PVD Type L
    const pvdPathTableSectors = Math.max(1, Math.ceil(this.getPathTableSize(directories, false) / ISO_SECTOR_SIZE));
    const pvdPathTableSector = currentSector;
    currentSector += pvdPathTableSectors;

    let jolietPathTableSector = 0;
    if (this.options.enableJoliet) {
      const jolietPathTableSectors = Math.max(1, Math.ceil(this.getPathTableSize(directories, true) / ISO_SECTOR_SIZE));
      jolietPathTableSector = currentSector;
      currentSector += jolietPathTableSectors;
    }

    // Pre-calculate directory sizes
    for (const dir of directories) {
      dir.pvdSize = this.measureDirectorySize(dir, false);
      const pvdSectors = Math.ceil(dir.pvdSize / ISO_SECTOR_SIZE);
      dir.pvdSector = currentSector;
      currentSector += pvdSectors;
    }

    if (this.options.enableJoliet) {
      for (const dir of directories) {
        dir.jolietSize = this.measureDirectorySize(dir, true);
        const jolietSectors = Math.ceil(dir.jolietSize / ISO_SECTOR_SIZE);
        dir.jolietSector = currentSector;
        currentSector += jolietSectors;
      }
    }

    // Collect all files and assign their sectors
    const collectFiles = (node: VNode) => {
      for (const child of node.children || []) {
        if (child.isDirectory) {
          collectFiles(child);
        } else {
          const fileSize = child.fileRef?.size ?? child.data?.byteLength ?? child.sourceLength ?? child.size ?? 0;
          const fileSectors = Math.ceil(fileSize / ISO_SECTOR_SIZE);
          files.push({
            node: child,
            sector: currentSector,
            size: fileSize,
          });
          currentSector += fileSectors;
        }
      }
    };
    collectFiles(this.root);

    const totalSectors = currentSector;

    return {
      directories,
      files,
      pvdPathTableSector,
      jolietPathTableSector,
      totalSectors,
    };
  }

  private getChildFileIdBytes(child: VNode, isJoliet: boolean): Uint8Array {
    if (isJoliet) {
      // Joliet specification supports up to 64 Unicode characters (128 bytes)
      let name = child.name;
      if (name.length > 64) {
        const extDot = name.lastIndexOf('.');
        if (extDot > 0 && name.length - extDot <= 10) {
          const ext = name.slice(extDot);
          name = name.slice(0, 64 - ext.length) + ext;
        } else {
          name = name.slice(0, 64);
        }
      }
      return this.encodeUcs2BE(name);
    } else {
      // ISO 9660 Level 2 allows up to 30 chars for base name, plus extension and version (;1)
      let cleanName = child.name.toUpperCase().replace(/[^A-Z0-9_.]/g, '_');
      if (cleanName.length > 30) {
        const extDot = cleanName.lastIndexOf('.');
        if (extDot > 0 && cleanName.length - extDot <= 5) {
          const ext = cleanName.slice(extDot);
          cleanName = cleanName.slice(0, 30 - ext.length) + ext;
        } else {
          cleanName = cleanName.slice(0, 30);
        }
      }
      const formatted = child.isDirectory ? cleanName : `${cleanName};1`;
      return new Uint8Array([...formatted].map((c) => c.charCodeAt(0)));
    }
  }

  private computeRecordLength(fileIdByteLength: number): number {
    const rawLen = 33 + fileIdByteLength;
    return rawLen + (rawLen % 2); // 2-byte aligned
  }

  private measureDirectorySize(dir: FlattenedDir, isJoliet: boolean): number {
    let offset = 0;
    // Entry for '.' (id length = 1)
    offset += this.computeRecordLength(1);
    // Entry for '..' (id length = 1)
    offset += this.computeRecordLength(1);

    for (const child of dir.node.children || []) {
      const fileIdBytes = this.getChildFileIdBytes(child, isJoliet);
      const recLen = this.computeRecordLength(fileIdBytes.length);

      // In ISO 9660, directory records cannot span across sector boundaries (2048 bytes)
      const currentSectorOffset = offset % ISO_SECTOR_SIZE;
      if (currentSectorOffset + recLen > ISO_SECTOR_SIZE) {
        // Pad rest of current sector and jump to next sector
        offset = Math.ceil(offset / ISO_SECTOR_SIZE) * ISO_SECTOR_SIZE;
      }
      offset += recLen;
    }

    return Math.max(ISO_SECTOR_SIZE, Math.ceil(offset / ISO_SECTOR_SIZE) * ISO_SECTOR_SIZE);
  }

  private buildPvd(layout: Awaited<ReturnType<typeof this.calculateLayout>>): Uint8Array {
    const sector = new Uint8Array(ISO_SECTOR_SIZE);
    sector[0] = VolumeDescriptorType.PrimaryVolumeDescriptor;
    this.writeAscii(sector, 1, ISO_STANDARD_ID);
    sector[6] = 0x01; // version

    this.writeAscii(sector, 8, 'ISOWEB', 32);
    this.writeAscii(sector, 40, this.options.volumeLabel || 'CDROM', 32);

    this.writeBoth32(sector, 80, layout.totalSectors);
    this.writeBoth16(sector, 120, 1); // Volume Set Size
    this.writeBoth16(sector, 124, 1); // Volume Sequence Number
    this.writeBoth16(sector, 128, ISO_SECTOR_SIZE); // Logical Block Size

    const pathTableSize = this.getPathTableSize(layout.directories, false);
    this.writeBoth32(sector, 132, pathTableSize);
    this.writeUint32LE(sector, 140, layout.pvdPathTableSector);
    this.writeUint32BE(sector, 148, layout.pvdPathTableSector);

    // Root Directory Record
    const rootDir = layout.directories[0];
    this.writeDirectoryRecord(
      sector.subarray(156, 190),
      rootDir.pvdSector,
      rootDir.pvdSize,
      true,
      new Uint8Array([0]),
      new Date()
    );

    this.writeAscii(sector, 190, this.options.volumeLabel || 'CDROM', 128); // Volume Set ID
    this.writeAscii(sector, 318, 'ISOWEB BUILDER', 128); // Publisher ID
    this.writeAscii(sector, 446, 'ISOWEB BROWSER ENGINE', 128); // Preparer ID
    this.writeAscii(sector, 574, 'ISOWEB 1.0', 128); // Application ID

    this.writeIsoDateLong(sector, 813, new Date()); // Creation
    this.writeIsoDateLong(sector, 830, new Date()); // Modification
    this.writeIsoDateLong(sector, 847, new Date(0)); // Expiration
    this.writeIsoDateLong(sector, 864, new Date()); // Effective

    sector[881] = 0x01; // File Structure Version
    return sector;
  }

  private buildJolietSvd(layout: Awaited<ReturnType<typeof this.calculateLayout>>): Uint8Array {
    const sector = new Uint8Array(ISO_SECTOR_SIZE);
    sector[0] = VolumeDescriptorType.SupplementaryVolumeDescriptor;
    this.writeAscii(sector, 1, ISO_STANDARD_ID);
    sector[6] = 0x01; // version

    this.writeUcs2BE(sector, 8, 'ISOWEB', 16);
    this.writeUcs2BE(sector, 40, this.options.volumeLabel || 'CDROM', 16);

    this.writeBoth32(sector, 80, layout.totalSectors);

    // Joliet Escape Sequences (Level 3: %/E)
    sector[88] = 0x25;
    sector[89] = 0x2f;
    sector[90] = 0x45;

    this.writeBoth16(sector, 120, 1);
    this.writeBoth16(sector, 124, 1);
    this.writeBoth16(sector, 128, ISO_SECTOR_SIZE);

    const pathTableSize = this.getPathTableSize(layout.directories, true);
    this.writeBoth32(sector, 132, pathTableSize);
    this.writeUint32LE(sector, 140, layout.jolietPathTableSector);
    this.writeUint32BE(sector, 148, layout.jolietPathTableSector);

    // Root Directory Record
    const rootDir = layout.directories[0];
    this.writeDirectoryRecord(
      sector.subarray(156, 190),
      rootDir.jolietSector,
      rootDir.jolietSize,
      true,
      new Uint8Array([0]),
      new Date()
    );

    this.writeUcs2BE(sector, 190, this.options.volumeLabel || 'CDROM', 64);
    this.writeUcs2BE(sector, 318, 'ISOWEB BUILDER', 64);
    this.writeUcs2BE(sector, 446, 'ISOWEB BROWSER ENGINE', 64);
    this.writeUcs2BE(sector, 574, 'ISOWEB 1.0', 64);

    this.writeIsoDateLong(sector, 813, new Date());
    this.writeIsoDateLong(sector, 830, new Date());
    this.writeIsoDateLong(sector, 847, new Date(0));
    this.writeIsoDateLong(sector, 864, new Date());

    sector[881] = 0x01;
    return sector;
  }

  private buildTerminator(): Uint8Array {
    const sector = new Uint8Array(ISO_SECTOR_SIZE);
    sector[0] = VolumeDescriptorType.VolumeDescriptorSetTerminator;
    this.writeAscii(sector, 1, ISO_STANDARD_ID);
    sector[6] = 0x01;
    return sector;
  }

  private getPathTableSize(directories: FlattenedDir[], isJoliet: boolean): number {
    let size = 0;
    for (let i = 0; i < directories.length; i++) {
      const name = i === 0 ? '\0' : directories[i].node.name;
      const idLen = isJoliet ? (i === 0 ? 1 : name.length * 2) : name.length;
      const recordSize = 8 + idLen + (idLen % 2);
      size += recordSize;
    }
    return size;
  }

  private buildPathTable(
    directories: FlattenedDir[],
    isJoliet: boolean,
    isLittleEndian: boolean
  ): Uint8Array {
    const tableSize = this.getPathTableSize(directories, isJoliet);
    const bufferSize = Math.max(ISO_SECTOR_SIZE, Math.ceil(tableSize / ISO_SECTOR_SIZE) * ISO_SECTOR_SIZE);
    let buffer = new Uint8Array(bufferSize);
    let offset = 0;

    for (let i = 0; i < directories.length; i++) {
      const dir = directories[i];
      const sector = isJoliet ? dir.jolietSector : dir.pvdSector;
      const name = i === 0 ? '\0' : dir.node.name;
      const idLen = i === 0 ? 1 : isJoliet ? name.length * 2 : name.length;
      const recLen = 8 + idLen + (idLen % 2);

      if (offset + recLen > buffer.length) {
        const newBuffer = new Uint8Array(buffer.length + ISO_SECTOR_SIZE);
        newBuffer.set(buffer);
        buffer = newBuffer;
      }

      buffer[offset] = idLen;
      buffer[offset + 1] = 0; // Extended attribute length

      if (isLittleEndian) {
        this.writeUint32LE(buffer, offset + 2, sector);
        this.writeUint16LE(buffer, offset + 6, dir.parentDirIndex);
      } else {
        this.writeUint32BE(buffer, offset + 2, sector);
        this.writeUint16BE(buffer, offset + 6, dir.parentDirIndex);
      }

      offset += 8;

      if (i === 0) {
        buffer[offset++] = 0;
      } else if (isJoliet) {
        for (let c = 0; c < name.length; c++) {
          const code = name.charCodeAt(c);
          buffer[offset++] = (code >> 8) & 0xff;
          buffer[offset++] = code & 0xff;
        }
      } else {
        for (let c = 0; c < name.length; c++) {
          buffer[offset++] = name.charCodeAt(c);
        }
      }

      if (idLen % 2 !== 0) {
        buffer[offset++] = 0; // padding byte
      }
    }

    return buffer;
  }

  private buildDirectorySector(
    dir: FlattenedDir,
    layout: Awaited<ReturnType<typeof this.calculateLayout>>,
    isJoliet: boolean
  ): Uint8Array {
    const totalSize = isJoliet ? dir.jolietSize : dir.pvdSize;
    let buffer = new Uint8Array(totalSize);
    let offset = 0;

    const selfSector = isJoliet ? dir.jolietSector : dir.pvdSector;
    const parentSector =
      dir.parentDirIndex === 1
        ? isJoliet
          ? layout.directories[0].jolietSector
          : layout.directories[0].pvdSector
        : isJoliet
        ? layout.directories[dir.parentDirIndex - 1].jolietSector
        : layout.directories[dir.parentDirIndex - 1].pvdSector;

    // 1. '.' (self)
    offset += this.writeDirectoryRecord(
      buffer.subarray(offset),
      selfSector,
      totalSize,
      true,
      new Uint8Array([0x00]),
      dir.node.modifiedTime
    );

    // 2. '..' (parent)
    const parentDir = layout.directories[dir.parentDirIndex - 1];
    const parentSize = isJoliet ? parentDir.jolietSize : parentDir.pvdSize;
    offset += this.writeDirectoryRecord(
      buffer.subarray(offset),
      parentSector,
      parentSize,
      true,
      new Uint8Array([0x01]),
      parentDir.node.modifiedTime
    );

    // 3. Children
    for (const child of dir.node.children || []) {
      let childSector = 0;
      let childLength = 0;

      if (child.isDirectory) {
        const foundDir = layout.directories.find((d) => d.node === child);
        if (foundDir) {
          childSector = isJoliet ? foundDir.jolietSector : foundDir.pvdSector;
          childLength = isJoliet ? foundDir.jolietSize : foundDir.pvdSize;
        }
      } else {
        const foundFile = layout.files.find((f) => f.node === child);
        if (foundFile) {
          childSector = foundFile.sector;
          childLength = foundFile.size;
        }
      }

      const fileIdBytes = this.getChildFileIdBytes(child, isJoliet);
      const recLen = this.computeRecordLength(fileIdBytes.length);

      // Check if entry crosses sector boundary
      const currentSectorOffset = offset % ISO_SECTOR_SIZE;
      if (currentSectorOffset + recLen > ISO_SECTOR_SIZE) {
        // Pad rest of current sector with 0s and jump to next sector
        offset = Math.ceil(offset / ISO_SECTOR_SIZE) * ISO_SECTOR_SIZE;
      }

      // Safeguard: Ensure buffer has enough space
      if (offset + recLen > buffer.length) {
        const newTotal = Math.ceil((offset + recLen) / ISO_SECTOR_SIZE) * ISO_SECTOR_SIZE;
        const newBuffer = new Uint8Array(newTotal);
        newBuffer.set(buffer);
        buffer = newBuffer;
      }

      offset += this.writeDirectoryRecord(
        buffer.subarray(offset),
        childSector,
        childLength,
        child.isDirectory,
        fileIdBytes,
        child.modifiedTime
      );
    }

    return buffer;
  }

  private writeDirectoryRecord(
    dest: Uint8Array,
    sector: number,
    dataLen: number,
    isDirectory: boolean,
    fileIdBytes: Uint8Array,
    date: Date
  ): number {
    const rawLen = 33 + fileIdBytes.length;
    const recordLen = rawLen + (rawLen % 2); // must be even

    dest[0] = recordLen;
    dest[1] = 0; // Extended attribute
    this.writeBoth32(dest, 2, sector);
    this.writeBoth32(dest, 10, dataLen);
    this.writeIsoDateShort(dest, 18, date);
    dest[25] = isDirectory ? IsoFileFlags.Directory : 0;
    dest[26] = 0;
    dest[27] = 0;
    this.writeBoth16(dest, 28, 1);
    dest[32] = fileIdBytes.length;
    dest.set(fileIdBytes, 33);

    if (rawLen % 2 !== 0) {
      dest[33 + fileIdBytes.length] = 0; // padding
    }

    return recordLen;
  }

  private writeBoth16(buf: Uint8Array, offset: number, val: number): void {
    this.writeUint16LE(buf, offset, val);
    this.writeUint16BE(buf, offset + 2, val);
  }

  private writeBoth32(buf: Uint8Array, offset: number, val: number): void {
    this.writeUint32LE(buf, offset, val);
    this.writeUint32BE(buf, offset + 4, val);
  }

  private writeUint16LE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
  }

  private writeUint16BE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = (val >> 8) & 0xff;
    buf[offset + 1] = val & 0xff;
  }

  private writeUint32LE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = val & 0xff;
    buf[offset + 1] = (val >> 8) & 0xff;
    buf[offset + 2] = (val >> 16) & 0xff;
    buf[offset + 3] = (val >> 24) & 0xff;
  }

  private writeUint32BE(buf: Uint8Array, offset: number, val: number): void {
    buf[offset] = (val >> 24) & 0xff;
    buf[offset + 1] = (val >> 16) & 0xff;
    buf[offset + 2] = (val >> 8) & 0xff;
    buf[offset + 3] = val & 0xff;
  }

  private writeAscii(buf: Uint8Array, offset: number, text: string, padToLen?: number): void {
    const len = padToLen || text.length;
    for (let i = 0; i < len; i++) {
      buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0x20; // space pad
    }
  }

  private writeUcs2BE(buf: Uint8Array, offset: number, text: string, padChars: number): void {
    for (let i = 0; i < padChars; i++) {
      if (i < text.length) {
        const code = text.charCodeAt(i);
        buf[offset + i * 2] = (code >> 8) & 0xff;
        buf[offset + i * 2 + 1] = code & 0xff;
      } else {
        buf[offset + i * 2] = 0x00;
        buf[offset + i * 2 + 1] = 0x20; // space in UCS-2
      }
    }
  }

  private encodeUcs2BE(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[i * 2] = (code >> 8) & 0xff;
      bytes[i * 2 + 1] = code & 0xff;
    }
    return bytes;
  }

  private writeIsoDateShort(buf: Uint8Array, offset: number, date: Date): void {
    buf[offset] = date.getUTCFullYear() - 1900;
    buf[offset + 1] = date.getUTCMonth() + 1;
    buf[offset + 2] = date.getUTCDate();
    buf[offset + 3] = date.getUTCHours();
    buf[offset + 4] = date.getUTCMinutes();
    buf[offset + 5] = date.getUTCSeconds();
    buf[offset + 6] = 0; // GMT offset in 15 min intervals
  }

  private writeIsoDateLong(buf: Uint8Array, offset: number, date: Date): void {
    if (date.getTime() === 0) {
      // 0000000000000000\0
      this.writeAscii(buf, offset, '0000000000000000', 16);
      buf[offset + 16] = 0;
      return;
    }
    const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
    const y = pad(date.getUTCFullYear(), 4);
    const m = pad(date.getUTCMonth() + 1);
    const d = pad(date.getUTCDate());
    const h = pad(date.getUTCHours());
    const min = pad(date.getUTCMinutes());
    const s = pad(date.getUTCSeconds());
    const ms = pad(Math.floor(date.getUTCMilliseconds() / 10));
    const str = `${y}${m}${d}${h}${min}${s}${ms}`;
    this.writeAscii(buf, offset, str, 16);
    buf[offset + 16] = 0; // timezone offset
  }
}
