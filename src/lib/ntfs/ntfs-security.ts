// NTFS 3.1 Security Descriptors ($SDS, $SDH, $SII)
// Generated according to reference Microsoft NTFS 3.1 specifications and ntfs-3g / mkntfs

export const NTFS_DEFAULT_FILE_SECURITY_ID = 0x0102;
// The custom file descriptor body is 0x7c bytes; its $SDS entry length also
// includes the 0x14-byte SDS header.
export const NTFS_DEFAULT_SDS_ENTRY_LENGTH = 0x14 + 0x7c;
export const NTFS_SDS_DATA_SIZE = 0x40000 + 0x100 + NTFS_DEFAULT_SDS_ENTRY_LENGTH;

export function generateSdsData(): Uint8Array {
  // Descriptors are stored at aligned offsets 0, 0x80, and 0x100. The first
  // two SDS entries are 0x7c bytes total; the custom third entry is 0x90.
  const SDS_FIRST_SIZE = 0x100 + NTFS_DEFAULT_SDS_ENTRY_LENGTH;
  const SDS_TOTAL_SIZE = 0x40000 + SDS_FIRST_SIZE; // 262544 bytes
  const buf = new Uint8Array(SDS_TOTAL_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset);

  // Helper to write Security Descriptor (124 bytes)
  function writeDescriptor(offset: number, hash: number, secId: number, fileOffset: bigint, aceMask: number) {
    // 1. SDS Header (20 bytes)
    view.setUint32(offset + 0, hash, true);
    view.setUint32(offset + 4, secId, true);
    view.setBigUint64(offset + 8, fileOffset, true);
    view.setUint32(offset + 16, 0x7C, true); // length = 124 bytes

    // 2. Relative Security Descriptor (starts at offset + 20)
    const sdOff = offset + 20;
    buf[sdOff + 0] = 1; // Revision
    buf[sdOff + 1] = 0; // Alignment
    view.setUint16(sdOff + 2, 0x8004, true); // SE_SELF_RELATIVE | SE_DACL_PRESENT
    view.setUint32(sdOff + 4, 0x48, true); // Owner offset
    view.setUint32(sdOff + 8, 0x58, true); // Group offset
    view.setUint32(sdOff + 12, 0, true);   // SACL offset
    view.setUint32(sdOff + 16, 0x14, true); // DACL offset (20 bytes from sdOff)

    // 3. ACL (starts at sdOff + 0x14 = offset + 40)
    const aclOff = sdOff + 0x14;
    buf[aclOff + 0] = 2; // ACL revision
    buf[aclOff + 1] = 0; // Alignment
    view.setUint16(aclOff + 2, 0x34, true); // ACL size = 52 bytes
    view.setUint16(aclOff + 4, 2, true);    // ACE count = 2
    view.setUint16(aclOff + 6, 0, true);

    // 4. ACE 1: SYSTEM (starts at aclOff + 8 = offset + 48, size = 20 bytes)
    const ace1Off = aclOff + 8;
    buf[ace1Off + 0] = 0; // ACCESS_ALLOWED_ACE_TYPE
    buf[ace1Off + 1] = 0; // Flags
    view.setUint16(ace1Off + 2, 0x14, true); // ACE size = 20 bytes
    view.setUint32(ace1Off + 4, aceMask, true);
    // SID S-1-5-18 (SYSTEM)
    buf[ace1Off + 8] = 1;  // SID revision
    buf[ace1Off + 9] = 1;  // Sub-authority count = 1
    // Identifier authority: [0, 0, 0, 0, 0, 5]
    buf[ace1Off + 10] = 0; buf[ace1Off + 11] = 0; buf[ace1Off + 12] = 0;
    buf[ace1Off + 13] = 0; buf[ace1Off + 14] = 0; buf[ace1Off + 15] = 5;
    view.setUint32(ace1Off + 16, 18, true); // SECURITY_LOCAL_SYSTEM_RID

    // 5. ACE 2: Administrators (starts at ace1Off + 20 = offset + 68, size = 24 bytes)
    const ace2Off = ace1Off + 20;
    buf[ace2Off + 0] = 0;
    buf[ace2Off + 1] = 0;
    view.setUint16(ace2Off + 2, 0x18, true); // ACE size = 24 bytes
    view.setUint32(ace2Off + 4, aceMask, true);
    // SID S-1-5-32-544 (Administrators)
    buf[ace2Off + 8] = 1;  // SID revision
    buf[ace2Off + 9] = 2;  // Sub-authority count = 2
    buf[ace2Off + 10] = 0; buf[ace2Off + 11] = 0; buf[ace2Off + 12] = 0;
    buf[ace2Off + 13] = 0; buf[ace2Off + 14] = 0; buf[ace2Off + 15] = 5;
    view.setUint32(ace2Off + 16, 32, true);  // SECURITY_BUILTIN_DOMAIN_RID
    view.setUint32(ace2Off + 20, 544, true); // DOMAIN_ALIAS_RID_ADMINS

    // 6. Owner SID: Administrators (starts at sdOff + 0x48 = offset + 92, size = 16 bytes)
    const ownerOff = sdOff + 0x48;
    buf[ownerOff + 0] = 1;
    buf[ownerOff + 1] = 2;
    buf[ownerOff + 2] = 0; buf[ownerOff + 3] = 0; buf[ownerOff + 4] = 0;
    buf[ownerOff + 5] = 0; buf[ownerOff + 6] = 0; buf[ownerOff + 7] = 5;
    view.setUint32(ownerOff + 8, 32, true);
    view.setUint32(ownerOff + 12, 544, true);

    // 7. Group SID: Administrators (starts at sdOff + 0x58 = offset + 108, size = 16 bytes)
    const groupOff = sdOff + 0x58;
    buf[groupOff + 0] = 1;
    buf[groupOff + 1] = 2;
    buf[groupOff + 2] = 0; buf[groupOff + 3] = 0; buf[groupOff + 4] = 0;
    buf[groupOff + 5] = 0; buf[groupOff + 6] = 0; buf[groupOff + 7] = 5;
    view.setUint32(groupOff + 8, 32, true);
    view.setUint32(groupOff + 12, 544, true);
  }

  // Security Descriptor #1: sec_id = 0x100, hash = 0xF80312F0, mask = 0x120089
  writeDescriptor(0x00, 0xF80312F0, 0x0100, 0x00n, 0x120089);

  // Security Descriptor #2: sec_id = 0x101, hash = 0x00B32451, mask = 0x12019F
  writeDescriptor(0x80, 0x00B32451, 0x0101, 0x80n, 0x12019F);

  const defaultDescriptor = generateDefaultFileSecurityDescriptor();
  view.setUint32(0x100, hashSecurityDescriptor(defaultDescriptor), true);
  view.setUint32(0x104, NTFS_DEFAULT_FILE_SECURITY_ID, true);
  view.setBigUint64(0x108, 0x100n, true);
  view.setUint32(0x110, NTFS_DEFAULT_SDS_ENTRY_LENGTH, true);
  buf.set(defaultDescriptor, 0x114);

  // Mirror all populated descriptors at 0x40000.
  buf.set(buf.subarray(0, SDS_FIRST_SIZE), 0x40000);

  return buf;
}

function generateDefaultFileSecurityDescriptor(): Uint8Array {
  // SYSTEM, Administrators, and Authenticated Users receive full file access.
  const descriptor = new Uint8Array(0x7c);
  const view = new DataView(descriptor.buffer, descriptor.byteOffset);
  descriptor[0] = 1;
  view.setUint16(2, 0x8004, true); // Self-relative, DACL present
  view.setUint32(4, 0x5c, true); // Owner: Administrators
  view.setUint32(8, 0x6c, true); // Group: Administrators
  view.setUint32(16, 0x14, true); // DACL offset

  const acl = 0x14;
  descriptor[acl] = 2;
  view.setUint16(acl + 2, 0x48, true);
  view.setUint16(acl + 4, 3, true);

  const aceDefinitions = [
    { sid: [18], size: 20 }, // SYSTEM
    { sid: [32, 544], size: 24 }, // Administrators
    { sid: [11], size: 20 }, // Authenticated Users
  ];
  let aceOffset = acl + 8;
  for (const ace of aceDefinitions) {
    descriptor[aceOffset] = 0; // ACCESS_ALLOWED_ACE_TYPE
    view.setUint16(aceOffset + 2, ace.size, true);
    view.setUint32(aceOffset + 4, 0x001f01ff, true); // FILE_ALL_ACCESS
    writeSid(descriptor, aceOffset + 8, ace.sid[0], ace.sid[1]);
    aceOffset += ace.size;
  }

  writeSid(descriptor, 0x5c, 32, 544);
  writeSid(descriptor, 0x6c, 32, 544);
  return descriptor;
}

function hashSecurityDescriptor(descriptor: Uint8Array): number {
  const view = new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength);
  let hash = 0;
  for (let offset = 0; offset < descriptor.byteLength; offset += 4) {
    const rotated = ((hash << 3) | (hash >>> 29)) >>> 0;
    hash = (view.getUint32(offset, true) + rotated) >>> 0;
  }
  return hash;
}

export function getDefaultFileSecurityDescriptorHash(): number {
  return hashSecurityDescriptor(generateDefaultFileSecurityDescriptor());
}

/**
 * The system-file compatibility records carry the self-relative descriptor
 * itself as a resident 0x50 attribute. This is the descriptor body from the
 * first $SDS entry (the 20-byte $SDS header is not part of the attribute).
 */
export function generateSystemSecurityDescriptor(): Uint8Array {
  // NTFS-3G's system-file descriptor is a 0x64-byte self-relative security
  // descriptor: SYSTEM and Administrators are granted access, with the
  // owner/group SIDs stored at the offsets advertised by the header.
  const buf = new Uint8Array(0x64);
  const view = new DataView(buf.buffer, buf.byteOffset);
  buf[0] = 1; // revision
  view.setUint16(2, 0x8004, true); // self-relative + DACL present
  view.setUint32(4, 0x48, true); // owner SID
  view.setUint32(8, 0x54, true); // group SID
  view.setUint32(16, 0x14, true); // DACL

  const acl = 0x14;
  buf[acl] = 2; // ACL revision
  view.setUint16(acl + 2, 0x34, true);
  view.setUint16(acl + 4, 2, true);

  const systemAce = acl + 8;
  view.setUint16(systemAce + 2, 0x14, true);
  view.setUint32(systemAce + 4, 0x120089, true);
  writeSid(buf, systemAce + 8, 18);

  const adminAce = systemAce + 0x14;
  view.setUint16(adminAce + 2, 0x18, true);
  view.setUint32(adminAce + 4, 0x12019f, true);
  writeSid(buf, adminAce + 8, 32, 544);

  writeSid(buf, 0x48, 18);
  writeSid(buf, 0x54, 32, 544);
  return buf;
}

/**
 * The volume root needs a directory ACL, not the SYSTEM/Administrators-only
 * descriptor used by protected NTFS metadata files. This Windows-formatted
 * NTFS 3.1 root ACL allows authenticated users to
 * enumerate the root and gives the built-in Users group read/traverse access.
 * Inheritable ACEs preserve the expected permissions for children.
 */
export function generateRootDirectorySecurityDescriptor(): Uint8Array {
  const aceDefinitions = [
    { sid: [32, 544], flags: 0, mask: 0x001f01ff | 0x00000100 | 0x00000001 | 0x00000002 | 0x00000004 | 0x00000008 | 0x00000010 | 0x00000020 | 0x00000080 | 0x00010000 },
    { sid: [32, 544], flags: 0x0b, mask: 0x10000000 }, // Administrators: inheritable full access
    { sid: [18], flags: 0, mask: 0x001f01ff | 0x00000100 | 0x00000001 | 0x00000002 | 0x00000004 | 0x00000008 | 0x00000010 | 0x00000020 | 0x00000080 | 0x00010000 },
    { sid: [18], flags: 0x0b, mask: 0x10000000 }, // SYSTEM: inheritable full access
    { sid: [11], flags: 0, mask: 0x00100000 | 0x00020000 | 0x00010000 | 0x00000100 | 0x00000080 | 0x00000020 | 0x00000010 | 0x00000008 | 0x00000004 | 0x00000002 | 0x00000001 },
    { sid: [11], flags: 0x0b, mask: 0x10000000 | 0x40000000 | 0x20000000 | 0x00010000 },
    { sid: [32, 545], flags: 0, mask: 0x00100000 | 0x00020000 | 0x00000080 | 0x00000020 | 0x00000008 | 0x00000001 },
    { sid: [32, 545], flags: 0x0b, mask: 0x10000000 | 0x20000000 },
  ];
  // Match the NTFS 3.1 formatter layout: a 4 KiB ACL, followed by the owner
  // and group SIDs. The descriptor is stored nonresident because it does not
  // fit in a 1 KiB MFT record.
  const aclSize = 0x1000;
  const ownerOffset = 20 + aclSize;
  const groupOffset = ownerOffset + 12;
  const buf = new Uint8Array(groupOffset + 12);
  const view = new DataView(buf.buffer, buf.byteOffset);

  buf[0] = 1;
  view.setUint16(2, 0x8004, true); // SE_SELF_RELATIVE | SE_DACL_PRESENT
  view.setUint32(4, ownerOffset, true);
  view.setUint32(8, groupOffset, true);
  view.setUint32(16, 20, true); // DACL follows the relative descriptor

  const acl = 20;
  buf[acl] = 2;
  view.setUint16(acl + 2, aclSize, true);
  view.setUint16(acl + 4, aceDefinitions.length, true);

  let aceOffset = acl + 8;
  for (const ace of aceDefinitions) {
    const aceSize = 16 + 4 * ace.sid.length;
    buf[aceOffset] = 0; // ACCESS_ALLOWED_ACE_TYPE
    buf[aceOffset + 1] = ace.flags;
    view.setUint16(aceOffset + 2, aceSize, true);
    view.setUint32(aceOffset + 4, ace.mask, true);
    writeSid(buf, aceOffset + 8, ace.sid[0], ace.sid[1]);
    aceOffset += aceSize;
  }

  writeSid(buf, ownerOffset, 18); // SYSTEM owner
  writeSid(buf, groupOffset, 18); // SYSTEM primary group
  return buf;
}

function writeSid(buffer: Uint8Array, offset: number, firstSubAuthority: number, secondSubAuthority?: number): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  buffer[offset] = 1;
  buffer[offset + 1] = secondSubAuthority === undefined ? 1 : 2;
  buffer[offset + 7] = 5; // S-1-5
  view.setUint32(offset + 8, firstSubAuthority, true);
  if (secondSubAuthority !== undefined) {
    view.setUint32(offset + 12, secondSubAuthority, true);
  }
}

export function buildSdhIndexEntries(): Uint8Array {
  const descriptors = [
    { hash: 0x00B32451, secId: 0x0101, sdsOffset: 0x80n, length: 0x7c },
    { hash: 0xF80312F0, secId: 0x0100, sdsOffset: 0x00n, length: 0x7c },
    { hash: getDefaultFileSecurityDescriptorHash(), secId: NTFS_DEFAULT_FILE_SECURITY_ID, sdsOffset: 0x100n, length: NTFS_DEFAULT_SDS_ENTRY_LENGTH },
  ].sort((a, b) => a.hash - b.hash || a.secId - b.secId);
  const entrySize = 0x30;
  const endOffset = descriptors.length * entrySize;
  const totalLen = endOffset + 0x10;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer, buf.byteOffset);

  function writeSdhEntry(pos: number, hash: number, secId: number, sdsOffset: bigint, length: number) {
    view.setUint16(pos + 0x00, 0x18, true); // data_offset
    view.setUint16(pos + 0x02, 0x14, true); // data_length
    view.setUint32(pos + 0x04, 0x00, true); // reserved
    view.setUint16(pos + 0x08, 0x30, true); // entry length = 48
    view.setUint16(pos + 0x0A, 0x08, true); // key_length = 8
    view.setUint16(pos + 0x0C, 0x00, true); // flags
    view.setUint16(pos + 0x0E, 0x00, true); // reserved
    // Key (offset 0x10)
    view.setUint32(pos + 0x10, hash, true);
    view.setUint32(pos + 0x14, secId, true);
    // Data (offset 0x18)
    view.setUint32(pos + 0x18, hash, true);
    view.setUint32(pos + 0x1C, secId, true);
    view.setBigUint64(pos + 0x20, sdsOffset, true);
    view.setUint32(pos + 0x28, length, true);
    view.setUint32(pos + 0x2C, 0x00490049, true); // reserved_II
  }

  descriptors.forEach((descriptor, index) => {
    writeSdhEntry(index * entrySize, descriptor.hash, descriptor.secId, descriptor.sdsOffset, descriptor.length);
  });
  view.setUint16(endOffset + 0x08, 0x10, true); // End entry length
  view.setUint16(endOffset + 0x0C, 0x02, true); // INDEX_ENTRY_END

  return buf;
}

export function buildSiiIndexEntries(): Uint8Array {
  const descriptors = [
    { hash: 0xF80312F0, secId: 0x0100, sdsOffset: 0x00n, length: 0x7c },
    { hash: 0x00B32451, secId: 0x0101, sdsOffset: 0x80n, length: 0x7c },
    { hash: getDefaultFileSecurityDescriptorHash(), secId: NTFS_DEFAULT_FILE_SECURITY_ID, sdsOffset: 0x100n, length: NTFS_DEFAULT_SDS_ENTRY_LENGTH },
  ].sort((a, b) => a.secId - b.secId);
  const entrySize = 0x28;
  const endOffset = descriptors.length * entrySize;
  const totalLen = endOffset + 0x10;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer, buf.byteOffset);

  function writeSiiEntry(pos: number, hash: number, secId: number, sdsOffset: bigint, length: number) {
    view.setUint16(pos + 0x00, 0x14, true); // data_offset
    view.setUint16(pos + 0x02, 0x14, true); // data_length
    view.setUint32(pos + 0x04, 0x00, true); // reserved
    view.setUint16(pos + 0x08, 0x28, true); // entry length = 40
    view.setUint16(pos + 0x0A, 0x04, true); // key_length = 4
    view.setUint16(pos + 0x0C, 0x00, true); // flags
    view.setUint16(pos + 0x0E, 0x00, true); // reserved
    // Key (offset 0x10)
    view.setUint32(pos + 0x10, secId, true);
    // Data (offset 0x14)
    view.setUint32(pos + 0x14, hash, true);
    view.setUint32(pos + 0x18, secId, true);
    view.setBigUint64(pos + 0x1C, sdsOffset, true);
    view.setUint32(pos + 0x24, length, true);
  }

  descriptors.forEach((descriptor, index) => {
    writeSiiEntry(index * entrySize, descriptor.hash, descriptor.secId, descriptor.sdsOffset, descriptor.length);
  });
  view.setUint16(endOffset + 0x08, 0x10, true); // End entry length
  view.setUint16(endOffset + 0x0C, 0x02, true); // INDEX_ENTRY_END

  return buf;
}
