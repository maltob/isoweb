import { describe, expect, it } from 'vitest';
import { XfsBuilder } from '../lib/xfs/xfs-builder';
import { XfsParser } from '../lib/xfs/xfs-parser';
import { BlobAccumulatorWriter } from '../lib/storage/stream-writer';
import { BlobReader } from '../lib/reader';
import { VNode } from '../lib/types';
import { readUint16BE, readUint32BE, readUint64BE, XFS_SB_MAGIC, XFS_SB_V5_VERS_FLAGS } from '../lib/xfs/xfs-types';

describe('XFS Standalone Filesystem Builder & Parser', () => {
  it('should format a valid XFS v5 filesystem and parse back directory hierarchy & files', async () => {
    const rootNode: VNode = {
      id: 'root',
      name: '/',
      path: '/',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date('2026-01-01T00:00:00Z'),
      children: [],
    };

    const textData = new TextEncoder().encode('Hello XFS world on Linux!');
    const sampleBinary = new Uint8Array(8192); // 2 blocks (4096 each)
    for (let i = 0; i < sampleBinary.length; i++) {
      sampleBinary[i] = (i * 31) & 0xff;
    }

    const testFile: VNode = {
      id: 'file-1',
      name: 'GREETING.TXT',
      path: '/GREETING.TXT',
      isDirectory: false,
      size: textData.byteLength,
      modifiedTime: new Date('2026-01-01T00:00:00Z'),
      data: textData,
    };
    rootNode.children!.push(testFile);

    const subDir: VNode = {
      id: 'dir-1',
      name: 'DOCS',
      path: '/DOCS',
      isDirectory: true,
      size: 0,
      modifiedTime: new Date('2026-01-01T00:00:00Z'),
      children: [],
    };
    rootNode.children!.push(subDir);

    const binFile: VNode = {
      id: 'file-2',
      name: 'DATA.BIN',
      path: '/DOCS/DATA.BIN',
      isDirectory: false,
      size: sampleBinary.byteLength,
      modifiedTime: new Date('2026-01-01T00:00:00Z'),
      data: sampleBinary,
    };
    subDir.children!.push(binFile);

    // Build XFS to stream
    const builder = new XfsBuilder(rootNode, {
      volumeLabel: 'TEST_XFS',
      partitionSectors: 65536, // 32 MB
    });

    const writer = new BlobAccumulatorWriter('application/octet-stream');
    await builder.buildToStream(writer);
    const blob = writer.getBlob();
    expect(blob.size).toBeGreaterThan(0);

    const reader = new BlobReader(blob);

    // Verify Superblock Magic 'XFSB' and versionnum flags
    const sb = await reader.read(0, 512);
    expect(readUint32BE(sb, 0)).toBe(XFS_SB_MAGIC);
    expect(readUint64BE(sb, 56)).toBe(4192n); // rootino (aligned at block 524 << 3 = 4192)
    expect(readUint64BE(sb, 64)).toBe(4193n); // rbmino (rootino + 1)
    expect(readUint64BE(sb, 72)).toBe(4194n); // rsumino (rootino + 2)
    expect(readUint32BE(sb, 80)).toBe(1); // rextsize must be 1 (4096 bytes) to satisfy XFS_MIN_RTEXTSIZE
    expect(readUint16BE(sb, 100)).toBe(XFS_SB_V5_VERS_FLAGS);
    expect(readUint32BE(sb, 180)).toBe(4); // inoalignmt (4 blocks for 512B inodes on 4KB blocks)

    // Verify log geometry in superblock (fixes "bad primary superblock - inconsistent log geometry information")
    const logstart = readUint64BE(sb, 48);
    const logblocks = readUint32BE(sb, 96);
    expect(logstart).toBe(8n);
    expect(logblocks).toBeGreaterThanOrEqual(64);

    // Verify internal journal log is cleanly zeroed (as in mkfs.xfs, head 0 tail 0)
    const logHeaderBytes = await reader.read(Number(logstart) * 4096, 512);
    expect(logHeaderBytes.every((b) => b === 0)).toBe(true);

    // Parse with XfsParser
    const parser = new XfsParser(reader, 0);
    const parsed = await parser.parse();

    expect(parsed.info.format).toBe('xfs');
    expect(parsed.info.volumeLabel).toBe('TEST_XFS');

    // Find and verify GREETING.TXT
    const foundGreeting = parsed.root.children?.find((c) => c.name === 'GREETING.TXT');
    expect(foundGreeting).toBeDefined();
    expect(foundGreeting?.isDirectory).toBe(false);
    expect(foundGreeting?.size).toBe(textData.byteLength);

    const greetingBytes = await parser.readFileData(foundGreeting!);
    expect(new TextDecoder().decode(greetingBytes)).toBe('Hello XFS world on Linux!');

    // Find and verify DOCS directory
    const foundDocs = parsed.root.children?.find((c) => c.name === 'DOCS');
    expect(foundDocs).toBeDefined();
    expect(foundDocs?.isDirectory).toBe(true);

    // Find and verify DATA.BIN inside DOCS
    const foundBin = foundDocs?.children?.find((c) => c.name === 'DATA.BIN');
    expect(foundBin).toBeDefined();
    expect(foundBin?.size).toBe(sampleBinary.byteLength);

    const binBytes = await parser.readFileData(foundBin!);
    expect(binBytes).toEqual(sampleBinary);
  });
});
