// High-performance XFS v5 volume builder
// Creates Linux enterprise compatible XFS partitions with multi-AG layout,
// self-describing v5 CRC metadata, shortform and block directories, and bmbt extents.
import { ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import { IFileSystemBuilder, PartitionBuilderOptions } from '../filesystem/fs-types';
import {
  computeCrc32c,
  packBmbtRecord,
  S_IFDIR,
  S_IFREG,
  writeUint16BE,
  writeUint32BE,
  writeUint32LE,
  writeUint64BE,
  XFS_ABTB_CRC_MAGIC,
  XFS_ABTC_CRC_MAGIC,
  XFS_AGF_MAGIC,
  XFS_AGFL_MAGIC,
  XFS_AGI_MAGIC,
  XFS_DEFAULT_BLOCK_SIZE,
  XFS_DEFAULT_INODE_SIZE,
  XFS_DINODE_FMT_EXTENTS,
  XFS_DINODE_FMT_LOCAL,
  XFS_DINODE_MAGIC,
  XFS_DIR3_BLOCK_MAGIC,
  XFS_DIR3_FT_DIR,
  XFS_DIR3_FT_REG_FILE,
  XFS_FIBT_CRC_MAGIC,
  XFS_IBT_CRC_MAGIC,
  XFS_SB_FEAT_INCOMPAT_FTYPE,
  XFS_SB_MAGIC,
  XFS_SB_VERSION_5,
  XFS_SB_VERSION_MOREBITSBIT,
  XFS_SB_VERSION2_ATTR2BIT,
  XFS_SB_VERSION2_CRCBIT,
  XFS_SB_VERSION2_FTYPE,
  XFS_SB_VERSION2_LAZYSBCOUNTBIT,
  XFS_SB_VERSION2_PROJID32BIT,
  XFS_SECTOR_SIZE,
} from './xfs-types';

interface FileAllocation {
  node: VNode;
  ino: number;
  isDir: boolean;
  size: number;
  data?: Uint8Array;
  startBlock?: number;
  blockCount?: number;
  children?: FileAllocation[];
  parentIno: number;
}

export class XfsBuilder implements IFileSystemBuilder {
  private root: VNode;
  private volumeLabel: string;
  private totalSectors: number;
  private partitionStartSector: number;
  private padToCapacity: boolean;
  private uuid: Uint8Array;

  constructor(root: VNode, options: PartitionBuilderOptions) {
    this.root = root;
    this.volumeLabel = (options.volumeLabel || 'XFS_DISK').slice(0, 12);
    this.totalSectors = Math.max(32768, options.partitionSectors); // Min 16MB
    this.partitionStartSector = options.partitionStartSector ?? 0;
    this.padToCapacity = options.padToCapacity ?? false;

    // Generate deterministic or random UUID (16 bytes)
    this.uuid = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(this.uuid);
    } else {
      for (let i = 0; i < 16; i++) this.uuid[i] = (i * 37 + 0x42) & 0xff;
    }
  }

  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    onProgress?.(0.05, 'Calculating XFS geometry and allocation groups...');

    const blockSize = XFS_DEFAULT_BLOCK_SIZE; // 4096
    const inodeSize = XFS_DEFAULT_INODE_SIZE; // 512
    const inopblock = blockSize / inodeSize; // 8
    const inopblog = 3; // log2(8)
    const blocklog = 12; // log2(4096)
    const sectlog = 9; // log2(512)
    const inodelog = 9; // log2(512)

    const totalBlocks = Math.floor((this.totalSectors * XFS_SECTOR_SIZE) / blockSize);

    // Number of AGs (4 standard for XFS, or 1 if volume < 64MB)
    const agCount = totalBlocks >= 16384 ? 4 : totalBlocks >= 8192 ? 2 : 1;
    const agBlocks = Math.floor(totalBlocks / agCount);
    const agblklog = Math.ceil(Math.log2(agBlocks));

    // Layout within each AG (relative block numbers):
    // Block 0: Superblock (1 sector used, sector 0)
    // Block 1: AGF (1 sector used, sector 0)
    // Block 2: AGI (1 sector used, sector 0)
    // Block 3: AGFL (1 sector used, sector 0)
    // Block 4: bnobt root
    // Block 5: cntbt root
    // Block 6: inobt root
    // Block 7: finobt root
    // Block 8..15: Reserved / Alignment
    // Block 16..23: Inode chunk (64 inodes = 8 blocks of 4096 bytes)
    // Root inode: First inode of AG 0 inode chunk
    // Inode number = (agno << (agblklog + inopblog)) | (agbno << inopblog) | offset_in_block
    // For AG 0, block 16: rootIno = (0 << ...) | (16 << 3) | 0 = 128
    const inodeChunkStartBlock = 16;
    const inodeChunkBlocks = 8; // 64 inodes * 512 bytes = 32,768 bytes = 8 blocks
    const rootIno = (inodeChunkStartBlock << inopblog); // 128

    onProgress?.(0.15, 'Preparing directory tree and file allocations...');

    // Traverse directory tree and assign inodes & data blocks
    let nextInoOffset = 0; // offset within the 64-inode chunk
    let nextDataBlock = inodeChunkStartBlock + inodeChunkBlocks; // starts at block 24

    const allocs: FileAllocation[] = [];
    const blockDataMap = new Map<number, Uint8Array>();

    const assignAllocations = async (
      node: VNode,
      parentIno: number
    ): Promise<FileAllocation> => {
      const currentIno = rootIno + nextInoOffset;
      nextInoOffset++;

      const isDir = node.isDirectory;
      const alloc: FileAllocation = {
        node,
        ino: currentIno,
        isDir,
        size: 0,
        parentIno,
        children: [],
      };
      allocs.push(alloc);

      if (isDir) {
        for (const child of node.children || []) {
          const childAlloc = await assignAllocations(child, currentIno);
          alloc.children!.push(childAlloc);
        }
      } else {
        // Read file bytes
        let fileBytes: Uint8Array;
        if (node.data) {
          fileBytes = node.data;
        } else if (node.fileRef) {
          fileBytes = new Uint8Array(await node.fileRef.arrayBuffer());
        } else {
          fileBytes = new Uint8Array(0);
        }
        alloc.size = fileBytes.byteLength;
        alloc.data = fileBytes;

        if (fileBytes.byteLength > 0) {
          const blocksNeeded = Math.ceil(fileBytes.byteLength / blockSize);
          alloc.startBlock = nextDataBlock;
          alloc.blockCount = blocksNeeded;

          for (let b = 0; b < blocksNeeded; b++) {
            const blkBytes = new Uint8Array(blockSize);
            const sliceStart = b * blockSize;
            const sliceEnd = Math.min(sliceStart + blockSize, fileBytes.byteLength);
            blkBytes.set(fileBytes.subarray(sliceStart, sliceEnd), 0);
            blockDataMap.set(nextDataBlock + b, blkBytes);
          }
          nextDataBlock += blocksNeeded;
        }
      }

      return alloc;
    };

    const rootAlloc = await assignAllocations(this.root, rootIno);

    // Build directory blocks for directories that exceed shortform size
    for (const alloc of allocs) {
      if (!alloc.isDir) continue;

      // Estimate shortform size: 10 bytes header + sum(3 + name.length + 8 + 1)
      let sfSize = 10;
      for (const child of alloc.children || []) {
        const nameBytes = new TextEncoder().encode(child.node.name);
        sfSize += 3 + nameBytes.length + 8 + 1; // namelen(1) + offset(2) + name + ino(8) + ftype(1)
      }

      // Inode literal area in v5 inode is 512 - 176 = 336 bytes
      if (sfSize > 336) {
        // Create single block directory (Form 2 / XFS_DIR3_BLOCK_MAGIC)
        const dirBlockNum = nextDataBlock++;
        alloc.startBlock = dirBlockNum;
        alloc.blockCount = 1;
        alloc.size = blockSize;

        const dirBlock = this.createDir3Block(
          alloc.ino,
          alloc.parentIno,
          alloc.children || [],
          blockSize,
          dirBlockNum
        );
        blockDataMap.set(dirBlockNum, dirBlock);
      }
    }

    onProgress?.(0.35, 'Writing Superblock, AG Headers and Inode table...');

    // Create the inode table buffer for the 64-inode chunk (8 blocks = 32768 bytes)
    const inodeTableBytes = new Uint8Array(inodeChunkBlocks * blockSize);
    for (const alloc of allocs) {
      const inoOffset = alloc.ino - rootIno;
      if (inoOffset >= 64) {
        throw new Error('Directory tree exceeds initial 64 inode chunk capacity in XFS builder');
      }
      const inodeByteOffset = inoOffset * inodeSize;
      const inodeBuf = this.createInode(alloc, inodeSize);
      inodeTableBytes.set(inodeBuf, inodeByteOffset);
    }

    for (let b = 0; b < inodeChunkBlocks; b++) {
      const blk = inodeTableBytes.subarray(b * blockSize, (b + 1) * blockSize);
      blockDataMap.set(inodeChunkStartBlock + b, new Uint8Array(blk));
    }

    // Free block tracking in AG 0
    const ag0UsedBlocks = nextDataBlock;
    const ag0FreeBlocks = agBlocks - ag0UsedBlocks;

    // Create AG 0 metadata blocks
    const sb0 = this.createSuperblock(
      0,
      totalBlocks,
      agBlocks,
      agCount,
      rootIno,
      blockSize,
      sectlog,
      blocklog,
      inodelog,
      inopblog,
      agblklog
    );
    const agf0 = this.createAgf(0, agBlocks, ag0FreeBlocks, ag0UsedBlocks);
    const agi0 = this.createAgi(0, agBlocks, allocs.length, 64 - allocs.length, rootIno);
    const agfl0 = this.createAgfl(0);
    const bnobt0 = this.createBnobt(0, ag0UsedBlocks, ag0FreeBlocks);
    const cntbt0 = this.createCntbt(0, ag0UsedBlocks, ag0FreeBlocks);
    const inobt0 = this.createInobt(0, 0, allocs.length);
    const finobt0 = this.createFinobt(0, 0, allocs.length);

    blockDataMap.set(0, sb0);
    blockDataMap.set(1, agf0);
    blockDataMap.set(2, agi0);
    blockDataMap.set(3, agfl0);
    blockDataMap.set(4, bnobt0);
    blockDataMap.set(5, cntbt0);
    blockDataMap.set(6, inobt0);
    blockDataMap.set(7, finobt0);

    // Initialize secondary AGs if agCount > 1
    for (let ag = 1; ag < agCount; ag++) {
      const agStartBlock = ag * agBlocks;
      const sbAg = this.createSuperblock(
        ag,
        totalBlocks,
        agBlocks,
        agCount,
        rootIno,
        blockSize,
        sectlog,
        blocklog,
        inodelog,
        inopblog,
        agblklog
      );
      const agFreeBlocks = agBlocks - 8;
      const agfAg = this.createAgf(ag, agBlocks, agFreeBlocks, 8);
      const agiAg = this.createAgi(ag, agBlocks, 0, 0, 0);
      const agflAg = this.createAgfl(ag);
      const bnobtAg = this.createBnobt(ag, 8, agFreeBlocks);
      const cntbtAg = this.createCntbt(ag, 8, agFreeBlocks);
      const inobtAg = this.createInobt(ag, 0, 0);
      const finobtAg = this.createFinobt(ag, 0, 0);

      blockDataMap.set(agStartBlock + 0, sbAg);
      blockDataMap.set(agStartBlock + 1, agfAg);
      blockDataMap.set(agStartBlock + 2, agiAg);
      blockDataMap.set(agStartBlock + 3, agflAg);
      blockDataMap.set(agStartBlock + 4, bnobtAg);
      blockDataMap.set(agStartBlock + 5, cntbtAg);
      blockDataMap.set(agStartBlock + 6, inobtAg);
      blockDataMap.set(agStartBlock + 7, finobtAg);
    }

    // Stream blocks sequentially
    onProgress?.(0.6, 'Streaming XFS filesystem blocks...');
    const highestBlock = this.padToCapacity
      ? totalBlocks - 1
      : Math.max(...Array.from(blockDataMap.keys()));

    const zeroBlock = new Uint8Array(blockSize);
    for (let blkIdx = 0; blkIdx <= highestBlock; blkIdx++) {
      const data = blockDataMap.get(blkIdx) || zeroBlock;
      await writer.write(data);

      if (blkIdx % 256 === 0) {
        onProgress?.(0.6 + (blkIdx / highestBlock) * 0.38, 'Streaming XFS partition blocks...');
      }
    }

    onProgress?.(1.0, 'XFS filesystem build complete.');
  }

  private createSuperblock(
    agno: number,
    dblocks: number,
    agblocks: number,
    agcount: number,
    rootino: number,
    blocksize: number,
    sectlog: number,
    blocklog: number,
    inodelog: number,
    inopblog: number,
    agblklog: number
  ): Uint8Array {
    const buf = new Uint8Array(blocksize);

    writeUint32BE(buf, 0, XFS_SB_MAGIC);
    writeUint32BE(buf, 4, blocksize);
    writeUint64BE(buf, 8, dblocks);
    writeUint64BE(buf, 16, 0); // rblocks
    writeUint64BE(buf, 24, 0); // rextents
    buf.set(this.uuid, 32); // uuid (16 bytes)
    writeUint64BE(buf, 48, 0); // logstart (0 = internal/unallocated for simple mkfs)
    writeUint64BE(buf, 56, rootino); // rootino
    writeUint64BE(buf, 64, 0); // rbmino
    writeUint64BE(buf, 72, 0); // rsumino
    writeUint32BE(buf, 80, 0); // rextsize
    writeUint32BE(buf, 84, agblocks);
    writeUint32BE(buf, 88, agcount);
    writeUint32BE(buf, 92, 0); // rbmblocks
    writeUint32BE(buf, 96, 0); // logblocks

    // sb_versionnum: v5 + morebits
    const versionnum = XFS_SB_VERSION_5 | XFS_SB_VERSION_MOREBITSBIT;
    writeUint16BE(buf, 100, versionnum);
    writeUint16BE(buf, 102, XFS_SECTOR_SIZE); // sectsize
    writeUint16BE(buf, 104, XFS_DEFAULT_INODE_SIZE); // inodesize
    writeUint16BE(buf, 106, blocksize / XFS_DEFAULT_INODE_SIZE); // inopblock (8)

    // sb_fname (12 chars max)
    const labelBytes = new TextEncoder().encode(this.volumeLabel);
    buf.set(labelBytes.subarray(0, 12), 108);

    buf[120] = blocklog; // blocklog (12)
    buf[121] = sectlog; // sectlog (9)
    buf[122] = inodelog; // inodelog (9)
    buf[123] = inopblog; // inopblog (3)
    buf[124] = agblklog; // agblklog
    buf[125] = 0; // rextslog
    buf[126] = 0; // inprogress
    buf[127] = 25; // imax_pct (25%)

    writeUint64BE(buf, 128, 64); // icount (64 inodes allocated)
    writeUint64BE(buf, 136, 63); // ifree
    writeUint64BE(buf, 144, dblocks - 32); // fdblocks
    writeUint64BE(buf, 152, 0); // frextents

    writeUint64BE(buf, 160, 0); // uquotino
    writeUint64BE(buf, 168, 0); // gquotino
    writeUint16BE(buf, 176, 0); // qflags
    buf[178] = 0; // flags
    buf[179] = 0; // shared_vn
    writeUint32BE(buf, 180, 0); // inoalignmt
    writeUint32BE(buf, 184, 0); // unit
    writeUint32BE(buf, 188, 0); // width
    buf[192] = 0; // dirblklog
    buf[193] = sectlog; // logsectlog
    writeUint16BE(buf, 194, XFS_SECTOR_SIZE); // logsectsize
    writeUint32BE(buf, 196, 0); // logsunit

    // sb_features2: CRC, FTYPE, ATTR2, PROJID32, LAZYSBCOUNT
    const feat2 =
      XFS_SB_VERSION2_CRCBIT |
      XFS_SB_VERSION2_FTYPE |
      XFS_SB_VERSION2_ATTR2BIT |
      XFS_SB_VERSION2_PROJID32BIT |
      XFS_SB_VERSION2_LAZYSBCOUNTBIT;
    writeUint32BE(buf, 200, feat2);
    writeUint32BE(buf, 204, feat2); // bad_features2

    // v5 features
    writeUint32BE(buf, 208, 0); // features_compat
    writeUint32BE(buf, 212, 0); // features_ro_compat
    writeUint32BE(buf, 216, XFS_SB_FEAT_INCOMPAT_FTYPE); // features_incompat (ftype)
    writeUint32BE(buf, 220, 0); // features_log_incompat

    // sb_crc at offset 224 (LE)
    writeUint32LE(buf, 224, 0); // zero before CRC calculation
    writeUint32BE(buf, 228, 0); // spino_align
    writeUint64BE(buf, 232, 0); // pquotino
    writeUint64BE(buf, 240, 1); // lsn
    buf.set(this.uuid, 248); // meta_uuid

    // Calculate CRC32c over the sector (0..512)
    const crc = computeCrc32c(buf, 0, XFS_SECTOR_SIZE);
    writeUint32LE(buf, 224, crc);

    return buf;
  }

  private createAgf(
    agno: number,
    agblocks: number,
    freeblocks: number,
    usedblocks: number
  ): Uint8Array {
    const buf = new Uint8Array(XFS_DEFAULT_BLOCK_SIZE);
    writeUint32BE(buf, 0, XFS_AGF_MAGIC);
    writeUint32BE(buf, 4, 1); // versionnum = 1
    writeUint32BE(buf, 8, agno); // seqno
    writeUint32BE(buf, 12, agblocks); // length
    writeUint32BE(buf, 16, 4); // bno_root = block 4
    writeUint32BE(buf, 20, 5); // cnt_root = block 5
    writeUint32BE(buf, 24, 0); // rmap_root
    writeUint32BE(buf, 28, 1); // bno_level = 1
    writeUint32BE(buf, 32, 1); // cnt_level = 1
    writeUint32BE(buf, 36, 0); // rmap_level
    writeUint32BE(buf, 40, 0); // flfirst
    writeUint32BE(buf, 44, 0); // fllast
    writeUint32BE(buf, 48, 0); // flcount
    writeUint32BE(buf, 52, freeblocks); // freeblks
    writeUint32BE(buf, 56, freeblocks); // longest
    writeUint32BE(buf, 60, 2); // btreeblks (bnobt + cntbt)
    buf.set(this.uuid, 64); // uuid (16 bytes)

    // v5 crc at offset 80 (LE)
    writeUint32LE(buf, 80, 0);
    writeUint64BE(buf, 84, 1); // lsn

    const crc = computeCrc32c(buf, 0, XFS_SECTOR_SIZE);
    writeUint32LE(buf, 80, crc);

    return buf;
  }

  private createAgi(
    agno: number,
    agblocks: number,
    allocInodes: number,
    freeInodes: number,
    rootino: number
  ): Uint8Array {
    const buf = new Uint8Array(XFS_DEFAULT_BLOCK_SIZE);
    writeUint32BE(buf, 0, XFS_AGI_MAGIC);
    writeUint32BE(buf, 4, 1); // versionnum = 1
    writeUint32BE(buf, 8, agno); // seqno
    writeUint32BE(buf, 12, agblocks); // length
    writeUint32BE(buf, 16, allocInodes); // count
    writeUint32BE(buf, 20, 6); // root = block 6 (inobt)
    writeUint32BE(buf, 24, 1); // level = 1
    writeUint32BE(buf, 28, freeInodes); // freecount
    writeUint32BE(buf, 32, rootino); // newino
    writeUint32BE(buf, 36, 0); // dirino

    // unlinked hash table (64 entries of 0xffffffff)
    for (let i = 0; i < 64; i++) {
      writeUint32BE(buf, 40 + i * 4, 0xffffffff);
    }

    buf.set(this.uuid, 296); // uuid
    writeUint32LE(buf, 312, 0); // crc
    writeUint32BE(buf, 316, 0); // pad
    writeUint64BE(buf, 320, 1); // lsn
    writeUint32BE(buf, 328, 7); // free_root = block 7 (finobt)
    writeUint32BE(buf, 332, 1); // free_level = 1

    const crc = computeCrc32c(buf, 0, XFS_SECTOR_SIZE);
    writeUint32LE(buf, 312, crc);

    return buf;
  }

  private createAgfl(agno: number): Uint8Array {
    const buf = new Uint8Array(XFS_DEFAULT_BLOCK_SIZE);
    writeUint32BE(buf, 0, XFS_AGFL_MAGIC);
    writeUint32BE(buf, 4, agno);
    buf.set(this.uuid, 8);
    writeUint64BE(buf, 24, 1); // lsn
    writeUint32LE(buf, 32, 0); // crc

    // fill freelist with 0xffffffff
    for (let i = 36; i < XFS_SECTOR_SIZE; i += 4) {
      writeUint32BE(buf, i, 0xffffffff);
    }

    const crc = computeCrc32c(buf, 0, XFS_SECTOR_SIZE);
    writeUint32LE(buf, 32, crc);

    return buf;
  }

  private createBnobt(agno: number, startBlock: number, blockCount: number): Uint8Array {
    const buf = new Uint8Array(XFS_DEFAULT_BLOCK_SIZE);
    writeUint32BE(buf, 0, XFS_ABTB_CRC_MAGIC);
    writeUint16BE(buf, 4, 0); // level = 0 (leaf)
    writeUint16BE(buf, 6, 1); // numrecs = 1
    writeUint32BE(buf, 8, 0xffffffff); // left
    writeUint32BE(buf, 12, 0xffffffff); // right
    writeUint64BE(buf, 16, 4); // blkno (block 4)
    writeUint64BE(buf, 24, 1); // lsn
    buf.set(this.uuid, 32);
    writeUint32BE(buf, 48, agno);
    writeUint32LE(buf, 52, 0); // crc

    // Record 0 at offset 56: startblock(4), blockcount(4)
    writeUint32BE(buf, 56, startBlock);
    writeUint32BE(buf, 60, blockCount);

    const crc = computeCrc32c(buf, 0, XFS_DEFAULT_BLOCK_SIZE);
    writeUint32LE(buf, 52, crc);

    return buf;
  }

  private createCntbt(agno: number, startBlock: number, blockCount: number): Uint8Array {
    const buf = new Uint8Array(XFS_DEFAULT_BLOCK_SIZE);
    writeUint32BE(buf, 0, XFS_ABTC_CRC_MAGIC);
    writeUint16BE(buf, 4, 0); // level = 0 (leaf)
    writeUint16BE(buf, 6, 1); // numrecs = 1
    writeUint32BE(buf, 8, 0xffffffff);
    writeUint32BE(buf, 12, 0xffffffff);
    writeUint64BE(buf, 16, 5); // blkno (block 5)
    writeUint64BE(buf, 24, 1); // lsn
    buf.set(this.uuid, 32);
    writeUint32BE(buf, 48, agno);
    writeUint32LE(buf, 52, 0); // crc

    // Record 0: startblock(4), blockcount(4)
    writeUint32BE(buf, 56, startBlock);
    writeUint32BE(buf, 60, blockCount);

    const crc = computeCrc32c(buf, 0, XFS_DEFAULT_BLOCK_SIZE);
    writeUint32LE(buf, 52, crc);

    return buf;
  }

  private createInobt(agno: number, startIno: number, count: number): Uint8Array {
    const buf = new Uint8Array(XFS_DEFAULT_BLOCK_SIZE);
    writeUint32BE(buf, 0, XFS_IBT_CRC_MAGIC);
    writeUint16BE(buf, 4, 0); // level = 0
    writeUint16BE(buf, 6, 1); // numrecs = 1
    writeUint32BE(buf, 8, 0xffffffff);
    writeUint32BE(buf, 12, 0xffffffff);
    writeUint64BE(buf, 16, 6); // blkno
    writeUint64BE(buf, 24, 1);
    buf.set(this.uuid, 32);
    writeUint32BE(buf, 48, agno);
    writeUint32LE(buf, 52, 0); // crc

    // Inode record 0: startino(4), freecount(4), free(8 bytes bitmap)
    writeUint32BE(buf, 56, startIno);
    writeUint32BE(buf, 60, 64 - count); // freecount
    // Bitmap: 1 bit per inode, 1 = free, 0 = allocated
    // For allocated inodes 0..count-1, bits are 0. Remaining bits are 1.
    const freeMask = count >= 64 ? 0n : ~((1n << BigInt(count)) - 1n);
    writeUint64BE(buf, 64, freeMask);

    const crc = computeCrc32c(buf, 0, XFS_DEFAULT_BLOCK_SIZE);
    writeUint32LE(buf, 52, crc);

    return buf;
  }

  private createFinobt(agno: number, startIno: number, count: number): Uint8Array {
    const buf = new Uint8Array(XFS_DEFAULT_BLOCK_SIZE);
    writeUint32BE(buf, 0, XFS_FIBT_CRC_MAGIC);
    writeUint16BE(buf, 4, 0);
    writeUint16BE(buf, 6, 1);
    writeUint32BE(buf, 8, 0xffffffff);
    writeUint32BE(buf, 12, 0xffffffff);
    writeUint64BE(buf, 16, 7);
    writeUint64BE(buf, 24, 1);
    buf.set(this.uuid, 32);
    writeUint32BE(buf, 48, agno);
    writeUint32LE(buf, 52, 0);

    writeUint32BE(buf, 56, startIno);
    writeUint32BE(buf, 60, 64 - count);
    const freeMask = count >= 64 ? 0n : ~((1n << BigInt(count)) - 1n);
    writeUint64BE(buf, 64, freeMask);

    const crc = computeCrc32c(buf, 0, XFS_DEFAULT_BLOCK_SIZE);
    writeUint32LE(buf, 52, crc);

    return buf;
  }

  private createInode(alloc: FileAllocation, inodeSize: number): Uint8Array {
    const buf = new Uint8Array(inodeSize);

    // Inode Core Header (176 bytes in v5)
    writeUint16BE(buf, 0, XFS_DINODE_MAGIC); // di_magic == 0x494e
    const mode = alloc.isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644;
    writeUint16BE(buf, 2, mode);
    buf[4] = 3; // di_version == 3 (v5)

    // Data fork format:
    // For directories with children fitting in 336 bytes: shortform (XFS_DINODE_FMT_LOCAL)
    // For large directories: extents (XFS_DINODE_FMT_EXTENTS)
    // For regular files: extents (XFS_DINODE_FMT_EXTENTS) or local if 0 bytes
    let format = XFS_DINODE_FMT_EXTENTS;
    if (alloc.isDir && !alloc.startBlock) {
      format = XFS_DINODE_FMT_LOCAL; // shortform directory
    }
    buf[5] = format;

    writeUint16BE(buf, 6, 0); // onlink
    writeUint32BE(buf, 8, 0); // uid
    writeUint32BE(buf, 12, 0); // gid
    writeUint32BE(buf, 16, alloc.isDir ? (alloc.children?.length || 0) + 2 : 1); // nlink
    writeUint16BE(buf, 20, 0); // projid_lo
    writeUint16BE(buf, 22, 0); // projid_hi
    writeUint16BE(buf, 24, 0); // pad

    // Timestamps
    const timeSec = Math.floor(alloc.node.modifiedTime.getTime() / 1000);
    writeUint32BE(buf, 32, timeSec); // atime
    writeUint32BE(buf, 36, 0); // atime nsec
    writeUint32BE(buf, 40, timeSec); // mtime
    writeUint32BE(buf, 44, 0); // mtime nsec
    writeUint32BE(buf, 48, timeSec); // ctime
    writeUint32BE(buf, 52, 0); // ctime nsec

    writeUint64BE(buf, 56, alloc.size); // di_size
    writeUint64BE(buf, 64, alloc.blockCount ? alloc.blockCount * 8 : 0); // di_nblocks (in 512-byte units)
    writeUint32BE(buf, 72, 0); // extsize
    writeUint32BE(buf, 76, alloc.blockCount ? 1 : 0); // nextents
    writeUint16BE(buf, 80, 0); // anextents
    buf[82] = 0; // forkoff
    buf[83] = 0; // aformat
    writeUint32BE(buf, 84, 0); // dmevmask
    writeUint16BE(buf, 88, 0); // dmstate
    writeUint16BE(buf, 90, 0); // flags

    // v5 Inode extensions (offset 100..176)
    writeUint32LE(buf, 100, 0); // di_crc (offset 100, LE)
    writeUint64BE(buf, 104, 1); // changecount
    writeUint64BE(buf, 112, 1); // lsn
    writeUint64BE(buf, 120, 0); // flags2
    buf.set(this.uuid, 144); // ino uuid
    writeUint64BE(buf, 160, alloc.ino); // di_ino (absolute inode number)

    // Data Fork starts at byte 176
    const dataFork = buf.subarray(176);

    if (alloc.isDir) {
      if (format === XFS_DINODE_FMT_LOCAL) {
        // Build Shortform Directory (xfs_dir2_sf_hdr + entries)
        const childCount = alloc.children?.length || 0;
        dataFork[0] = childCount; // count
        dataFork[1] = 1; // i8count = 1 (we use 8-byte inode numbers)
        writeUint64BE(dataFork, 2, alloc.parentIno); // parent[8]

        let sfOffset = 10;
        let entryTag = 0x20;
        for (const child of alloc.children || []) {
          const nameBytes = new TextEncoder().encode(child.node.name);
          dataFork[sfOffset] = nameBytes.length; // namelen
          writeUint16BE(dataFork, sfOffset + 1, entryTag); // offset
          dataFork.set(nameBytes, sfOffset + 3); // name
          writeUint64BE(dataFork, sfOffset + 3 + nameBytes.length, child.ino); // inumber (8 bytes)
          dataFork[sfOffset + 3 + nameBytes.length + 8] = child.isDir
            ? XFS_DIR3_FT_DIR
            : XFS_DIR3_FT_REG_FILE; // ftype

          sfOffset += 3 + nameBytes.length + 8 + 1;
          entryTag += 8;
        }
        writeUint64BE(buf, 56, sfOffset); // di_size reflects shortform byte length
      } else if (alloc.startBlock && alloc.blockCount) {
        // Extent pointing to directory block
        const bmbt = packBmbtRecord(0, alloc.startBlock, alloc.blockCount);
        dataFork.set(bmbt, 0);
      }
    } else {
      // Regular file extent
      if (alloc.startBlock && alloc.blockCount) {
        const bmbt = packBmbtRecord(0, alloc.startBlock, alloc.blockCount);
        dataFork.set(bmbt, 0);
      }
    }

    // Compute Inode CRC32c
    const crc = computeCrc32c(buf, 0, inodeSize);
    writeUint32LE(buf, 100, crc);

    return buf;
  }

  private createDir3Block(
    ino: number,
    parentIno: number,
    children: FileAllocation[],
    blockSize: number,
    blkno: number
  ): Uint8Array {
    const buf = new Uint8Array(blockSize);

    // xfs_dir3_data_hdr
    writeUint32BE(buf, 0, XFS_DIR3_BLOCK_MAGIC); // 0x58444233 'XDB3'
    writeUint32LE(buf, 4, 0); // crc
    writeUint64BE(buf, 8, blkno);
    writeUint64BE(buf, 16, 1); // lsn
    buf.set(this.uuid, 24);
    writeUint64BE(buf, 40, ino); // owner ino

    // Entries start at byte 64 (standard v3 header is 64 bytes)
    let currOffset = 64;

    const addEntry = (entryIno: number, name: string, ftype: number) => {
      const nameBytes = new TextEncoder().encode(name);
      const entryStart = currOffset;

      writeUint64BE(buf, currOffset, entryIno); // inumber
      buf[currOffset + 8] = nameBytes.length; // namelen
      buf.set(nameBytes, currOffset + 9); // name
      buf[currOffset + 9 + nameBytes.length] = ftype; // ftype

      // Tag offset at end, aligned to 8 bytes
      const rawLen = 9 + nameBytes.length + 1;
      const padLen = (8 - ((rawLen + 2) % 8)) % 8;
      const entryLen = rawLen + padLen + 2;

      writeUint16BE(buf, entryStart + entryLen - 2, entryStart); // tag (offset from block start)
      currOffset = entryStart + entryLen;
    };

    // '.' and '..' entries
    addEntry(ino, '.', XFS_DIR3_FT_DIR);
    addEntry(parentIno, '..', XFS_DIR3_FT_DIR);

    // Child entries
    for (const child of children) {
      addEntry(
        child.ino,
        child.node.name,
        child.isDir ? XFS_DIR3_FT_DIR : XFS_DIR3_FT_REG_FILE
      );
    }

    // Unused space marker up to leaf/tail at end of block
    const tailSize = 8; // xfs_dir2_block_tail (count: 4, stale: 4)
    const unusedStart = currOffset;
    const unusedLen = blockSize - tailSize - unusedStart;

    if (unusedLen > 0) {
      writeUint16BE(buf, unusedStart, 0xffff); // freetag
      writeUint16BE(buf, unusedStart + 2, unusedLen); // length
      writeUint16BE(buf, unusedStart + unusedLen - 2, unusedLen); // tag at end
    }

    // xfs_dir2_block_tail at end of block
    const tailOffset = blockSize - tailSize;
    writeUint32BE(buf, tailOffset, children.length + 2); // count
    writeUint32BE(buf, tailOffset + 4, 0); // stale

    // Calculate CRC32c
    const crc = computeCrc32c(buf, 0, blockSize);
    writeUint32LE(buf, 4, crc);

    return buf;
  }
}
