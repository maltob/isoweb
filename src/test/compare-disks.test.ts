import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { BlobReader } from '../lib/reader';
import { VhdxParser } from '../lib/vhdx/vhdx-parser';
import { VmdkParser } from '../lib/vmdk/vmdk-parser';
import { readUint32BE, XFS_SB_MAGIC } from '../lib/xfs/xfs-types';

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

  it('compares XFS virtual sector by sector between VHDX and VMDK', async () => {
    // 1. Build VHDX with XFS
    const vfsVhdx = VirtualFS.createNew('vhdx-xfs', 'COMPARE_XFS', '1024');
    vfsVhdx.addFile('/', 'TEST.TXT', new TextEncoder().encode('Identical XFS comparison'));
    vfsVhdx.createDirectory('/', 'FOLDER');
    vfsVhdx.addFile('/FOLDER', 'DOC.BIN', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

    const vhdxBlob = await vfsVhdx.buildImageBlob();

    // 2. Build VMDK with identical XFS contents
    const vfsVmdk = VirtualFS.createNew('vmdk-xfs', 'COMPARE_XFS', '1024');
    vfsVmdk.addFile('/', 'TEST.TXT', new TextEncoder().encode('Identical XFS comparison'));
    vfsVmdk.createDirectory('/', 'FOLDER');
    vfsVmdk.addFile('/FOLDER', 'DOC.BIN', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

    const vmdkBlob = await vfsVmdk.buildImageBlob();

    const vhdxReader = new BlobReader(vhdxBlob);
    const vmdkReader = new BlobReader(vmdkBlob);

    const vhdxParser = new VhdxParser(vhdxReader);
    const { virtualReader: vhdxVirtual } = await vhdxParser.parse();

    const vmdkParser = new VmdkParser(vmdkReader);
    const { virtualReader: vmdkVirtual } = await vmdkParser.parse();

    // Verify Sector 0 (MBR) has partition type 0x83 in both
    const vhdxMbr = await vhdxVirtual.read(0, 512);
    const vmdkMbr = await vmdkVirtual.read(0, 512);
    expect(vhdxMbr[450]).toBe(0x83);
    expect(vmdkMbr[450]).toBe(0x83);
    expect(vmdkMbr).toEqual(vhdxMbr);

    // Verify first 2MB of virtual partition blocks (including Superblock, AGF, AGI, AGFL, and root inode chunk)
    const testLen = 2 * 1024 * 1024;
    const vhdxPartBytes = await vhdxVirtual.read(2048 * 512, testLen);
    const vmdkPartBytes = await vmdkVirtual.read(2048 * 512, testLen);

    // Check Superblock magic in both
    expect(readUint32BE(vhdxPartBytes, 0)).toBe(XFS_SB_MAGIC);
    expect(readUint32BE(vmdkPartBytes, 0)).toBe(XFS_SB_MAGIC);
  }, 60000);
});

