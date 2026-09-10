import { describe, expect, it } from 'vitest';
import { ExFatParser } from '../lib/exfat/exfat-parser';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VmdkParser } from '../lib/vmdk/vmdk-parser';
import { VMDK_MAGIC } from '../lib/vmdk/vmdk-types';

describe('exFAT Volume Builder and Parser', () => {
  it('should format an exFAT volume and parse files with long names', async () => {
    const vfs = VirtualFS.createNew('exfat', 'MY_EXFAT', '64'); // 64 MB
    vfs.addFile('/', 'GREETING.TXT', new TextEncoder().encode('Hello from browser exFAT engine!'));

    vfs.createDirectory('/', 'DOCS AND MEDIA');
    const docBytes = new TextEncoder().encode('Detailed documentation stored in modern exFAT volume.');
    vfs.addFile('/DOCS AND MEDIA', 'System Report 2026.log', docBytes);

    const blob = await vfs.buildImageBlob();
    expect(blob.size).toBe(64 * 1024 * 1024);

    const reader = new BlobReader(blob);
    const parser = new ExFatParser(reader);
    const { root, info } = await parser.parse();

    expect(info.format).toBe('exfat');
    expect(info.volumeLabel).toBe('MY_EXFAT');

    const greeting = root.children?.find((c) => c.name === 'GREETING.TXT');
    expect(greeting).toBeDefined();
    const greetingData = await parser.readFileData(greeting!);
    expect(new TextDecoder().decode(greetingData)).toBe('Hello from browser exFAT engine!');

    const docsDir = root.children?.find((c) => c.name === 'DOCS AND MEDIA');
    expect(docsDir).toBeDefined();
    expect(docsDir?.isDirectory).toBe(true);

    const reportFile = docsDir?.children?.find((c) => c.name === 'System Report 2026.log');
    expect(reportFile).toBeDefined();
    const reportData = await parser.readFileData(reportFile!);
    expect(new TextDecoder().decode(reportData)).toBe('Detailed documentation stored in modern exFAT volume.');
  });
});

describe('VMDK Virtual Disk Builder and Parser', () => {
  it('should build a monolithicSparse VMDK with FAT32 partition and verify sparse structures', async () => {
    const crypto = await import('crypto');
    const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

    const vfs = VirtualFS.createNew('vmdk-fat32', 'VM_DISK', '512'); // 512MB virtual disk
    const testPayload = new Uint8Array(16384);
    for (let i = 0; i < testPayload.length; i++) testPayload[i] = (i * 31 + 7) & 0xff;
    const testHash = sha256(testPayload);

    vfs.addFile('/', 'FIRMWARE.BIN', testPayload);
    vfs.createDirectory('/', 'EFI');
    vfs.addFile('/EFI', 'BOOTX64.EFI', new TextEncoder().encode('UEFI BOOTLOADER STUB'));

    // Build VMDK Blob
    const vmdkBlob = await vfs.buildImageBlob();

    // Sparse efficiency verification: a 512MB virtual disk with only ~16KB of files
    // must be compact (under 5MB on disk due to sparse unallocated grain omission)
    expect(vmdkBlob.size).toBeLessThan(5 * 1024 * 1024);
    expect(vmdkBlob.size).toBeGreaterThan(65536);

    // Verify VMDK Magic ('KDMV' = 0x564d444b)
    const reader = new BlobReader(vmdkBlob);
    const headerBytes = await reader.read(0, 512);
    const magic =
      (headerBytes[0] |
        (headerBytes[1] << 8) |
        (headerBytes[2] << 16) |
        (headerBytes[3] << 24)) >>>
      0;
    expect(magic).toBe(VMDK_MAGIC);

    // Parse VMDK back with VmdkParser
    const parser = new VmdkParser(reader);
    const { root, info } = await parser.parse();

    expect(info.format).toBe('vmdk-fat32');
    expect(info.formatName).toContain('VMDK');

    // Verify files inside VMDK
    const fwNode = root.children?.find((c) => c.name === 'FIRMWARE.BIN');
    expect(fwNode).toBeDefined();

    // Verify cryptographic SHA-256 hash preservation via DiskImageLoader & VmdkVirtualReader
    const vfsLoaded = await DiskImageLoader.load(reader, 'vm_test.vmdk');
    const loadedFwNode = vfsLoaded.findNode('/FIRMWARE.BIN')!;
    const extractedBytes = await vfsLoaded.getFileBytes(loadedFwNode);
    expect(sha256(extractedBytes)).toBe(testHash);

    const efiDir = vfsLoaded.findNode('/EFI');
    expect(efiDir).toBeDefined();
    const bootNode = vfsLoaded.findNode('/EFI/BOOTX64.EFI')!;
    expect(bootNode).toBeDefined();
    const bootBytes = await vfsLoaded.getFileBytes(bootNode);
    expect(new TextDecoder().decode(bootBytes)).toBe('UEFI BOOTLOADER STUB');
  });

  it('should build a monolithicSparse VMDK with exFAT partition', async () => {
    const vfs = VirtualFS.createNew('vmdk-exfat', 'EXFAT_VM', '1024'); // 1GB virtual disk
    vfs.addFile('/', 'DATA_FILE.DAT', new TextEncoder().encode('Content inside exFAT VMDK disk!'));

    const vmdkBlob = await vfs.buildImageBlob();
    expect(vmdkBlob.size).toBeLessThan(10 * 1024 * 1024); // Sparse, small

    const reader = new BlobReader(vmdkBlob);
    const vfsLoaded = await DiskImageLoader.load(reader, 'disk.vmdk');

    expect(vfsLoaded.getFormat()).toBe('vmdk-exfat');
    const dataNode = vfsLoaded.findNode('/DATA_FILE.DAT')!;
    expect(dataNode).not.toBeNull();
    const dataBytes = await vfsLoaded.getFileBytes(dataNode);
    expect(new TextDecoder().decode(dataBytes)).toBe('Content inside exFAT VMDK disk!');
  });
});
