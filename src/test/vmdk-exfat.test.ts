import { describe, expect, it } from 'vitest';
import { ExFatBuilder } from '../lib/exfat/exfat-builder';
import { ExFatParser } from '../lib/exfat/exfat-parser';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VmdkParser } from '../lib/vmdk/vmdk-parser';
import { VMDK_MAGIC } from '../lib/vmdk/vmdk-types';
import { VNode } from '../lib/types';

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

  it('should create exFAT with zero-byte files and valid upcase table compliance', async () => {
    const vfs = VirtualFS.createNew('exfat', 'COMPLIANT', '64');
    vfs.addFile('/', 'EMPTY.TXT', new Uint8Array(0));
    vfs.addFile('/', 'NORMAL.TXT', new TextEncoder().encode('Hello!'));

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);
    const parser = new ExFatParser(reader);
    const { root } = await parser.parse();

    const emptyFile = root.children?.find((c) => c.name === 'EMPTY.TXT');
    expect(emptyFile).toBeDefined();
    expect(emptyFile?.size).toBe(0);
    expect(emptyFile?.startCluster).toBe(0); // Zero-byte files must have startCluster = 0 per exFAT spec

    const emptyData = await parser.readFileData(emptyFile!);
    expect(emptyData.byteLength).toBe(0);

    // Verify Upcase Table entry in root dir
    // Root dir is at cluster 4. Cluster 2 is Bitmap, Cluster 3 is Upcase, Cluster 4 is Root.
    // Boot sector: byte 88 is clusterHeapSector (2048)
    const bootBytes = await reader.read(0, 512);
    const clusterHeapSector = bootBytes[88] | (bootBytes[89] << 8) | (bootBytes[90] << 16) | (bootBytes[91] << 24);
    const rootCluster = bootBytes[96] | (bootBytes[97] << 8) | (bootBytes[98] << 16) | (bootBytes[99] << 24);
    const secPerClus = 1 << bootBytes[109];
    const rootByteOffset = (clusterHeapSector + (rootCluster - 2) * secPerClus) * 512;
    const rootDirBytes = await reader.read(rootByteOffset, 4096);

    // Find Upcase Table Entry (type 0x82)
    let foundUpcase = false;
    for (let o = 0; o < rootDirBytes.length; o += 32) {
      if (rootDirBytes[o] === 0x82) {
        foundUpcase = true;
        const checksum =
          (rootDirBytes[o + 4] |
            (rootDirBytes[o + 5] << 8) |
            (rootDirBytes[o + 6] << 16) |
            (rootDirBytes[o + 7] << 24)) >>>
          0;
        const firstCluster =
          (rootDirBytes[o + 20] |
            (rootDirBytes[o + 21] << 8) |
            (rootDirBytes[o + 22] << 16) |
            (rootDirBytes[o + 23] << 24)) >>>
          0;
        const dataLength =
          (rootDirBytes[o + 24] |
            (rootDirBytes[o + 25] << 8) |
            (rootDirBytes[o + 26] << 16) |
            (rootDirBytes[o + 27] << 24)) >>>
          0;

        expect(checksum).toBe(0x21b729bb);
        expect(dataLength).toBe(3774);
        expect(firstCluster).toBe(3);

        // Read Upcase Table cluster and verify checksum
        const upcaseOffset = (clusterHeapSector + (firstCluster - 2) * secPerClus) * 512;
        const upcaseBytes = await reader.read(upcaseOffset, dataLength);
        let calcChecksum = 0;
        for (let b = 0; b < upcaseBytes.length; b++) {
          calcChecksum = (((calcChecksum << 31) | (calcChecksum >>> 1)) + upcaseBytes[b]) >>> 0;
        }
        expect(calcChecksum).toBe(0x21b729bb);
        break;
      }
    }
    expect(foundUpcase).toBe(true);
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
  }, 30000);

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

  it('should stream large raw exFAT disk image in large chunks with progress reporting', async () => {
    const rootNode: VNode = {
      id: 'root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      children: [
        {
          id: 'test-doc',
          name: 'BIG_EXFAT.TXT',
          path: '/BIG_EXFAT.TXT',
          isDirectory: false,
          size: 15,
          modifiedTime: new Date(),
          data: new TextEncoder().encode('Hello from exFAT'),
        },
      ],
    };

    const twoGbSectors = 4194304; // 2 GB
    const builder = new ExFatBuilder(rootNode, 'BIG_EXFAT', twoGbSectors, true);

    let writeCalls = 0;
    let totalBytesWritten = 0;
    const progressReports: { ratio: number; status: string }[] = [];

    const mockWriter = {
      write: async (chunk: Uint8Array) => {
        writeCalls++;
        totalBytesWritten += chunk.byteLength;
      },
      close: async () => {},
    };

    await builder.buildToStream(mockWriter, (ratio, status) => {
      progressReports.push({ ratio, status });
    });

    expect(totalBytesWritten).toBe(twoGbSectors * 512);
    // 2GB with 2MB chunks should take ~1024-1030 write calls instead of 524,288!
    expect(writeCalls).toBeLessThan(1100);
    expect(progressReports.length).toBeGreaterThan(3);
    expect(progressReports.some((p) => p.status.includes('Writing disk image:'))).toBe(true);
  });
});

