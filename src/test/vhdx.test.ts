import { describe, expect, it } from 'vitest';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VhdxParser } from '../lib/vhdx/vhdx-parser';
import { vhdxCrc32c, VHDX_FILE_SIGNATURE } from '../lib/vhdx/vhdx-types';

describe('VHDX CRC-32C Castagnoli Checksum', () => {
  it('should match standard CRC-32C Castagnoli test vectors', () => {
    // Standard test vector: "123456789" -> 0xe3069283
    const testVector = new TextEncoder().encode('123456789');
    const crc = vhdxCrc32c(testVector);
    expect(crc).toBe(0xe3069283);

    // Empty buffer -> 0
    expect(vhdxCrc32c(new Uint8Array(0))).toBe(0);

    // 32 zeros -> 0x8a9136aa
    const thirtyTwoZeros = new Uint8Array(32);
    expect(vhdxCrc32c(thirtyTwoZeros)).toBe(0x8a9136aa);
  });
});

describe('VHDX Virtual Disk Builder and Parser', () => {
  it('should build a dynamic sparse VHDX with FAT32 partition and verify sparse structure and file roundtrip', async () => {
    const crypto = await import('crypto');
    const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

    const vfs = VirtualFS.createNew('vhdx-fat32', 'VHDX_TEST', '1024'); // 1 GB virtual capacity
    const testPayload = new Uint8Array(32768);
    for (let i = 0; i < testPayload.length; i++) {
      testPayload[i] = (i * 37 + 13) & 0xff;
    }
    const testHash = sha256(testPayload);

    vfs.addFile('/', 'PAYLOAD.DAT', testPayload);
    vfs.createDirectory('/', 'SYSTEM');
    vfs.addFile('/SYSTEM', 'CONFIG.SYS', new TextEncoder().encode('FILES=40\nBUFFERS=20\n'));

    // Build VHDX Blob
    const vhdxBlob = await vfs.buildImageBlob();

    // Sparse verification: 1 GB virtual disk should be a few megabytes on disk
    expect(vhdxBlob.size).toBeLessThan(10 * 1024 * 1024);
    expect(vhdxBlob.size).toBeGreaterThan(1024 * 1024); // Has headers, region tables, metadata, BAT, and active payload blocks

    // Verify File Type Identifier: "vhdxfile"
    const reader = new BlobReader(vhdxBlob);
    const idBytes = await reader.read(0, 8);
    const signature = new TextDecoder().decode(idBytes);
    expect(signature).toBe(VHDX_FILE_SIGNATURE);

    // Verify VhdxParser.isVhdx detects it
    const isVhdx = await VhdxParser.isVhdx(reader);
    expect(isVhdx).toBe(true);

    // Parse VHDX directly
    const parser = new VhdxParser(reader);
    const { root, info } = await parser.parse();

    expect(root.children?.length).toBeGreaterThan(0);
    expect(info.format).toBe('vhdx-fat32');
    expect(info.formatName).toContain('VHDX');
    expect(info.volumeLabel).toBe('VHDX_TEST');

    // Verify files through DiskImageLoader
    const vfsLoaded = await DiskImageLoader.load(reader, 'test_disk.vhdx');
    expect(vfsLoaded.getFormat()).toBe('vhdx-fat32');

    const payloadNode = vfsLoaded.findNode('/PAYLOAD.DAT');
    expect(payloadNode).toBeDefined();
    const loadedBytes = await vfsLoaded.getFileBytes(payloadNode!);
    expect(sha256(loadedBytes)).toBe(testHash);

    const cfgNode = vfsLoaded.findNode('/SYSTEM/CONFIG.SYS');
    expect(cfgNode).toBeDefined();
    const cfgBytes = await vfsLoaded.getFileBytes(cfgNode!);
    expect(new TextDecoder().decode(cfgBytes)).toBe('FILES=40\nBUFFERS=20\n');
  }, 30000);

  it('should build a dynamic sparse VHDX with exFAT partition and parse successfully', async () => {
    const vfs = VirtualFS.createNew('vhdx-exfat', 'HYPERV_EX', '2048'); // 2 GB virtual capacity
    vfs.addFile('/', 'EMPTY.LOG', new Uint8Array(0));
    vfs.addFile('/', 'LARGE_LOG.TXT', new TextEncoder().encode('Modern exFAT partition running on Microsoft VHDX!'));
    vfs.createDirectory('/', 'DOCUMENTS');
    vfs.addFile('/DOCUMENTS', 'Notes.md', new TextEncoder().encode('# VHDX Support\nFully browser-based.'));

    const vhdxBlob = await vfs.buildImageBlob();
    expect(vhdxBlob.size).toBeLessThan(15 * 1024 * 1024);

    const reader = new BlobReader(vhdxBlob);
    const vfsLoaded = await DiskImageLoader.load(reader, 'hyperv.vhdx');

    expect(vfsLoaded.getFormat()).toBe('vhdx-exfat');
    expect(vfsLoaded.getImageInfo().volumeLabel).toBe('HYPERV_EX');

    const emptyNode = vfsLoaded.findNode('/EMPTY.LOG');
    expect(emptyNode).toBeDefined();
    expect(emptyNode?.size).toBe(0);
    const emptyBytes = await vfsLoaded.getFileBytes(emptyNode!);
    expect(emptyBytes.byteLength).toBe(0);

    const logNode = vfsLoaded.findNode('/LARGE_LOG.TXT');
    expect(logNode).toBeDefined();
    const logBytes = await vfsLoaded.getFileBytes(logNode!);
    expect(new TextDecoder().decode(logBytes)).toBe('Modern exFAT partition running on Microsoft VHDX!');

    const notesNode = vfsLoaded.findNode('/DOCUMENTS/Notes.md');
    expect(notesNode).toBeDefined();
    const notesBytes = await vfsLoaded.getFileBytes(notesNode!);
    expect(new TextDecoder().decode(notesBytes)).toBe('# VHDX Support\nFully browser-based.');
  }, 30000);

  it('should generate MS-VHDX compliant metadata table entries and system flags', async () => {
    const vfs = VirtualFS.createNew('vhdx-fat32', 'TEST', '512');
    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);

    // Metadata region is at 1MB (0x100000)
    const metaHeader = await reader.read(0x100000, 32 + 5 * 32);
    // Verify signature 'metadata' (0x617461646174656dn)
    const sig = new DataView(metaHeader.buffer, metaHeader.byteOffset).getBigUint64(0, true);
    expect(sig).toBe(0x617461646174656dn);

    const entryCount = new DataView(metaHeader.buffer, metaHeader.byteOffset).getUint16(10, true);
    expect(entryCount).toBe(5);

    // Verify Entry 0: File Parameters (IsUser = 0, IsVirtualDisk = 0, IsRequired = 1 => Flags = 4)
    const view = new DataView(metaHeader.buffer, metaHeader.byteOffset);
    const entry0Flags = view.getUint32(32 + 0 * 32 + 24, true);
    expect(entry0Flags).toBe(4); // IsRequired only

    // Verify Entries 1..4: Virtual Disk items (IsUser = 0, IsVirtualDisk = 1, IsRequired = 1 => Flags = 6)
    for (let i = 1; i < 5; i++) {
      const entryFlags = view.getUint32(32 + i * 32 + 24, true);
      expect(entryFlags).toBe(6); // IsVirtualDisk | IsRequired
    }
  });
});
