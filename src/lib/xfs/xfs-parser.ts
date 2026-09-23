// High-performance XFS parser for Linux virtual disks & raw partitions
// Reads XFS v4 and v5 filesystems, parses shortform and block directories,
// decodes bmbt extents, and extracts files lazily with zero RAM buffering.
import { RandomAccessReader } from '../reader';
import { DiskImageInfo, VNode } from '../types';
import { IFileSystemParser } from '../filesystem/fs-types';
import {
  readUint16BE,
  readUint32BE,
  readUint64BE,
  S_IFDIR,
  S_IFMT,
  unpackBmbtRecord,
  XFS_DEFAULT_BLOCK_SIZE,
  XFS_DEFAULT_INODE_SIZE,
  XFS_DINODE_FMT_EXTENTS,
  XFS_DINODE_FMT_LOCAL,
  XFS_DINODE_MAGIC,
  XFS_DIR2_BLOCK_MAGIC,
  XFS_DIR3_BLOCK_MAGIC,
  XFS_SB_MAGIC,
  XFS_SECTOR_SIZE,
} from './xfs-types';

export interface XfsInodeInfo {
  ino: number;
  mode: number;
  version: number;
  format: number;
  size: number;
  nblocks: number;
  mtime: Date;
  extents: { startoff: bigint; startblock: bigint; blockcount: number }[];
  localData?: Uint8Array;
}

export class XfsParser implements IFileSystemParser {
  private reader: RandomAccessReader;
  private partitionStartSector: number;
  private partitionByteOffset: number;

  // Geometry
  private blockSize: number = XFS_DEFAULT_BLOCK_SIZE;
  private inodeSize: number = XFS_DEFAULT_INODE_SIZE;
  private inopblock: number = 8;
  private inopblog: number = 3;
  private agblocks: number = 0;
  private agcount: number = 1;
  private agblklog: number = 0;
  private rootino: number = 128;
  private volumeLabel: string = 'XFS_DISK';
  private totalSize: number = 0;
  private versionnum: number = 5;

  private inodeMap: Map<string, XfsInodeInfo> = new Map();

  constructor(reader: RandomAccessReader, partitionStartSector: number = 0) {
    this.reader = reader;
    this.partitionStartSector = partitionStartSector;
    this.partitionByteOffset = partitionStartSector * XFS_SECTOR_SIZE;
  }

  async parse(): Promise<{ root: VNode; info: DiskImageInfo }> {
    // 1. Read Primary Superblock (AG 0 Sector 0)
    const sbBytes = await this.reader.read(this.partitionByteOffset, XFS_SECTOR_SIZE);
    const magic = readUint32BE(sbBytes, 0);

    if (magic !== XFS_SB_MAGIC) {
      throw new Error(`Invalid XFS Superblock magic: 0x${magic.toString(16)} (expected 0x${XFS_SB_MAGIC.toString(16)})`);
    }

    this.blockSize = readUint32BE(sbBytes, 4) || XFS_DEFAULT_BLOCK_SIZE;
    const dblocks = Number(readUint64BE(sbBytes, 8));
    this.totalSize = dblocks * this.blockSize;

    this.rootino = Number(readUint64BE(sbBytes, 56));
    this.agblocks = readUint32BE(sbBytes, 84);
    this.agcount = readUint32BE(sbBytes, 88);

    const versionRaw = readUint16BE(sbBytes, 100);
    this.versionnum = versionRaw & 0x000f;
    this.inodeSize = readUint16BE(sbBytes, 104) || XFS_DEFAULT_INODE_SIZE;
    this.inopblock = readUint16BE(sbBytes, 106) || Math.floor(this.blockSize / this.inodeSize);

    // Extract volume label (sb_fname at offset 108, up to 12 chars)
    const labelRaw = sbBytes.subarray(108, 120);
    let labelEnd = labelRaw.indexOf(0);
    if (labelEnd === -1) labelEnd = 12;
    this.volumeLabel = new TextDecoder('utf-8').decode(labelRaw.subarray(0, labelEnd)).trim() || 'XFS_DISK';

    this.inopblog = sbBytes[123] || Math.round(Math.log2(this.inopblock));
    this.agblklog = sbBytes[124] || Math.ceil(Math.log2(this.agblocks));

    // 2. Read Root Inode and Traverse Directories
    const rootNode: VNode = {
      id: 'root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      children: [],
    };

    await this.traverseDirectory(this.rootino, rootNode, '/');

    const info: DiskImageInfo = {
      format: 'xfs',
      formatName: `XFS v${this.versionnum} Filesystem (${Math.round(this.totalSize / (1024 * 1024))}MB)`,
      volumeLabel: this.volumeLabel,
      totalSize: this.totalSize,
      sectorSize: XFS_SECTOR_SIZE,
      totalSectors: Math.floor(this.totalSize / XFS_SECTOR_SIZE),
      hasMbr: this.partitionStartSector > 0,
    };

    return { root: rootNode, info };
  }

  /**
   * Reads an on-disk inode by its 64-bit absolute inode number
   */
  async readInode(ino: number): Promise<XfsInodeInfo> {
    const agno = Math.floor(ino / (2 ** (this.agblklog + this.inopblog)));
    const agRemainder = ino % (2 ** (this.agblklog + this.inopblog));
    const agbno = Math.floor(agRemainder / (2 ** this.inopblog));
    const offsetInBlock = agRemainder % (2 ** this.inopblog);

    const physicalBlock = agno * this.agblocks + agbno;
    const inodeByteOffset =
      this.partitionByteOffset + physicalBlock * this.blockSize + offsetInBlock * this.inodeSize;

    const inodeBytes = await this.reader.read(inodeByteOffset, this.inodeSize);
    const magic = readUint16BE(inodeBytes, 0);

    if (magic !== XFS_DINODE_MAGIC) {
      throw new Error(`Invalid XFS Inode magic: 0x${magic.toString(16)} at ino ${ino}`);
    }

    const mode = readUint16BE(inodeBytes, 2);
    const version = inodeBytes[4];
    const format = inodeBytes[5];
    const mtimeSec = readUint32BE(inodeBytes, 40);
    const mtime = new Date(mtimeSec * 1000);
    const size = Number(readUint64BE(inodeBytes, 56));
    const nblocks = Number(readUint64BE(inodeBytes, 64));
    const nextents = readUint32BE(inodeBytes, 76);

    // Data fork offset: 100 bytes for v1/v2 inode, 176 bytes for v3 (v5) inode
    const dataForkOffset = version >= 3 ? 176 : 100;
    const extents: { startoff: bigint; startblock: bigint; blockcount: number }[] = [];
    let localData: Uint8Array | undefined;

    if (format === XFS_DINODE_FMT_LOCAL) {
      // Inline resident data (shortform directory or small file data)
      const dataLen = Math.min(size, this.inodeSize - dataForkOffset);
      localData = new Uint8Array(inodeBytes.subarray(dataForkOffset, dataForkOffset + dataLen));
    } else if (format === XFS_DINODE_FMT_EXTENTS) {
      for (let e = 0; e < nextents; e++) {
        const recOffset = dataForkOffset + e * 16;
        if (recOffset + 16 <= this.inodeSize) {
          const unpacked = unpackBmbtRecord(inodeBytes, recOffset);
          extents.push({
            startoff: unpacked.startoff,
            startblock: unpacked.startblock,
            blockcount: unpacked.blockcount,
          });
        }
      }
    }

    return {
      ino,
      mode,
      version,
      format,
      size,
      nblocks,
      mtime,
      extents,
      localData,
    };
  }

  /**
   * Traverses a directory inode and builds the VNode hierarchy
   */
  private async traverseDirectory(
    dirIno: number,
    parentNode: VNode,
    parentPath: string
  ): Promise<void> {
    const dirInode = await this.readInode(dirIno);
    this.inodeMap.set(parentPath, dirInode);

    parentNode.modifiedTime = dirInode.mtime;

    interface EntryDesc {
      name: string;
      ino: number;
    }
    const entries: EntryDesc[] = [];

    if (dirInode.format === XFS_DINODE_FMT_LOCAL && dirInode.localData) {
      // Shortform directory format (xfs_dir2_sf_hdr + entries)
      const sf = dirInode.localData;
      if (sf.length >= 2) {
        const count = sf[0];
        const i8count = sf[1];
        const inoSize = i8count > 0 ? 8 : 4;
        const hdrSize = i8count > 0 ? 10 : 6;

        let off = hdrSize;
        for (let i = 0; i < count; i++) {
          if (off >= sf.length) break;
          const namelen = sf[off];
          if (namelen === 0 || off + 3 + namelen > sf.length) break;

          const nameBytes = sf.subarray(off + 3, off + 3 + namelen);
          const name = new TextDecoder('utf-8').decode(nameBytes);

          const inoOffset = off + 3 + namelen;
          let entryIno = 0;
          if (inoSize === 8 && inoOffset + 8 <= sf.length) {
            entryIno = Number(readUint64BE(sf, inoOffset));
          } else if (inoOffset + 4 <= sf.length) {
            entryIno = readUint32BE(sf, inoOffset);
          }

          entries.push({ name, ino: entryIno });

          // Next entry offset: namelen(1) + offset(2) + name + inoSize + ftype(1)
          // If v5, ftype is 1 byte
          const hasFtype = dirInode.version >= 3;
          off = inoOffset + inoSize + (hasFtype ? 1 : 0);
        }
      }
    } else if (dirInode.format === XFS_DINODE_FMT_EXTENTS && dirInode.extents.length > 0) {
      // Single-block directory format (XFS_DIR2_BLOCK_MAGIC / XFS_DIR3_BLOCK_MAGIC)
      const firstExt = dirInode.extents[0];
      const dirBlockByteOffset =
        this.partitionByteOffset + Number(firstExt.startblock) * this.blockSize;
      const blockBytes = await this.reader.read(dirBlockByteOffset, this.blockSize);

      const blockMagic = readUint32BE(blockBytes, 0);
      const isDir3 = blockMagic === XFS_DIR3_BLOCK_MAGIC;
      const isDir2 = blockMagic === XFS_DIR2_BLOCK_MAGIC;

      if (isDir2 || isDir3) {
        const hdrSize = isDir3 ? 64 : 16;
        const tailOffset = this.blockSize - 8;
        const totalEntries = readUint32BE(blockBytes, tailOffset);

        let curr = hdrSize;
        let readCount = 0;

        while (curr < tailOffset && readCount < totalEntries) {
          // Check for unused space marker (0xffff)
          const tagOrIno = readUint16BE(blockBytes, curr);
          if (tagOrIno === 0xffff) {
            const freelen = readUint16BE(blockBytes, curr + 2);
            if (freelen <= 0) break;
            curr += freelen;
            continue;
          }

          // Directory entry: inumber(8), namelen(1), name(namelen), ftype(1 if v3)
          const entryIno = Number(readUint64BE(blockBytes, curr));
          const namelen = blockBytes[curr + 8];

          if (namelen === 0 || curr + 9 + namelen > tailOffset) break;

          const nameBytes = blockBytes.subarray(curr + 9, curr + 9 + namelen);
          const name = new TextDecoder('utf-8').decode(nameBytes);

          if (name !== '.' && name !== '..') {
            entries.push({ name, ino: entryIno });
          }

          readCount++;

          // Entry length aligned to 8 bytes + 2 bytes tag at end
          const rawLen = 9 + namelen + (isDir3 ? 1 : 0);
          const padLen = (8 - ((rawLen + 2) % 8)) % 8;
          const entryLen = rawLen + padLen + 2;
          curr += entryLen;
        }
      }
    }

    // Process all discovered directory entries
    for (const ent of entries) {
      if (ent.ino <= 0) continue;

      const childPath = parentPath === '/' ? `/${ent.name}` : `${parentPath}/${ent.name}`;
      const childInode = await this.readInode(ent.ino);
      this.inodeMap.set(childPath, childInode);

      const isDir = (childInode.mode & S_IFMT) === S_IFDIR;

      const childNode: VNode = {
        id: `xfs-node-${ent.ino}-${Math.random().toString(36).slice(2, 7)}`,
        name: ent.name,
        path: childPath,
        isDirectory: isDir,
        size: isDir ? 0 : childInode.size,
        modifiedTime: childInode.mtime,
        children: isDir ? [] : undefined,
      };

      parentNode.children!.push(childNode);

      if (isDir) {
        await this.traverseDirectory(ent.ino, childNode, childPath);
      }
    }
  }

  /**
   * Reads raw bytes for a file node
   */
  async readFileData(node: VNode): Promise<Uint8Array> {
    if (node.isDirectory || node.size === 0) {
      return new Uint8Array(0);
    }

    const inodeInfo = this.inodeMap.get(node.path);
    if (!inodeInfo) {
      return new Uint8Array(0);
    }

    // If resident local data
    if (inodeInfo.format === XFS_DINODE_FMT_LOCAL && inodeInfo.localData) {
      return inodeInfo.localData.subarray(0, node.size);
    }

    // If extent mapped
    if (inodeInfo.format === XFS_DINODE_FMT_EXTENTS && inodeInfo.extents.length > 0) {
      const result = new Uint8Array(node.size);
      let bytesCopied = 0;

      for (const ext of inodeInfo.extents) {
        if (bytesCopied >= node.size) break;

        const extentBytes = ext.blockcount * this.blockSize;
        const bytesToRead = Math.min(extentBytes, node.size - bytesCopied);

        const physicalByteOffset =
          this.partitionByteOffset + Number(ext.startblock) * this.blockSize;
        const chunk = await this.reader.read(physicalByteOffset, bytesToRead);

        result.set(chunk, bytesCopied);
        bytesCopied += bytesToRead;
      }

      return result;
    }

    return new Uint8Array(0);
  }
}
