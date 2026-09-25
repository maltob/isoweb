import { describe, expect, it } from 'vitest';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VhdxParser } from '../lib/vhdx/vhdx-parser';

describe('VHDX with XFS Partition', () => {
  it('should export dynamic VHDX with XFS partition and read it back with VhdxParser', async () => {
    const vfs = VirtualFS.createNew('vhdx-xfs', 'VHDX_XFS', '1024'); // 1 GB capacity
    vfs.addFile('/', 'VHDX_XFS.TXT', new TextEncoder().encode('VHDX XFS dynamic disk validation'));
    vfs.createDirectory('/', 'LOGS');

    const sample = new Uint8Array(12288); // 3 blocks of 4096 bytes
    for (let i = 0; i < sample.length; i++) sample[i] = (i * 23) & 0xff;
    vfs.addFile('/LOGS', 'KERNEL.LOG', sample);

    // Build VHDX image blob
    const blob = await vfs.buildImageBlob();
    expect(blob.size).toBeGreaterThan(0);

    const reader = new BlobReader(blob);
    expect(await VhdxParser.isVhdx(reader)).toBe(true);

    // Parse with VhdxParser
    const parser = new VhdxParser(reader);
    const parsed = await parser.parse();

    expect(parsed.info.format).toBe('vhdx-xfs');
    expect(parsed.info.volumeLabel).toBe('VHDX_XFS');

    const testFile = parsed.root.children?.find((c) => c.name === 'VHDX_XFS.TXT');
    expect(testFile).toBeDefined();
    const testBytes = await parsed.vfs.getFileBytes(testFile!);
    expect(new TextDecoder().decode(testBytes)).toBe('VHDX XFS dynamic disk validation');

    const logsDir = parsed.root.children?.find((c) => c.name === 'LOGS');
    expect(logsDir).toBeDefined();
    expect(logsDir?.isDirectory).toBe(true);

    const kernelLog = logsDir?.children?.find((c) => c.name === 'KERNEL.LOG');
    expect(kernelLog).toBeDefined();
    const logBytes = await parsed.vfs.getFileBytes(kernelLog!);
    expect(logBytes).toEqual(sample);
  }, 25000);

  it('should load VHDX-XFS via DiskImageLoader into VirtualFS', async () => {
    const vfs = VirtualFS.createNew('vhdx-xfs', 'LINUX_VHDX', '1024');
    vfs.addFile('/', 'RELEASE', new TextEncoder().encode('Rocky Linux 9.4 (Blue Onyx)'));

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);

    const loadedVfs = await DiskImageLoader.load(reader, 'hyperv_linux.vhdx');
    expect(loadedVfs.getFormat()).toBe('vhdx-xfs');

    const relNode = loadedVfs.findNode('/RELEASE');
    expect(relNode).toBeDefined();
    const bytes = await loadedVfs.getFileBytes(relNode!);
    expect(new TextDecoder().decode(bytes)).toBe('Rocky Linux 9.4 (Blue Onyx)');
  }, 25000);
});
