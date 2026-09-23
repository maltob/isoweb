import { describe, expect, it } from 'vitest';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VhdxParser } from '../lib/vhdx/vhdx-parser';

describe('VHDX with NTFS Partition', () => {
  it('should export dynamic VHDX with NTFS partition and read it back with VhdxParser', async () => {
    const vfs = VirtualFS.createNew('vhdx-ntfs', 'VHDX_NTFS', '1024'); // 1 GB capacity
    vfs.addFile('/', 'VHDX_TEST.TXT', new TextEncoder().encode('VHDX NTFS dynamic disk validation'));
    vfs.createDirectory('/', 'DOCUMENTS');

    const sample = new Uint8Array(12288); // 3 clusters
    for (let i = 0; i < sample.length; i++) sample[i] = (i * 17) & 0xff;
    vfs.addFile('/DOCUMENTS', 'RECORD.DAT', sample);

    // Build VHDX image blob
    const blob = await vfs.buildImageBlob();
    expect(blob.size).toBeGreaterThan(0);

    const reader = new BlobReader(blob);
    expect(await VhdxParser.isVhdx(reader)).toBe(true);

    // Parse with VhdxParser
    const parser = new VhdxParser(reader);
    const parsed = await parser.parse();

    expect(parsed.info.format).toBe('vhdx-ntfs');
    expect(parsed.info.volumeLabel).toBe('VHDX_NTFS');

    const testFile = parsed.root.children?.find((c) => c.name === 'VHDX_TEST.TXT');
    expect(testFile).toBeDefined();
    const testBytes = await parsed.vfs.getFileBytes(testFile!);
    expect(new TextDecoder().decode(testBytes)).toBe('VHDX NTFS dynamic disk validation');

    const docsDir = parsed.root.children?.find((c) => c.name === 'DOCUMENTS');
    expect(docsDir).toBeDefined();
    expect(docsDir?.isDirectory).toBe(true);

    const recordFile = docsDir?.children?.find((c) => c.name === 'RECORD.DAT');
    expect(recordFile).toBeDefined();
    const recordBytes = await parsed.vfs.getFileBytes(recordFile!);
    expect(recordBytes).toEqual(sample);
  });

  it('should load VHDX-NTFS via DiskImageLoader into VirtualFS', async () => {
    const vfs = VirtualFS.createNew('vhdx-ntfs', 'WIN_VHDX', '1024');
    vfs.addFile('/', 'BOOTLOG.TXT', new TextEncoder().encode('Booting Hyper-V Windows partition...'));

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);

    const loadedVfs = await DiskImageLoader.load(reader, 'hyperv.vhdx');
    expect(loadedVfs.getFormat()).toBe('vhdx-ntfs');

    const bootNode = loadedVfs.findNode('/BOOTLOG.TXT');
    expect(bootNode).toBeDefined();
    const bytes = await loadedVfs.getFileBytes(bootNode!);
    expect(new TextDecoder().decode(bytes)).toBe('Booting Hyper-V Windows partition...');
  });

  it('should write and close a non-empty VHDX through the direct-to-disk stream', async () => {
    const vfs = VirtualFS.createNew('vhdx-ntfs', 'DIRECT_WRITE', '1024');
    vfs.addFile('/', 'STREAM_TEST.TXT', new TextEncoder().encode('streamed VHDX output'));

    const chunks: Uint8Array[] = [];
    let closed = false;
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk.slice());
      },
      close() {
        closed = true;
      },
    });
    const fileHandle = {
      name: 'direct-write.vhdx',
      createWritable: async () => writable,
    } as unknown as FileSystemFileHandle;

    await vfs.buildToDisk(fileHandle, undefined, {
      format: 'vhdx-ntfs',
      volumeLabel: 'DIRECT_WRITE',
      capacityMb: 1024,
    });

    expect(closed).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(chunks[0].subarray(0, 8))).toBe('vhdxfile');
    expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBeGreaterThan(0);
  });
});
