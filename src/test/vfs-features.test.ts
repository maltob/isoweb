import { describe, expect, it } from 'vitest';
import { BlobReader } from '../lib/reader';
import { IsoParser } from '../lib/iso/iso-parser';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';

describe('VirtualFS Editing & ZIP Archiving', () => {
  it('should support adding, renaming, deleting files, and zip export', async () => {
    const vfs = VirtualFS.createNew('iso', 'VFS_TEST');

    // Add files
    vfs.addFile('/', 'test.txt', new TextEncoder().encode('Hello'));
    vfs.createDirectory('/', 'DIR1');
    vfs.addFile('/DIR1', 'sub.txt', new TextEncoder().encode('World in subfolder'));

    expect(vfs.findNode('/test.txt')).toBeDefined();
    expect(vfs.findNode('/DIR1/sub.txt')).toBeDefined();

    // Rename
    const renamed = vfs.renameNode('/test.txt', 'hello.txt');
    expect(renamed).toBe(true);
    expect(vfs.findNode('/test.txt')).toBeNull();
    expect(vfs.findNode('/hello.txt')).toBeDefined();

    // Export ZIP
    const zipBlob = await vfs.exportAsZip();
    expect(zipBlob.size).toBeGreaterThan(0);
    expect(zipBlob.type).toBe('application/zip');

    // Delete
    const deleted = vfs.deleteNode('/hello.txt');
    expect(deleted).toBe(true);
    expect(vfs.findNode('/hello.txt')).toBeNull();

    // Build and verify updated ISO
    const updatedIso = await vfs.buildImageBlob();
    const reader = new BlobReader(updatedIso);
    const parser = new IsoParser(reader);
    const { root } = await parser.parse();

    expect(root.children?.find((c) => c.name === 'hello.txt')).toBeUndefined();
    const dir1 = root.children?.find((c) => c.name === 'DIR1');
    expect(dir1).toBeDefined();
    expect(dir1?.children?.find((c) => c.name === 'sub.txt')).toBeDefined();
  });

  it('should support building disk images with empty folders without getting stuck', async () => {
    // 1. ISO with empty folders
    const isoVfs = VirtualFS.createNew('iso', 'EMPTY_ISO');
    isoVfs.createDirectory('/', 'EMPTY_DIR');
    isoVfs.createDirectory('/EMPTY_DIR', 'NESTED_EMPTY');
    const isoBlob = await isoVfs.buildImageBlob();
    expect(isoBlob.size).toBeGreaterThan(0);

    const isoParser = new IsoParser(new BlobReader(isoBlob));
    const { root: isoRoot } = await isoParser.parse();
    const emptyDir = isoRoot.children?.find((c) => c.name === 'EMPTY_DIR');
    expect(emptyDir).toBeDefined();
    expect(emptyDir?.isDirectory).toBe(true);
    expect(emptyDir?.children?.find((c) => c.name === 'NESTED_EMPTY')).toBeDefined();

    // 2. FAT32 with empty folders
    const fatVfs = VirtualFS.createNew('fat32', 'EMPTY_FAT', '64');
    fatVfs.createDirectory('/', 'EMPTY_DIR');
    fatVfs.createDirectory('/EMPTY_DIR', 'NESTED_EMPTY');
    const fatBlob = await fatVfs.buildImageBlob();
    expect(fatBlob.size).toBe(64 * 1024 * 1024);

    // 3. VMDK with empty folders
    const vmdkVfs = VirtualFS.createNew('vmdk-fat32', 'EMPTY_VMDK', '512');
    vmdkVfs.createDirectory('/', 'EMPTY_DIR');
    const vmdkBlob = await vmdkVfs.buildImageBlob();
    expect(vmdkBlob.size).toBeGreaterThan(0);
  });

  it('should extract empty directory entries from readDirectoryHandle without stalling', async () => {
    const { readDirectoryHandle } = await import('../lib/drop-handler');

    // Mock empty directory handle
    const mockEmptyDir: any = {
      name: 'EmptyFolder',
      kind: 'directory',
      entries: async function* () {
        // Yields no entries (empty directory)
      },
    };

    const entries = await readDirectoryHandle(mockEmptyDir);
    expect(entries.length).toBe(1);
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[0].relativePath).toBe('EmptyFolder');
  });
});
