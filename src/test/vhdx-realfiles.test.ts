import { describe, expect, it } from 'vitest';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { VhdxParser } from '../lib/vhdx/vhdx-parser';
import { DiskImageLoader } from '../lib/loader';

describe('VHDX with Real Files simulation', () => {
  it('should build a VHDX with real File objects spanning multiple megabytes', async () => {
    const vfs = VirtualFS.createNew('vhdx-fat32', 'REALFILES', '1024');

    // Create realistic files using the standard File API (like browser file pickers)
    // 1. A 3 MB binary file (crosses multiple 1MB VHDX blocks)
    const size3Mb = 3 * 1024 * 1024 + 54321;
    const buf3Mb = new Uint8Array(size3Mb);
    for (let i = 0; i < size3Mb; i += 4096) {
      buf3Mb[i] = (i * 17) & 0xff;
      buf3Mb[i + 1] = 0xaa;
    }
    const file1 = new File([buf3Mb], 'BIGFILE.BIN', { type: 'application/octet-stream', lastModified: Date.now() });
    vfs.addFile('/', 'BIGFILE.BIN', undefined, new Date(file1.lastModified), file1);

    // 2. Multiple text and document files in a subdirectory
    vfs.createDirectory('/', 'DOCS');
    const text1 = 'Hello from real file 1!'.repeat(100);
    const file2 = new File([text1], 'NOTES.TXT', { type: 'text/plain', lastModified: Date.now() });
    vfs.addFile('/DOCS', 'NOTES.TXT', undefined, new Date(file2.lastModified), file2);

    const text2 = 'Another file with some content...'.repeat(500);
    const file3 = new File([text2], 'REPORT.MD', { type: 'text/markdown', lastModified: Date.now() });
    vfs.addFile('/DOCS', 'REPORT.MD', undefined, new Date(file3.lastModified), file3);

    // Build the VHDX blob
    const blob = await vfs.buildImageBlob();
    expect(blob.size).toBeGreaterThan(3 * 1024 * 1024);

    // Parse back
    const reader = new BlobReader(blob);
    const loaded = await DiskImageLoader.load(reader, 'test.vhdx');

    // Check files
    const bigNode = loaded.findNode('/BIGFILE.BIN');
    expect(bigNode).toBeDefined();
    expect(bigNode?.size).toBe(size3Mb);

    const loadedBytes = await loaded.getFileBytes(bigNode!);
    expect(loadedBytes.byteLength).toBe(size3Mb);
    expect(loadedBytes[0]).toBe(buf3Mb[0]);
    expect(loadedBytes[4096]).toBe(buf3Mb[4096]);
    expect(loadedBytes[4097]).toBe(buf3Mb[4097]);

    const notesNode = loaded.findNode('/DOCS/NOTES.TXT');
    expect(notesNode).toBeDefined();
    const notesBytes = await loaded.getFileBytes(notesNode!);
    expect(new TextDecoder().decode(notesBytes)).toBe(text1);
  }, 30000);

  it('should handle many files in a directory without overflowing cluster directory table', async () => {
    const vfs = VirtualFS.createNew('vhdx-fat32', 'MANYFILES', '1024');
    vfs.createDirectory('/', 'FOLDER');

    for (let i = 0; i < 100; i++) {
      const fileName = `Long File Name Test Document Number ${i.toString().padStart(3, '0')}.txt`;
      const fileData = `Content of file ${i}`;
      const f = new File([fileData], fileName, { type: 'text/plain', lastModified: Date.now() });
      vfs.addFile('/FOLDER', fileName, undefined, new Date(f.lastModified), f);
    }

    const blob = await vfs.buildImageBlob();
    expect(blob.size).toBeGreaterThan(1024 * 1024);

    const reader = new BlobReader(blob);
    const loaded = await DiskImageLoader.load(reader, 'many.vhdx');
    const folder = loaded.findNode('/FOLDER');
    expect(folder?.children?.length).toBe(100);
  }, 30000);

  it('should generate unique 8.3 short names when filenames collide', async () => {
    const vfs = VirtualFS.createNew('vhdx-fat32', 'COLLISIONS', '1024');
    // Files that share the first 8 characters and have same extension
    vfs.addFile('/', 'FINANCIAL_REPORT_2025.PDF', new TextEncoder().encode('Report 2025'));
    vfs.addFile('/', 'FINANCIAL_REPORT_2026.PDF', new TextEncoder().encode('Report 2026'));
    vfs.addFile('/', 'FINANCIAL_REPORT_2027.PDF', new TextEncoder().encode('Report 2027'));

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);
    const loaded = await DiskImageLoader.load(reader, 'col.vhdx');

    expect(loaded.findNode('/FINANCIAL_REPORT_2025.PDF')).toBeDefined();
    expect(loaded.findNode('/FINANCIAL_REPORT_2026.PDF')).toBeDefined();
    expect(loaded.findNode('/FINANCIAL_REPORT_2027.PDF')).toBeDefined();
  }, 30000);

  it('should initialize dynamic sparse blocks to PAYLOAD_BLOCK_ZERO (state 2)', async () => {
    const vfs = VirtualFS.createNew('vhdx-fat32', 'SPARSE_TEST', '1024');
    vfs.addFile('/', 'TEST.TXT', new TextEncoder().encode('Hello Sparse VHDX'));
    const blob = await vfs.buildImageBlob();

    const reader = new BlobReader(blob);
    const parser = new VhdxParser(reader);
    const { virtualReader } = await parser.parse();

    // Verify virtual space beyond written partition data reads as zeros
    const emptySectors = await virtualReader.read(100 * 1024 * 1024, 65536); // At 100 MB offset
    expect(emptySectors.length).toBe(65536);
    let allZero = true;
    for (let i = 0; i < emptySectors.length; i++) {
      if (emptySectors[i] !== 0) {
        allZero = false;
        break;
      }
    }
    expect(allZero).toBe(true);
  }, 30000);

  it('should build and parse an exFAT VHDX with real files and directories', async () => {
    const vfs = VirtualFS.createNew('vhdx-exfat', 'EXFAT_REAL', '2048');
    const f1 = new File(['Some content inside exFAT real file!'], 'EXFAT_DOC.TXT', { type: 'text/plain' });
    vfs.addFile('/', 'EXFAT_DOC.TXT', undefined, new Date(), f1);

    vfs.createDirectory('/', 'PROJECT');
    for (let i = 0; i < 20; i++) {
      const f = new File([`Item data ${i}`], `Item_${i}.dat`, { type: 'application/octet-stream' });
      vfs.addFile('/PROJECT', `Item_${i}.dat`, undefined, new Date(), f);
    }

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);
    const loaded = await DiskImageLoader.load(reader, 'exreal.vhdx');

    expect(loaded.getFormat()).toBe('vhdx-exfat');
    expect(loaded.findNode('/EXFAT_DOC.TXT')).toBeDefined();
    expect(loaded.findNode('/PROJECT')?.children?.length).toBe(20);
  }, 30000);
});

