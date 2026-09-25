import { describe, expect, it } from 'vitest';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VmdkParser } from '../lib/vmdk/vmdk-parser';
import { VMDK_MAGIC } from '../lib/vmdk/vmdk-types';

describe('VMDK with XFS Partition', () => {
  it('should export sparse VMDK with XFS partition and read it back with VmdkParser', async () => {
    const vfs = VirtualFS.createNew('vmdk-xfs', 'VMDK_XFS', '1024'); // 1 GB capacity
    vfs.addFile('/', 'HOST.TXT', new TextEncoder().encode('VMDK XFS container test'));
    vfs.createDirectory('/', 'SERVER');

    const sample = new Uint8Array(8192);
    for (let i = 0; i < sample.length; i++) sample[i] = (i ^ 0xa5) & 0xff;
    vfs.addFile('/SERVER', 'PAYLOAD.DAT', sample);

    // Build VMDK image blob
    const blob = await vfs.buildImageBlob();
    expect(blob.size).toBeGreaterThan(0);

    const reader = new BlobReader(blob);

    // Verify VMDK Magic
    const headerBytes = await reader.read(0, 512);
    const magic =
      (headerBytes[0] |
        (headerBytes[1] << 8) |
        (headerBytes[2] << 16) |
        (headerBytes[3] << 24)) >>>
      0;
    expect(magic).toBe(VMDK_MAGIC);

    // Parse with VmdkParser
    const parser = new VmdkParser(reader);
    const parsed = await parser.parse();

    expect(parsed.info.format).toBe('vmdk-xfs');
    expect(parsed.info.volumeLabel).toBe('VMDK_XFS');

    const hostFile = parsed.root.children?.find((c) => c.name === 'HOST.TXT');
    expect(hostFile).toBeDefined();
    const hostData = await parsed.xfsParser?.readFileData(hostFile!);
    expect(new TextDecoder().decode(hostData)).toBe('VMDK XFS container test');

    const serverDir = parsed.root.children?.find((c) => c.name === 'SERVER');
    expect(serverDir).toBeDefined();
    expect(serverDir?.isDirectory).toBe(true);

    const payloadFile = serverDir?.children?.find((c) => c.name === 'PAYLOAD.DAT');
    expect(payloadFile).toBeDefined();
    const payloadData = await parsed.xfsParser?.readFileData(payloadFile!);
    expect(payloadData).toEqual(sample);
  }, 25000);

  it('should load VMDK-XFS via DiskImageLoader into VirtualFS', async () => {
    const vfs = VirtualFS.createNew('vmdk-xfs', 'RHEL_VMDK', '1024');
    vfs.addFile('/', 'BOOT.CFG', new TextEncoder().encode('kernel /vmlinuz-xfs root=UUID=xfs'));

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);

    const loadedVfs = await DiskImageLoader.load(reader, 'rhel.vmdk');
    expect(loadedVfs.getFormat()).toBe('vmdk-xfs');

    const bootNode = loadedVfs.findNode('/BOOT.CFG');
    expect(bootNode).toBeDefined();
    const bytes = await loadedVfs.getFileBytes(bootNode!);
    expect(new TextDecoder().decode(bytes)).toBe('kernel /vmlinuz-xfs root=UUID=xfs');
  }, 25000);
});
