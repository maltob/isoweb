// Microsoft Virtual Hard Disk v2 (VHDX) specification types and CRC-32C utilities

export const VHDX_FILE_SIGNATURE = 'vhdxfile'; // 8 bytes ASCII at offset 0
export const VHDX_HEADER_SIGNATURE = 0x64616568; // 'head' in uint32 LE
export const VHDX_REGION_SIGNATURE = 0x69676572; // 'regi' in uint32 LE
export const VHDX_METADATA_SIGNATURE = 0x617461646174656dn; // 'metadata' in uint64 LE

export const VHDX_ALIGNMENT = 1048576; // 1 MB alignment for all major structures
export const VHDX_DEFAULT_BLOCK_SIZE = 1048576; // 1 MB payload block size
export const VHDX_LOGICAL_SECTOR_SIZE = 512;
export const VHDX_PHYSICAL_SECTOR_SIZE = 4096;

// VHDX Region Table Known GUIDs
export const GUID_BAT_REGION = '2DC27766-F623-4200-9D64-115E9BFD4A08';
export const GUID_METADATA_REGION = '8B7CA206-4790-4B9A-B8FE-575F050F886E';

// VHDX Metadata Known Item GUIDs
export const GUID_FILE_PARAMETERS = 'CAA16737-FA36-4D43-B3B6-33F0AA44E76B';
export const GUID_VIRTUAL_DISK_SIZE = '2FA54224-CD1B-4876-B211-5DBED83BF4B8';
export const GUID_PAGE_83_DATA = 'BE351647-C943-46D2-8BFF-A32E5D4FB838';
export const GUID_VIRTUAL_DISK_ID = 'BECA12AB-B2E6-4523-93EF-C309E000C746';
export const GUID_LOGICAL_SECTOR_SIZE = '8141BF1D-A96F-4709-BA47-F233A8FAAB5F';
export const GUID_PHYSICAL_SECTOR_SIZE = 'CDA348C7-445D-4471-9CC9-E9885251C556';

// BAT Payload Block States (Bits 0..2)
export enum VhdxPayloadBlockState {
  NotPresent = 0,
  Undefined = 1,
  Zero = 2,
  Unmapped = 3,
  FullyPresent = 6,
}

// BAT Sector Bitmap Block States (Bits 0..2)
export enum VhdxSectorBitmapBlockState {
  NotPresent = 0,
  Present = 6,
}

/**
 * Parses a standard canonical GUID string (e.g. "2DC27766-F623-4200-9D64-115E9BFD4A08")
 * into Windows mixed-endian 16-byte buffer (Data1 uint32 LE, Data2 uint16 LE, Data3 uint16 LE, Data4 8 bytes BE).
 */
export function guidToBytes(guidStr: string): Uint8Array {
  const clean = guidStr.replace(/-/g, '');
  if (clean.length !== 32) {
    throw new Error(`Invalid GUID string: "${guidStr}"`);
  }

  const bytes = new Uint8Array(16);
  // Data1: uint32 LE
  bytes[0] = parseInt(clean.slice(6, 8), 16);
  bytes[1] = parseInt(clean.slice(4, 6), 16);
  bytes[2] = parseInt(clean.slice(2, 4), 16);
  bytes[3] = parseInt(clean.slice(0, 2), 16);

  // Data2: uint16 LE
  bytes[4] = parseInt(clean.slice(10, 12), 16);
  bytes[5] = parseInt(clean.slice(8, 10), 16);

  // Data3: uint16 LE
  bytes[6] = parseInt(clean.slice(14, 16), 16);
  bytes[7] = parseInt(clean.slice(12, 14), 16);

  // Data4: 8 bytes BE
  for (let i = 0; i < 8; i++) {
    bytes[8 + i] = parseInt(clean.slice(16 + i * 2, 18 + i * 2), 16);
  }

  return bytes;
}

/**
 * Converts 16 bytes of Windows mixed-endian binary GUID back to standard canonical string.
 */
export function bytesToGuid(buf: Uint8Array, offset: number = 0): string {
  const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();

  // Data1 LE
  const d1 = hex(buf[offset + 3]) + hex(buf[offset + 2]) + hex(buf[offset + 1]) + hex(buf[offset + 0]);
  // Data2 LE
  const d2 = hex(buf[offset + 5]) + hex(buf[offset + 4]);
  // Data3 LE
  const d3 = hex(buf[offset + 7]) + hex(buf[offset + 6]);
  // Data4 BE
  const d4 = hex(buf[offset + 8]) + hex(buf[offset + 9]);
  let d5 = '';
  for (let i = 0; i < 6; i++) {
    d5 += hex(buf[offset + 10 + i]);
  }

  return `${d1}-${d2}-${d3}-${d4}-${d5}`;
}

/**
 * Generates a random standard UUID v4.
 */
export function generateRandomGuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx

  const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();
  return (
    hex(bytes[0]) + hex(bytes[1]) + hex(bytes[2]) + hex(bytes[3]) + '-' +
    hex(bytes[4]) + hex(bytes[5]) + '-' +
    hex(bytes[6]) + hex(bytes[7]) + '-' +
    hex(bytes[8]) + hex(bytes[9]) + '-' +
    hex(bytes[10]) + hex(bytes[11]) + hex(bytes[12]) + hex(bytes[13]) + hex(bytes[14]) + hex(bytes[15])
  );
}

// Pre-computed CRC-32C (Castagnoli with poly 0x1EDC6F41 / reflected 0x82F63B78) lookup table
const CRC32C_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) ? (crc >>> 1) ^ 0x82f63b78 : (crc >>> 1);
  }
  CRC32C_TABLE[i] = crc >>> 0;
}

/**
 * Computes CRC-32C (Castagnoli) checksum as specified by MS-VHDX.
 * Polynomial: 0x1EDC6F41 (bit-reversed 0x82F63B78).
 * Initial value: 0xFFFFFFFF, Final XOR: 0xFFFFFFFF.
 */
export function computeCrc32c(data: Uint8Array, offset: number = 0, length?: number): number {
  const len = length !== undefined ? length : data.length - offset;
  let crc = 0xffffffff;

  for (let i = 0; i < len; i++) {
    const byte = data[offset + i];
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export const vhdxCrc32c = computeCrc32c;
