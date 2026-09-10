import { describe, expect, it } from 'vitest';
import { FatBuilder } from '../lib/fat/fat-builder';
import { FatParser } from '../lib/fat/fat-parser';
import { FatType } from '../lib/fat/fat-types';
import { IsoParser } from '../lib/iso/iso-parser';
import { BlobReader } from '../lib/reader';
import { VNode } from '../lib/types';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';

describe('ISO 9660 & Joliet Builder and Parser', () => {
  it('should build and parse an ISO with directories and files', async () => {
    const vfs = VirtualFS.createNew('iso', 'TEST_ISO');

    const sampleText = 'Hello VM world from ISOWeb ISO builder!';
    const textBytes = new TextEncoder().encode(sampleText);
    vfs.addFile('/', 'README.TXT', textBytes);

    vfs.createDirectory('/', 'BOOT');
    const binaryData = new Uint8Array([0xeb, 0x3c, 0x90, 0x00, 0x55, 0xaa]);
    vfs.addFile('/BOOT', 'KERNEL.BIN', binaryData);

    vfs.createDirectory('/', 'SUB FOLDER WITH SPACES');
    const docData = new TextEncoder().encode('Long filename in Joliet subfolder');
    vfs.addFile('/SUB FOLDER WITH SPACES', 'Very Long Filename Document.txt', docData);

    // Build ISO Blob
    const isoBlob = await vfs.buildImageBlob();
    expect(isoBlob.size).toBeGreaterThan(32768); // At least system area + PVD + terminator

    // Parse back
    const reader = new BlobReader(isoBlob);
    const parser = new IsoParser(reader);
    const { root, info } = await parser.parse();

    expect(info.format).toBe('iso');
    expect(info.hasJoliet).toBe(true);
    expect(info.volumeLabel).toBe('TEST_ISO');

    // Find README.TXT
    const readme = root.children?.find((c) => c.name === 'README.TXT');
    expect(readme).toBeDefined();
    expect(readme?.size).toBe(textBytes.length);

    // Find BOOT directory
    const bootDir = root.children?.find((c) => c.name === 'BOOT');
    expect(bootDir).toBeDefined();
    expect(bootDir?.isDirectory).toBe(true);

    const kernel = bootDir?.children?.find((c) => c.name === 'KERNEL.BIN');
    expect(kernel).toBeDefined();
    expect(kernel?.size).toBe(binaryData.length);

    // Verify file content
    const kernelBytes = await reader.read(kernel!.sourceSector! * 2048, kernel!.sourceLength!);
    expect(kernelBytes).toEqual(binaryData);

    // Check long folder name & long file name
    const longDir = root.children?.find((c) => c.name === 'SUB FOLDER WITH SPACES');
    expect(longDir).toBeDefined();
    const longFile = longDir?.children?.find((c) => c.name === 'Very Long Filename Document.txt');
    expect(longFile).toBeDefined();
    const longFileBytes = await reader.read(longFile!.sourceSector! * 2048, longFile!.sourceLength!);
    expect(new TextDecoder().decode(longFileBytes)).toBe('Long filename in Joliet subfolder');
  });
});

describe('FAT12 Floppy Image Builder and Parser', () => {
  it('should build a 1.44MB FAT12 floppy and parse files with LFN', async () => {
    const vfs = VirtualFS.createNew('fat12', 'MY_FLOPPY');

    const configText = 'DEVICE=HIMEM.SYS\nDOS=HIGH,UMB\n';
    vfs.addFile('/', 'CONFIG.SYS', new TextEncoder().encode(configText));

    const lfnText = 'This file has a very long filename with spaces.';
    vfs.addFile('/', 'Important Notes 2026.txt', new TextEncoder().encode(lfnText));

    vfs.createDirectory('/', 'TOOLS');
    vfs.addFile('/TOOLS', 'EDIT.COM', new Uint8Array([0xcd, 0x20]));

    const imgBlob = await vfs.buildImageBlob();
    // 1.44MB Floppy = 1,474,560 bytes
    expect(imgBlob.size).toBe(1474560);

    // Parse back
    const reader = new BlobReader(imgBlob);
    const parser = new FatParser(reader);
    const { root, info } = await parser.parse();

    expect(info.format).toBe('fat12');
    expect(info.volumeLabel).toBe('MY_FLOPPY');
    expect(info.totalSectors).toBe(2880);

    const config = root.children?.find((c) => c.name === 'CONFIG.SYS');
    expect(config).toBeDefined();
    const configBytes = await parser.readFileData(config!);
    expect(new TextDecoder().decode(configBytes)).toBe(configText);

    const lfnFile = root.children?.find((c) => c.name === 'Important Notes 2026.txt');
    expect(lfnFile).toBeDefined();
    const lfnBytes = await parser.readFileData(lfnFile!);
    expect(new TextDecoder().decode(lfnBytes)).toBe(lfnText);

    const tools = root.children?.find((c) => c.name === 'TOOLS');
    expect(tools).toBeDefined();
    const editCom = tools?.children?.find((c) => c.name === 'EDIT.COM');
    expect(editCom).toBeDefined();
    const editBytes = await parser.readFileData(editCom!);
    expect(editBytes).toEqual(new Uint8Array([0xcd, 0x20]));
  });
});

describe('FAT16 & FAT32 Disk Image Builder', () => {
  it('should build a FAT16 disk image', async () => {
    const rootNode: VNode = {
      id: 'root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date(),
      children: [
        {
          id: 'test-1',
          name: 'TEST.TXT',
          path: '/TEST.TXT',
          isDirectory: false,
          size: 11,
          modifiedTime: new Date(),
          data: new TextEncoder().encode('FAT16 test!'),
        },
      ],
    };

    const builder = new FatBuilder(rootNode, {
      fatType: FatType.FAT16,
      volumeLabel: 'FAT16_DISK',
      totalSectors: 20480, // 10MB
    });

    const blob = await builder.buildBlob();
    expect(blob.size).toBe(20480 * 512);

    const parser = new FatParser(new BlobReader(blob));
    const { root, info } = await parser.parse();
    expect(info.format).toBe('fat16');
    expect(info.volumeLabel).toBe('FAT16_DISK');

    const file = root.children?.find((c) => c.name === 'TEST.TXT');
    expect(file).toBeDefined();
    const data = await parser.readFileData(file!);
    expect(new TextDecoder().decode(data)).toBe('FAT16 test!');
  });
});
