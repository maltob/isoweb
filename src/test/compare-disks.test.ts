import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { BlobReader } from '../lib/reader';
import { VhdxParser } from '../lib/vhdx/vhdx-parser';
import { VmdkParser } from '../lib/vmdk/vmdk-parser';

describe('Compare VHDX and VMDK virtual sectors', () => {
  it('compares virtual sector by sector', async () => {
    const vfsVhdx = VirtualFS.createNew('vhdx-fat32', 'TEST', '512');
    vfsVhdx.addFile('/', 'HELLO.TXT', new TextEncoder().encode('Hello World'));
    const vhdxBlob = await vfsVhdx.buildImageBlob();

    const vfsVmdk = VirtualFS.createNew('vmdk-fat32', 'TEST', '512');
    vfsVmdk.addFile('/', 'HELLO.TXT', new TextEncoder().encode('Hello World'));
    const vmdkBlob = await vfsVmdk.buildImageBlob();

    const vhdxReader = new BlobReader(vhdxBlob);
    const vmdkReader = new BlobReader(vmdkBlob);

    const vhdxParser = new VhdxParser(vhdxReader);
    const { virtualReader: vhdxVirtual } = await vhdxParser.parse();

    const vmdkParser = new VmdkParser(vmdkReader);
    const { virtualReader: vmdkVirtual } = await vmdkParser.parse();

    // Verify VMDK Descriptor geometry
    const descBytes = await vmdkReader.read(512, 20 * 512);
    const descText = new TextDecoder().decode(descBytes).replace(/\0/g, '');
    expect(descText).toContain('ddb.geometry.heads = "255"');
    expect(descText).toContain('ddb.geometry.sectors = "63"');
    expect(descText).toContain('ddb.virtualHWVersion = "7"');

    // Read first 2MB of virtual disk from VHDX and VMDK and ensure identical virtual sector parity
    const testLen = 2 * 1024 * 1024; // 2 MB
    const vhdxBytes = await vhdxVirtual.read(0, testLen);
    const vmdkBytes = await vmdkVirtual.read(0, testLen);

    expect(vmdkBytes).toEqual(vhdxBytes);
  }, 60000);

  it('compares exFAT virtual sector by sector between VHDX and VMDK', async () => {
    const vfsVhdx = VirtualFS.createNew('vhdx-exfat', 'EXFAT_COMP', '512');
    vfsVhdx.addFile('/', 'EMPTY.DAT', new Uint8Array(0));
    vfsVhdx.addFile('/', 'HELLO.TXT', new TextEncoder().encode('exFAT VHDX vs VMDK sector test'));
    const vhdxBlob = await vfsVhdx.buildImageBlob();

    const vfsVmdk = VirtualFS.createNew('vmdk-exfat', 'EXFAT_COMP', '512');
    vfsVmdk.addFile('/', 'EMPTY.DAT', new Uint8Array(0));
    vfsVmdk.addFile('/', 'HELLO.TXT', new TextEncoder().encode('exFAT VHDX vs VMDK sector test'));
    const vmdkBlob = await vfsVmdk.buildImageBlob();

    const vhdxReader = new BlobReader(vhdxBlob);
    const vmdkReader = new BlobReader(vmdkBlob);

    const vhdxParser = new VhdxParser(vhdxReader);
    const { virtualReader: vhdxVirtual } = await vhdxParser.parse();

    const vmdkParser = new VmdkParser(vmdkReader);
    const { virtualReader: vmdkVirtual } = await vmdkParser.parse();

    // Verify first 2MB of virtual sectors match identically
    const testLen = 2 * 1024 * 1024;
    const vhdxBytes = await vhdxVirtual.read(0, testLen);
    const vmdkBytes = await vmdkVirtual.read(0, testLen);

    expect(vmdkBytes).toEqual(vhdxBytes);
  }, 60000);

  it('compares NTFS virtual sector by sector between VHDX and VMDK', async () => {
    const fixedDate = new Date('2026-01-01T00:00:00Z');
    const vfsVhdx = VirtualFS.createNew('vhdx-ntfs', 'NTFS_COMP', '1024');
    vfsVhdx.getRoot().modifiedTime = fixedDate;
    vfsVhdx.addFile('/', 'EMPTY.DAT', new Uint8Array(0));
    vfsVhdx.addFile('/', 'HELLO.TXT', new TextEncoder().encode('NTFS VHDX vs VMDK sector test'));
    vfsVhdx.findNode('/EMPTY.DAT')!.modifiedTime = fixedDate;
    vfsVhdx.findNode('/HELLO.TXT')!.modifiedTime = fixedDate;
    const vhdxBlob = await vfsVhdx.buildImageBlob();

    const vfsVmdk = VirtualFS.createNew('vmdk-ntfs', 'NTFS_COMP', '1024');
    vfsVmdk.getRoot().modifiedTime = fixedDate;
    vfsVmdk.addFile('/', 'EMPTY.DAT', new Uint8Array(0));
    vfsVmdk.addFile('/', 'HELLO.TXT', new TextEncoder().encode('NTFS VHDX vs VMDK sector test'));
    vfsVmdk.findNode('/EMPTY.DAT')!.modifiedTime = fixedDate;
    vfsVmdk.findNode('/HELLO.TXT')!.modifiedTime = fixedDate;
    const vmdkBlob = await vfsVmdk.buildImageBlob();

    const vhdxReader = new BlobReader(vhdxBlob);
    const vmdkReader = new BlobReader(vmdkBlob);

    const vhdxParser = new VhdxParser(vhdxReader);
    const { virtualReader: vhdxVirtual } = await vhdxParser.parse();

    const vmdkParser = new VmdkParser(vmdkReader);
    const { virtualReader: vmdkVirtual } = await vmdkParser.parse();

    // Verify first 2MB of virtual sectors (MBR + Partition VBR + MFT Mirr + MFT Root) match identically
    const testLen = 2 * 1024 * 1024;
    const vhdxBytes = await vhdxVirtual.read(0, testLen);
    const vmdkBytes = await vmdkVirtual.read(0, testLen);

    expect(vmdkBytes).toEqual(vhdxBytes);
  }, 60000);
});

