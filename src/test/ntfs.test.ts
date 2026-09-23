import { describe, expect, it } from 'vitest';
import { NtfsParser } from '../lib/ntfs/ntfs-parser';
import { DiskImageLoader } from '../lib/loader';
import { BlobReader } from '../lib/reader';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';
import { NTFS_FILE_ATTR_I30_INDEX_PRESENT, NTFS_FILE_ATTR_VIEW_INDEX_PRESENT } from '../lib/ntfs/ntfs-types';

describe('NTFS Volume Builder and Parser', () => {
  it('should format an NTFS volume and parse resident files, non-resident files, and subdirectories', async () => {
    const vfs = VirtualFS.createNew('ntfs', 'TEST_NTFS', '64'); // 64 MB

    // 1. Resident file (< 600 bytes)
    const smallText = 'Hello from native browser NTFS engine!';
    vfs.addFile('/', 'GREETING.TXT', new TextEncoder().encode(smallText));

    // 2. Zero-byte file
    vfs.addFile('/', 'EMPTY.LOG', new Uint8Array(0));

    // 3. Subdirectory with a non-resident file (> 1 cluster, e.g. 10 KB)
    vfs.createDirectory('/', 'SYSTEM_DOCS');
    const largeData = new Uint8Array(10240);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = (i * 31) & 0xff;
    }
    vfs.addFile('/SYSTEM_DOCS', 'PAYLOAD.BIN', largeData);

    // Another file in subdirectory
    const docText = 'Comprehensive NTFS specification compliant partition.';
    vfs.addFile('/SYSTEM_DOCS', 'SPEC.TXT', new TextEncoder().encode(docText));

    // Build standalone image blob
    const blob = await vfs.buildImageBlob();
    expect(blob.size).toBe(64 * 1024 * 1024);

    const reader = new BlobReader(blob);
    const parser = new NtfsParser(reader);
    const { root, info } = await parser.parse();

    expect(info.format).toBe('ntfs');
    expect(info.volumeLabel).toBe('TEST_NTFS');
    expect(info.sectorSize).toBe(512);
    expect(info.clusterSize).toBe(4096);

    // Verify root children
    expect(root.children).toBeDefined();
    const greeting = root.children?.find((c) => c.name === 'GREETING.TXT');
    expect(greeting).toBeDefined();
    expect(greeting?.size).toBe(smallText.length);
    const greetingData = await parser.readFileData(greeting!);
    expect(new TextDecoder().decode(greetingData)).toBe(smallText);

    const emptyFile = root.children?.find((c) => c.name === 'EMPTY.LOG');
    expect(emptyFile).toBeDefined();
    expect(emptyFile?.size).toBe(0);
    const emptyData = await parser.readFileData(emptyFile!);
    expect(emptyData.byteLength).toBe(0);

    const sysDocs = root.children?.find((c) => c.name === 'SYSTEM_DOCS');
    expect(sysDocs).toBeDefined();
    expect(sysDocs?.isDirectory).toBe(true);
    expect(sysDocs?.children).toBeDefined();

    const payload = sysDocs?.children?.find((c) => c.name === 'PAYLOAD.BIN');
    expect(payload).toBeDefined();
    expect(payload?.size).toBe(10240);
    const payloadData = await parser.readFileData(payload!);
    expect(payloadData.length).toBe(10240);
    expect(payloadData).toEqual(largeData);

    const spec = sysDocs?.children?.find((c) => c.name === 'SPEC.TXT');
    expect(spec).toBeDefined();
    const specData = await parser.readFileData(spec!);
    expect(new TextDecoder().decode(specData)).toBe(docText);
  });

  it('should load NTFS image via DiskImageLoader and lazy-read files with VirtualFS', async () => {
    const vfs = VirtualFS.createNew('ntfs', 'WIN_VOLUME', '64');
    const content = 'Windows Virtual Hard Disk NTFS Test File';
    vfs.addFile('/', 'TEST.DAT', new TextEncoder().encode(content));

    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);

    const loadedVfs = await DiskImageLoader.load(reader, 'win_volume.ntfs');
    expect(loadedVfs.getFormat()).toBe('ntfs');
    expect(loadedVfs.getImageInfo().volumeLabel).toBe('WIN_VOLUME');

    const testFile = loadedVfs.findNode('/TEST.DAT');
    expect(testFile).toBeDefined();
    const bytes = await loadedVfs.getFileBytes(testFile!);
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });

  it('should mark rounded-up $Bitmap bits beyond the volume as unavailable', async () => {
    const vfs = VirtualFS.createNew('ntfs', 'BITMAP_TAIL', '64');
    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);

    // A 64 MiB standalone NTFS volume has 16,383 usable 4 KiB clusters.
    // Its 2,048-byte $Bitmap therefore has one rounded-up bit (bit 7 of the
    // final logical byte), which must be set.
    const bitmapStartCluster = 624;
    const bitmap = await reader.read(bitmapStartCluster * 4096, 2048);
    expect(bitmap.length).toBe(2048);
    expect(bitmap[0] & 0x08).toBe(0); // Reserved cluster 3 is not allocated.
    expect(bitmap[bitmap.length - 1] & 0x80).toBe(0x80);
  });

  it('stores the MFT allocation bitmap in a nonresident cluster', async () => {
    const vfs = VirtualFS.createNew('ntfs', 'MFT_BITMAP', '64');
    const reader = new BlobReader(await vfs.buildImageBlob());
    const boot = await reader.read(0, 512);
    const bootView = new DataView(boot.buffer, boot.byteOffset);
    const mftLcn = Number(bootView.getBigUint64(48, true));
    const record = await reader.read(mftLcn * 4096, 1024);
    const view = new DataView(record.buffer, record.byteOffset);
    let offset = view.getUint16(20, true);
    while (view.getUint32(offset, true) !== 0xb0) {
      const length = view.getUint32(offset + 4, true);
      expect(length).toBeGreaterThan(0);
      offset += length;
      expect(offset).toBeLessThan(1024);
    }
    expect(record[offset + 8]).toBe(1);
    expect(view.getBigUint64(offset + 40, true)).toBe(4096n);
    expect(view.getBigUint64(offset + 48, true)).toBe(8n);
    const runOffset = view.getUint16(offset + 32, true);
    const runHeader = record[offset + runOffset];
    const lengthBytes = runHeader & 0x0f;
    const lcnBytes = runHeader >> 4;
    expect(record[offset + runOffset + 1]).toBe(1);
    let bitmapLcn = 0;
    for (let i = 0; i < lcnBytes; i++) {
      bitmapLcn += record[offset + runOffset + 1 + lengthBytes + i] * 2 ** (i * 8);
    }
    const bitmap = await reader.read(bitmapLcn * 4096, 8);
    expect(bitmap[0]).toBe(0xff);
    expect(bitmap[1]).toBe(0xff);
    expect(bitmap[3] & 0x07).toBe(0x07); // $Quota, $ObjId, $Reparse.

    const volumeBitmap = await reader.read((bitmapLcn + 1) * 4096, Math.floor(bitmapLcn / 8) + 1);
    expect(volumeBitmap[bitmapLcn >> 3] & (1 << (bitmapLcn & 7))).not.toBe(0);
  });

  it('should encode NTFS directory and view-index flags in the correct fields', async () => {
    const vfs = VirtualFS.createNew('ntfs', 'NTFS_FLAGS', '64');
    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);
    const vbr = await reader.read(0, 512);
    const mftOffset = Number(new DataView(vbr.buffer, vbr.byteOffset).getBigUint64(48, true)) * 4096;

    const readAttributeFlags = async (recordNumber: number, attributeType: number): Promise<number> => {
      const record = await reader.read(mftOffset + recordNumber * 1024, 1024);
      const view = new DataView(record.buffer, record.byteOffset);
      let offset = view.getUint16(20, true);
      while (offset + 8 <= record.length) {
        const type = view.getUint32(offset, true);
        if (type === 0xffffffff) break;
        const length = view.getUint32(offset + 4, true);
        if (type === attributeType && record[offset + 8] === 0) {
          const valueOffset = view.getUint16(offset + 20, true);
          return view.getUint32(offset + valueOffset + 56, true);
        }
        offset += length;
      }
      throw new Error(`Attribute 0x${attributeType.toString(16)} not found in record ${recordNumber}`);
    };

    expect(await readAttributeFlags(5, 0x30) & NTFS_FILE_ATTR_I30_INDEX_PRESENT).toBe(NTFS_FILE_ATTR_I30_INDEX_PRESENT);
    expect(await readAttributeFlags(9, 0x30) & NTFS_FILE_ATTR_VIEW_INDEX_PRESENT).toBe(NTFS_FILE_ATTR_VIEW_INDEX_PRESENT);
    expect(await readAttributeFlags(11, 0x30) & NTFS_FILE_ATTR_I30_INDEX_PRESENT).toBe(NTFS_FILE_ATTR_I30_INDEX_PRESENT);

    for (const recordNumber of [3, 4, 5, 7]) {
      const record = await reader.read(mftOffset + recordNumber * 1024, 1024);
      const view = new DataView(record.buffer, record.byteOffset);
      let offset = view.getUint16(20, true);
      let hasSecurityDescriptor = false;
      while (offset + 8 <= record.length) {
        const type = view.getUint32(offset, true);
        if (type === 0xffffffff) break;
        const length = view.getUint32(offset + 4, true);
        if (type === 0x50) {
          hasSecurityDescriptor = true;
          break;
        }
        offset += length;
      }
      expect(hasSecurityDescriptor).toBe(true);
    }
  });

  it('should reserve the NTFS MFT system slots 12 through 15', async () => {
    const vfs = VirtualFS.createNew('ntfs', 'MFT_RESERVED', '64');
    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);
    const vbr = await reader.read(0, 512);
    const mftOffset = Number(new DataView(vbr.buffer, vbr.byteOffset).getBigUint64(48, true)) * 4096;

    for (let recordNumber = 12; recordNumber < 16; recordNumber++) {
      const record = await reader.read(mftOffset + recordNumber * 1024, 1024);
      const view = new DataView(record.buffer, record.byteOffset);
      expect(String.fromCharCode(...record.slice(0, 4))).toBe('FILE');
      expect(view.getUint16(16, true)).toBe(recordNumber);
      expect(view.getUint16(18, true)).toBe(1);
      expect(view.getUint16(22, true) & 0x01).toBe(0x01);
    }

    // Records 12..15 occupy the high nibble of the second byte of the
    // nonresident $MFT::$BITMAP stream.
    const record0 = await reader.read(mftOffset, 1024);
    const record0View = new DataView(record0.buffer, record0.byteOffset);
    let attrOffset = record0View.getUint16(20, true);
    let mftBitmap: Uint8Array | undefined;
    while (attrOffset + 8 <= record0.length) {
      const type = record0View.getUint32(attrOffset, true);
      if (type === 0xffffffff) break;
      const length = record0View.getUint32(attrOffset + 4, true);
      if (type === 0xb0) {
        expect(record0[attrOffset + 8]).toBe(1);
        const runOffset = attrOffset + record0View.getUint16(attrOffset + 32, true);
        const runHeader = record0[runOffset];
        const countBytes = runHeader & 0x0f;
        const lcnBytes = runHeader >> 4;
        let lcn = 0;
        for (let i = 0; i < lcnBytes; i++) {
          lcn += record0[runOffset + 1 + countBytes + i] * 2 ** (i * 8);
        }
        mftBitmap = await reader.read(lcn * 4096, 8);
        break;
      }
      attrOffset += length;
    }
    expect(mftBitmap).toBeDefined();
    expect(mftBitmap![1] & 0xf0).toBe(0xf0);
  });

  it('should create the NTFS 3.1 $Extend view-index files and indexes', async () => {
    const vfs = VirtualFS.createNew('ntfs', 'EXTEND_FILES', '64');
    for (let i = 0; i < 10; i++) {
      vfs.addFile('/', `USER${i}.TXT`, new Uint8Array([i]));
    }
    const blob = await vfs.buildImageBlob();
    const reader = new BlobReader(blob);
    const vbr = await reader.read(0, 512);
    const mftOffset = Number(new DataView(vbr.buffer, vbr.byteOffset).getBigUint64(48, true)) * 4096;

    const readRecord = async (recordNumber: number) => reader.read(mftOffset + recordNumber * 1024, 1024);
    const readAttributeNames = (record: Uint8Array): string[] => {
      const view = new DataView(record.buffer, record.byteOffset);
      const names: string[] = [];
      let offset = view.getUint16(20, true);
      while (offset + 8 <= record.length) {
        const type = view.getUint32(offset, true);
        if (type === 0xffffffff) break;
        const length = view.getUint32(offset + 4, true);
        if (type === 0x90) {
          const nameLength = record[offset + 9];
          const nameOffset = view.getUint16(offset + 10, true);
          let name = '';
          for (let i = 0; i < nameLength; i++) {
            name += String.fromCharCode(view.getUint16(offset + nameOffset + i * 2, true));
          }
          names.push(name);
        }
        offset += length;
      }
      return names;
    };

    const readIndexCollations = (record: Uint8Array): Record<string, number> => {
      const view = new DataView(record.buffer, record.byteOffset);
      const collations: Record<string, number> = {};
      let offset = view.getUint16(20, true);
      while (offset + 8 <= record.length) {
        const type = view.getUint32(offset, true);
        if (type === 0xffffffff) break;
        const length = view.getUint32(offset + 4, true);
        if (type === 0x90) {
          const nameLength = record[offset + 9];
          const nameOffset = view.getUint16(offset + 10, true);
          let name = '';
          for (let i = 0; i < nameLength; i++) {
            name += String.fromCharCode(view.getUint16(offset + nameOffset + i * 2, true));
          }
          const valueOffset = view.getUint16(offset + 20, true);
          collations[name] = view.getUint32(offset + valueOffset + 4, true);
        }
        offset += length;
      }
      return collations;
    };

    for (const [recordNumber, name, indexName] of [
      [24, '$Quota', '$Q'],
      [25, '$ObjId', '$O'],
      [26, '$Reparse', '$R'],
    ] as const) {
      const record = await readRecord(recordNumber);
      const view = new DataView(record.buffer, record.byteOffset);
      expect(String.fromCharCode(...record.slice(0, 4))).toBe('FILE');
      expect(view.getUint16(22, true) & 0x0d).toBe(0x0d);
      expect(new TextDecoder('utf-16le').decode(record.slice(56 + 96 + 24 + 66, 56 + 96 + 24 + 66 + name.length * 2))).toBe(name);
      expect(readAttributeNames(record)).toContain(indexName);
    }

    const quotaAttributeNames = readAttributeNames(await readRecord(24));
    expect(quotaAttributeNames).toEqual(['$O', '$Q']);
    expect(readIndexCollations(await readRecord(24))).toEqual({ '$O': 0x11, '$Q': 0x10 });
    expect(readIndexCollations(await readRecord(25))).toEqual({ '$O': 0x13 });

    const extend = await readRecord(11);
    const extendText = new TextDecoder('utf-16le').decode(extend);
    expect(extendText).toContain('$Quota');
    expect(extendText).toContain('$ObjId');
    expect(extendText).toContain('$Reparse');

    const volume = await readRecord(3);
    expect(new TextDecoder('utf-16le').decode(volume)).toContain('$Volume');
  });
});
