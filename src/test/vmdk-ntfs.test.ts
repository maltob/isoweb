import { describe, expect, it } from 'vitest';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VmdkParser } from '../lib/vmdk/vmdk-parser';
import { VMDK_MAGIC } from '../lib/vmdk/vmdk-types';

describe('VMDK with NTFS Partition', () => {
  it('should export sparse VMDK with NTFS partition and read it back with VmdkParser', async () => {
    const vfs = VirtualFS.createNew('vmdk-ntfs', 'VMDK_NTFS', '1024'); // 1 GB capacity
    vfs.addFile('/', 'HOST.TXT', new TextEncoder().encode('VMDK NTFS container test'));
    vfs.createDirectory('/', 'DATA');

    const sample = new Uint8Array(8192);
    for (let i = 0; i < sample.length; i++) sample[i] = (i ^ 0x5a) & 0xff;
    vfs.addFile('/DATA', 'SAMPLE.DAT', sample);

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

    expect(parsed.info.format).toBe('vmdk-ntfs');
    expect(parsed.info.volumeLabel).toBe('VMDK_NTFS');

    const hostFile = parsed.root.children?.find((c) => c.name === 'HOST.TXT');
    expect(hostFile).toBeDefined();
    const hostData = await parsed.ntfsParser?.readFileData(hostFile!);
    expect(new TextDecoder().decode(hostData)).toBe('VMDK NTFS container test');

    const dataDir = parsed.root.children?.find((c) => c.name === 'DATA');
    expect(dataDir).toBeDefined();
    expect(dataDir?.isDirectory).toBe(true);

    const sampleFile = dataDir?.children?.find((c) => c.name === 'SAMPLE.DAT');
    expect(sampleFile).toBeDefined();
    const sampleData = await parsed.ntfsParser?.readFileData(sampleFile!);
    expect(sampleData).toEqual(sample);
  });

  it('should load VMDK-NTFS via DiskImageLoader into VirtualFS', async () => {
    const vfs = VirtualFS.createNew('vmdk-ntfs', 'WIN_VMDK', '1024');
    vfs.addFile('/', 'INFO.LOG', new TextEncoder().encode('Loaded via DiskImageLoader successfully!'));

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);

    const loadedVfs = await DiskImageLoader.load(reader, 'win_disk.vmdk');
    expect(loadedVfs.getFormat()).toBe('vmdk-ntfs');

    const infoNode = loadedVfs.findNode('/INFO.LOG');
    expect(infoNode).toBeDefined();
    const bytes = await loadedVfs.getFileBytes(infoNode!);
    expect(new TextDecoder().decode(bytes)).toBe('Loaded via DiskImageLoader successfully!');
  });
});
