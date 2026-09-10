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
});
