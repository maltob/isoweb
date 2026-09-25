// XFS On-Disk Definitions and Constants
// Supporting XFS v5 (with v4 parser compatibility)
// References:
// - SGI / Linux Kernel Documentation: fs/xfs/libxfs/xfs_format.h & xfs_da_format.h
// - XFS Filesystem Structure Specification

export const XFS_SB_MAGIC = 0x58465342;       // 'XFSB'
export const XFS_AGF_MAGIC = 0x58414746;      // 'XAGF'
export const XFS_AGI_MAGIC = 0x58414749;      // 'XAGI'
export const XFS_AGFL_MAGIC = 0x5841464c;     // 'XAFL'
export const XFS_DINODE_MAGIC = 0x494e;       // 'IN'

// Directory Block Magics
export const XFS_DIR2_BLOCK_MAGIC = 0x58443242; // 'XD2B' (v2 single-block directory)
export const XFS_DIR2_DATA_MAGIC = 0x58443244;  // 'XD2D' (v2 data block)
export const XFS_DIR3_BLOCK_MAGIC = 0x58444233; // 'XDB3' (v3/v5 single-block directory with CRC)
export const XFS_DIR3_DATA_MAGIC = 0x58444433;  // 'XDD3' (v3/v5 data block with CRC)

// B-tree block magics
export const XFS_ABTB_CRC_MAGIC = 0x41423342;  // 'AB3B' (Free space by block number btree v5)
export const XFS_ABTC_CRC_MAGIC = 0x41423343;  // 'AB3C' (Free space by block count btree v5)
export const XFS_IBT_CRC_MAGIC = 0x49414233;   // 'IAB3' (Inode btree v5)
export const XFS_FIBT_CRC_MAGIC = 0x46494233;  // 'FIB3' (Free Inode btree v5)

// Log record constants
export const XLOG_HEADER_MAGIC_NUM = 0xfeedbabe;
export const XLOG_FMT_LINUX_LE = 1;
export const XLOG_FMT_LINUX_BE = 2;
export const XLOG_FMT = 1; // Default Linux Little-Endian
export const XFS_MIN_LOG_BLOCKS = 512; // 512 filesystem blocks (2MB at 4KB)
export const NULLFSINO = 0xffffffffffffffffn; // (xfs_ino_t)-1 null inode indicator
export const NULLAGINO = 0xffffffff; // (xfs_agino_t)-1 null AG inode indicator

// Standard Versions
export const XFS_SB_VERSION_4 = 4;
export const XFS_SB_VERSION_5 = 5;

// Feature flags for sb_versionnum (v4/v5)
export const XFS_SB_VERSION_ATTRBIT = 0x0010;
export const XFS_SB_VERSION_NLINKBIT = 0x0020;
export const XFS_SB_VERSION_QUOTABIT = 0x0040;
export const XFS_SB_VERSION_ALIGNBIT = 0x0080;
export const XFS_SB_VERSION_DALIGNBIT = 0x0100;
export const XFS_SB_VERSION_LOGV2BIT = 0x0400;
export const XFS_SB_VERSION_SECTORBIT = 0x0800;
export const XFS_SB_VERSION_EXTFLGBIT = 0x1000;
export const XFS_SB_VERSION_DIRV2BIT = 0x2000;
export const XFS_SB_VERSION_MOREBITSBIT = 0x8000;

// Mandatory sb_versionnum flags for XFS v5
export const XFS_SB_V5_VERS_FLAGS =
  XFS_SB_VERSION_5 |
  XFS_SB_VERSION_NLINKBIT |
  XFS_SB_VERSION_ALIGNBIT |
  XFS_SB_VERSION_LOGV2BIT |
  XFS_SB_VERSION_SECTORBIT |
  XFS_SB_VERSION_EXTFLGBIT |
  XFS_SB_VERSION_DIRV2BIT |
  XFS_SB_VERSION_MOREBITSBIT; // 0x3ca5

export const XFS_SB_VERSION2_LAZYSBCOUNTBIT = 0x00000002;
export const XFS_SB_VERSION2_ATTR2BIT = 0x00000008;
export const XFS_SB_VERSION2_PROJID32BIT = 0x00000080;
export const XFS_SB_VERSION2_CRCBIT = 0x00000100;
export const XFS_SB_VERSION2_FTYPE = 0x00000200;
export const XFS_SB_FEAT_RO_COMPAT_FINOBT = 1 << 0; // free inode btree
export const XFS_SB_FEAT_INCOMPAT_FTYPE = 1 << 0;

// Inode Constants
export const XFS_DINODE_FMT_DEV = 0;
export const XFS_DINODE_FMT_LOCAL = 1;   // inline resident data or shortform dir
export const XFS_DINODE_FMT_EXTENTS = 2; // extent list (bmbt records)
export const XFS_DINODE_FMT_BTREE = 3;   // btree root

// POSIX file modes
export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

// Directory file types for v3 / ftype
export const XFS_DIR3_FT_UNKNOWN = 0;
export const XFS_DIR3_FT_REG_FILE = 1;
export const XFS_DIR3_FT_DIR = 2;
export const XFS_DIR3_FT_CHRDEV = 3;
export const XFS_DIR3_FT_BLKDEV = 4;
export const XFS_DIR3_FT_FIFO = 5;
export const XFS_DIR3_FT_SOCK = 6;
export const XFS_DIR3_FT_SYMLINK = 7;
export const XFS_DIR3_FT_WHT = 8;

export const XFS_SECTOR_SIZE = 512;
export const XFS_DEFAULT_BLOCK_SIZE = 4096;
export const XFS_DEFAULT_INODE_SIZE = 512; // v5 default

// Castagnoli CRC32c lookup table (matching Linux kernel and VHDX)
const CRC32C_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) ? (crc >>> 1) ^ 0x82f63b78 : (crc >>> 1);
  }
  CRC32C_TABLE[i] = crc >>> 0;
}

export function computeCrc32c(data: Uint8Array, offset: number = 0, length?: number): number {
  const len = length !== undefined ? length : data.length - offset;
  let crc = 0xffffffff;
  for (let i = 0; i < len; i++) {
    const byte = data[offset + i];
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Byte order helper functions (XFS on-disk is Big Endian, except CRC which is Little Endian)
export function readUint16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 8) | buf[offset + 1]) >>> 0;
}

export function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  );
}

export function readUint64BE(buf: Uint8Array, offset: number): bigint {
  const high = BigInt(readUint32BE(buf, offset));
  const low = BigInt(readUint32BE(buf, offset + 4));
  return (high << 32n) | low;
}

export function writeUint16BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 8) & 0xff;
  buf[offset + 1] = val & 0xff;
}

export function writeUint32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

export function writeUint64BE(buf: Uint8Array, offset: number, val: bigint | number): void {
  const bigVal = typeof val === 'bigint' ? val : BigInt(val);
  const high = Number((bigVal >> 32n) & 0xffffffffn);
  const low = Number(bigVal & 0xffffffffn);
  writeUint32BE(buf, offset, high);
  writeUint32BE(buf, offset + 4, low);
}

export function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

export function writeUint32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
  buf[offset + 3] = (val >> 24) & 0xff;
}

/**
 * Packs an XFS B+tree extent record (128 bits / 16 bytes)
 * Bit 127: state (0 = normal, 1 = unwritten)
 * Bits 126..73: startoff (54 bits)
 * Bits 72..21: startblock (52 bits)
 * Bits 20..0: blockcount (21 bits)
 */
export function packBmbtRecord(
  startoff: number | bigint,
  startblock: number | bigint,
  blockcount: number,
  state: number = 0
): Uint8Array {
  const rec = new Uint8Array(16);
  const offBig = BigInt(startoff) & ((1n << 54n) - 1n);
  const blkBig = BigInt(startblock) & ((1n << 52n) - 1n);
  const countBig = BigInt(blockcount) & ((1n << 21n) - 1n);
  const stateBig = BigInt(state & 1);

  // l0: 64 bits = state(1) | startoff(54) | upper 9 bits of startblock
  const blkHigh9 = (blkBig >> 43n) & 0x1ffn;
  const l0 = (stateBig << 63n) | (offBig << 9n) | blkHigh9;

  // l1: 64 bits = lower 43 bits of startblock | blockcount(21)
  const blkLow43 = blkBig & ((1n << 43n) - 1n);
  const l1 = (blkLow43 << 21n) | countBig;

  writeUint64BE(rec, 0, l0);
  writeUint64BE(rec, 8, l1);
  return rec;
}

/**
 * Unpacks an XFS B+tree extent record
 */
export function unpackBmbtRecord(rec: Uint8Array, offset: number = 0): {
  startoff: bigint;
  startblock: bigint;
  blockcount: number;
  state: number;
} {
  const l0 = readUint64BE(rec, offset);
  const l1 = readUint64BE(rec, offset + 8);

  const state = Number((l0 >> 63n) & 1n);
  const startoff = (l0 >> 9n) & ((1n << 54n) - 1n);
  const blkHigh9 = l0 & 0x1ffn;
  const blkLow43 = (l1 >> 21n) & ((1n << 43n) - 1n);
  const startblock = (blkHigh9 << 43n) | blkLow43;
  const blockcount = Number(l1 & ((1n << 21n) - 1n));

  return { startoff, startblock, blockcount, state };
}
