import { describe, expect, it } from 'vitest';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';

describe('End-to-end Roundtrip Editing & Saving', () => {
  it('should roundtrip edit and preserve files in an ISO image', async () => {
    // 1. Create initial ISO
    const vfs1 = VirtualFS.createNew('iso', 'STAGE1');
    vfs1.addFile('/', 'FIRST.TXT', new TextEncoder().encode('Content of first file'));
    vfs1.createDirectory('/', 'SUBDIR');
    vfs1.addFile('/SUBDIR', 'NESTED.TXT', new TextEncoder().encode('Nested content'));

    const blob1 = await vfs1.buildImageBlob();

    // 2. Load blob back via DiskImageLoader
    const vfs2 = await DiskImageLoader.load(new BlobReader(blob1), 'stage1.iso');
    expect(vfs2.getFormat()).toBe('iso');
    expect(vfs2.findNode('/FIRST.TXT')).toBeDefined();
    expect(vfs2.findNode('/SUBDIR/NESTED.TXT')).toBeDefined();

    // Verify content from lazy reading
    const firstNode = vfs2.findNode('/FIRST.TXT')!;
    const firstBytes = await vfs2.getFileBytes(firstNode);
    expect(new TextDecoder().decode(firstBytes)).toBe('Content of first file');

    // 3. Edit: Add new file and delete an old file
    vfs2.addFile('/SUBDIR', 'SECOND.TXT', new TextEncoder().encode('Content of second file'));
    vfs2.deleteNode('/FIRST.TXT');

    // 4. Rebuild ISO
    const blob2 = await vfs2.buildImageBlob();

    // 5. Load rebuilt ISO back and verify changes
    const vfs3 = await DiskImageLoader.load(new BlobReader(blob2), 'stage2.iso');
    expect(vfs3.findNode('/FIRST.TXT')).toBeNull(); // was deleted
    expect(vfs3.findNode('/SUBDIR/NESTED.TXT')).toBeDefined(); // preserved
    expect(vfs3.findNode('/SUBDIR/SECOND.TXT')).toBeDefined(); // newly added

    const secondNode = vfs3.findNode('/SUBDIR/SECOND.TXT')!;
    const secondBytes = await vfs3.getFileBytes(secondNode);
    expect(new TextDecoder().decode(secondBytes)).toBe('Content of second file');
  });

  it('should preserve exact SHA-256 file hashes across ISO creation and extraction', async () => {
    const crypto = await import('crypto');
    const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

    const vfs = VirtualFS.createNew('iso', 'HASH_TEST');

    // 1. Zero-byte file
    const zeroBytes = new Uint8Array(0);
    const zeroHash = sha256(zeroBytes);
    vfs.addFile('/', 'EMPTY.DAT', zeroBytes);

    // 2. Small binary file
    const smallBytes = new Uint8Array(1234);
    for (let i = 0; i < smallBytes.length; i++) smallBytes[i] = (i * 37 + 13) & 0xff;
    const smallHash = sha256(smallBytes);
    vfs.addFile('/', 'SMALL.BIN', smallBytes);

    // 3. Medium file crossing sector boundary (e.g. 5000 bytes = 2 sectors + 904 bytes)
    const medBytes = new Uint8Array(5000);
    for (let i = 0; i < medBytes.length; i++) medBytes[i] = (i * 73 + 19) & 0xff;
    const medHash = sha256(medBytes);
    vfs.addFile('/', 'MEDIUM.BIN', medBytes);

    // 4. Large file crossing 2MB chunk buffer (2.5 MB)
    const largeBytes = new Uint8Array(2.5 * 1024 * 1024);
    for (let i = 0; i < largeBytes.length; i += 1024) {
      largeBytes[i] = (i & 0xff);
    }
    const largeHash = sha256(largeBytes);
    vfs.addFile('/', 'LARGE.BIN', largeBytes);

    // Build ISO
    const isoBlob = await vfs.buildImageBlob();

    // Load ISO back
    const vfsLoaded = await DiskImageLoader.load(new BlobReader(isoBlob), 'test.iso');

    // Verify empty file
    const emptyNode = vfsLoaded.findNode('/EMPTY.DAT')!;
    expect(emptyNode).toBeDefined();
    const loadedZeroBytes = await vfsLoaded.getFileBytes(emptyNode);
    expect(sha256(loadedZeroBytes)).toBe(zeroHash);

    // Verify small file
    const smallNode = vfsLoaded.findNode('/SMALL.BIN')!;
    expect(smallNode).toBeDefined();
    const loadedSmallBytes = await vfsLoaded.getFileBytes(smallNode);
    expect(sha256(loadedSmallBytes)).toBe(smallHash);

    // Verify medium file
    const medNode = vfsLoaded.findNode('/MEDIUM.BIN')!;
    expect(medNode).toBeDefined();
    const loadedMedBytes = await vfsLoaded.getFileBytes(medNode);
    expect(sha256(loadedMedBytes)).toBe(medHash);

    // Verify large file
    const largeNode = vfsLoaded.findNode('/LARGE.BIN')!;
    expect(largeNode).toBeDefined();
    const loadedLargeBytes = await vfsLoaded.getFileBytes(largeNode);
    expect(sha256(loadedLargeBytes)).toBe(largeHash);
  });

  it('should roundtrip edit and preserve files in a FAT12 floppy image', async () => {
    // 1. Create floppy
    const vfs1 = VirtualFS.createNew('fat12', 'BOOT_FLP');
    vfs1.addFile('/', 'AUTOEXEC.BAT', new TextEncoder().encode('@ECHO OFF\r\nPROMPT $P$G\r\n'));
    vfs1.createDirectory('/', 'BIN');
    vfs1.addFile('/BIN', 'TEST.COM', new Uint8Array([0xb8, 0x00, 0x4c, 0xcd, 0x21]));

    const blob1 = await vfs1.buildImageBlob();
    expect(blob1.size).toBe(1474560);

    // 2. Load blob back
    const vfs2 = await DiskImageLoader.load(new BlobReader(blob1), 'boot.img');
    expect(vfs2.getFormat()).toBe('fat12');
    expect(vfs2.findNode('/AUTOEXEC.BAT')).toBeDefined();
    expect(vfs2.findNode('/BIN/TEST.COM')).toBeDefined();

    // Verify bytes
    const batNode = vfs2.findNode('/AUTOEXEC.BAT')!;
    const batBytes = await vfs2.getFileBytes(batNode);
    expect(new TextDecoder().decode(batBytes)).toContain('@ECHO OFF');

    // 3. Add a file with Long File Name
    vfs2.addFile('/', 'A Very Long Document File Name.txt', new TextEncoder().encode('Long filename support in FAT'));

    // 4. Re-save
    const blob2 = await vfs2.buildImageBlob();
    expect(blob2.size).toBe(1474560);

    // 5. Load again and verify
    const vfs3 = await DiskImageLoader.load(new BlobReader(blob2), 'boot2.img');
    const lfnNode = vfs3.findNode('/A Very Long Document File Name.txt');
    expect(lfnNode).toBeDefined();

    const lfnBytes = await vfs3.getFileBytes(lfnNode!);
    expect(new TextDecoder().decode(lfnBytes)).toBe('Long filename support in FAT');
  });
});
