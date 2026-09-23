// High-performance NTFS volume builder
// Formats standard NTFS partitions with zero-RAM chunked streaming
// Reference: Microsoft NTFS Technical Reference & File System Forensic Analysis
import { ImageStreamWriter } from '../storage/stream-writer';
import { VNode } from '../types';
import { IFileSystemBuilder, PartitionBuilderOptions } from '../filesystem/fs-types';
import {
  dateToFileTime,
  NTFS_FILE_RECORD_SIZE,
  NTFS_OEM_NAME,
  NTFS_SECTOR_SIZE,
  NtfsAttributeType,
  NtfsFileFlags,
  NtfsGeometry,
  NtfsSystemFile,
  NTFS_FILE_ATTR_I30_INDEX_PRESENT,
  NTFS_FILE_ATTR_VIEW_INDEX_PRESENT,
} from './ntfs-types';
import { getNtfs3xAttrDef } from './ntfs-attrdef';
import {
  generateSdsData,
  generateRootDirectorySecurityDescriptor,
  generateSystemSecurityDescriptor,
  buildSdhIndexEntries,
  buildSiiIndexEntries,
  NTFS_DEFAULT_FILE_SECURITY_ID,
  NTFS_SDS_DATA_SIZE,
} from './ntfs-security';
import { generateNtfsUpcaseBuffer, compareNtfsFileNames } from './ntfs-upcase';

export { compareNtfsFileNames };

export function getRecordSequenceNumber(recordNumber: number): number {
  if (recordNumber <= 0 || recordNumber >= 12) {
    return 1;
  }
  if (recordNumber === 1) return 1;
  return recordNumber;
}

const ZERO_CLUSTER = new Uint8Array(4096);
const LOGFILE_CLUSTER_FILL = new Uint8Array(4096);
LOGFILE_CLUSTER_FILL.fill(0xff);

interface DirectoryChildEntry {
  recordNumber: number;
  name: string;
  isDir: boolean;
  size: number;
  allocatedSize: number;
  mtime: Date;
  fileFlags?: number;
}

interface AllocatedItem {
  node: VNode;
  recordNumber: number;
  startCluster: number;
  clusterCount: number;
  size: number;
  isDir: boolean;
  parentRecord: number;
  indexStartCluster?: number;
}

export class NtfsBuilder implements IFileSystemBuilder {
  private root: VNode;
  private volumeLabel: string;
  private totalSectors: number;
  private partitionOffset: number;
  private padToCapacity: boolean;
  private volumeTime: Date;

  constructor(
    root: VNode,
    options: PartitionBuilderOptions
  ) {
    this.root = root;
    this.volumeLabel = (options.volumeLabel || 'NTFS_DISK').slice(0, 32);
    this.totalSectors = Math.max(65536, options.partitionSectors); // Minimum 32MB for NTFS
    this.partitionOffset = options.partitionStartSector ?? 0;
    this.padToCapacity = options.padToCapacity ?? true;
    this.volumeTime = root.modifiedTime || new Date();
  }

  computeGeometry(): NtfsGeometry {
    const bytesPerSector = NTFS_SECTOR_SIZE; // 512
    const sectorsPerCluster = 8; // 4096 bytes per cluster
    const clusterSizeBytes = bytesPerSector * sectorsPerCluster;

    // Keep the final sector outside the usable NTFS sector count: it stores
    // the backup VBR. The resulting partial final cluster is excluded from
    // the usable cluster count and represented by the rounded-up bitmap bit.
    const totalSectors = this.totalSectors - 1;

    // Cluster Layout:
    // Cluster 0..1: $Boot (Cluster 0 = VBR, Cluster 1 = reserved)
    // Cluster 2: $MFTMirr (Mirror of first 4 MFT records)
    // Cluster 3: Reserved (zeros)
    // Cluster 4..: $LogFile, sized according to the volume
    // The next cluster is $MFT.
    const totalVolumeClusters = Math.floor(totalSectors / sectorsPerCluster);
    const volumeSizeBytes = totalVolumeClusters * clusterSizeBytes;
    let logFileBytes: number;
    if (volumeSizeBytes < 2 * 1024 * 1024) {
      logFileBytes = 256 * 1024;
    } else if (volumeSizeBytes < 4 * 1024 * 1024) {
      logFileBytes = 512 * 1024;
    } else if (volumeSizeBytes <= 200 * 1024 * 1024) {
      logFileBytes = 2 * 1024 * 1024;
    } else {
      logFileBytes = Math.floor(volumeSizeBytes / 200) & ~(clusterSizeBytes - 1);
    }
    const logFileCluster = 4;
    const logFileClusters = Math.max(1, Math.ceil(logFileBytes / clusterSizeBytes));
    const mftCluster = logFileCluster + logFileClusters;
    const mftMirrCluster = 2;

    const serialNumber = 0x5a17e001a1b2c3d4n;

    return {
      totalSectors,
      bytesPerSector,
      sectorsPerCluster,
      clusterSizeBytes,
      logFileClusterCount: logFileClusters,
      mftCluster,
      mftMirrCluster,
      mftRecordSize: NTFS_FILE_RECORD_SIZE,
      indexRecordSize: 4096,
      serialNumber,
      volumeLabel: this.volumeLabel,
    };
  }

  async buildToStream(
    writer: ImageStreamWriter,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    onProgress?.(0.05, 'Calculating NTFS geometry...');
    const geo = this.computeGeometry();

    // 1. Allocate MFT records and data clusters for all items
    onProgress?.(0.15, 'Allocating NTFS records and clusters...');
    const allocation = this.allocate(geo);

    // 2. Build VBR (Sector 0)
    onProgress?.(0.25, 'Generating NTFS Boot Record...');
    const vbrBytes = this.generateVbr(geo);
    await writer.write(vbrBytes);

    // Sectors 1..7: Reserved in Cluster 0
    await writer.write(new Uint8Array(7 * geo.bytesPerSector));

    // 3. Cluster 1: Reserved cluster (zeros)
    await writer.write(ZERO_CLUSTER);

    // 4. Cluster 2: $MFTMirr (Mirror of Records 0..3)
    onProgress?.(0.35, 'Writing $MFTMirr...');
    const mftMirrBytes = this.generateMftMirror(geo, allocation);
    await writer.write(mftMirrBytes);

    // 5. Cluster 3: Reserved cluster (zeros)
    await writer.write(ZERO_CLUSTER);

    // 6. Clusters 4..: $LogFile
    onProgress?.(0.4, 'Writing $LogFile...');
    for (let c = 0; c < geo.logFileClusterCount; c++) {
      await writer.write(LOGFILE_CLUSTER_FILL);
    }

    // 7. Cluster 68..: $MFT (Master File Table records)
    onProgress?.(0.45, 'Writing Master File Table ($MFT)...');
    const mftBytes = this.generateMft(geo, allocation);
    await writer.write(mftBytes);

    // 8. Stream Cluster Heap: Root $INDEX_ALLOCATION, $AttrDef, $Secure $SDS, $UpCase, User files, and $Bitmap
    onProgress?.(0.6, 'Streaming files and structures...');
    await this.streamDataAndBitmap(writer, geo, allocation, onProgress);

    // 9. Write Backup VBR at the very last sector of the volume (for raw images)
    if (this.padToCapacity) {
      const writtenBytes = allocation.totalAllocatedClusters * geo.clusterSizeBytes;
      const targetVolumeBytes = this.totalSectors * geo.bytesPerSector;
      const remainingBytes = targetVolumeBytes - writtenBytes;

      if (remainingBytes >= geo.bytesPerSector) {
        // Pad zeros up to the last sector
        const zeroPadBytes = remainingBytes - geo.bytesPerSector;
        const chunkSize = 1048576; // 1 MB
        const zeroChunk = new Uint8Array(chunkSize);
        let rem = zeroPadBytes;
        while (rem > 0) {
          const toWrite = Math.min(rem, chunkSize);
          await writer.write(zeroChunk.subarray(0, toWrite));
          rem -= toWrite;
        }
        // Write backup VBR at the last sector
        await writer.write(vbrBytes);
      }
    }

    onProgress?.(1.0, 'NTFS build complete.');
  }

  private allocate(geo: NtfsGeometry) {
    const items: AllocatedItem[] = [];
    let nextRecordNumber = NtfsSystemFile.UserFirst; // User records start at 16

    const allocateUserRecordNumber = (): number => {
      // NTFS 3.1 places the $Extend view-index files at records 24..26.
      // Keep user records out of those reserved slots.
      if (nextRecordNumber >= NtfsSystemFile.Quota && nextRecordNumber <= NtfsSystemFile.Reparse) {
        nextRecordNumber = NtfsSystemFile.Reparse + 1;
      }
      return nextRecordNumber++;
    };

    // Traverse directory tree to assign record numbers
    const assignRecords = (dirNode: VNode, parentRec: number) => {
      for (const child of dirNode.children || []) {
        const rec = allocateUserRecordNumber();
        const size = child.fileRef?.size ?? child.data?.byteLength ?? child.sourceLength ?? child.size ?? 0;
        const item: AllocatedItem = {
          node: child,
          recordNumber: rec,
          startCluster: 0,
          clusterCount: 0,
          size,
          isDir: child.isDirectory || (child.children && child.children.length > 0) || false,
          parentRecord: parentRec,
        };
        items.push(item);

        if (item.isDir) {
          assignRecords(child, rec);
        }
      }
    };
    assignRecords(this.root, NtfsSystemFile.RootDir);

    // Calculate total MFT records: 16 system records + user records (minimum 32)
    const totalRecords = Math.max(32, nextRecordNumber);
    const mftSizeBytes = totalRecords * geo.mftRecordSize;
    const mftClusterCount = Math.ceil(mftSizeBytes / geo.clusterSizeBytes);

    // Clusters layout:
    // Clusters 0..1: $Boot (2 clusters = 8192 bytes)
    // Cluster 2: $MFTMirr (1 cluster)
    // Cluster 3: Reserved (1 cluster)
    // Clusters 4..67: $LogFile (64 clusters = 256 KB)
    // Clusters 68..(68 + mftClusterCount - 1): $MFT
    let currentCluster = geo.mftCluster + mftClusterCount;

    // Root Directory $INDEX_ALLOCATION: 1 cluster (4096 bytes)
    const rootIndexStartCluster = currentCluster;
    const rootIndexClusterCount = 1;
    currentCluster += rootIndexClusterCount;

    // Windows' NTFS 3.1 root security descriptor uses a 4 KiB ACL and is
    // therefore stored nonresident. Keep it immediately after the root index.
    const rootSecurityDescriptorStartCluster = currentCluster;
    const rootSecurityDescriptorClusterCount = Math.ceil(0x102c / geo.clusterSizeBytes);
    currentCluster += rootSecurityDescriptorClusterCount;

    // Allocate clusters for user directories that have more than 4 items (need $INDEX_ALLOCATION)
    for (const item of items) {
      if (item.isDir && item.node.children && item.node.children.length > 4) {
        item.indexStartCluster = currentCluster;
        currentCluster += 1;
      }
    }

    // $AttrDef data: 2560 bytes -> 1 cluster
    const attrDefStartCluster = currentCluster;
    const attrDefClusterCount = 1;
    currentCluster += attrDefClusterCount;

    // $Secure $SDS data includes three indexed security descriptors.
    const sdsStartCluster = currentCluster;
    const sdsClusterCount = Math.ceil(NTFS_SDS_DATA_SIZE / geo.clusterSizeBytes);
    currentCluster += sdsClusterCount;

    // $UpCase table: 128KB = 32 clusters of 4KB
    const upCaseStartCluster = currentCluster;
    const upCaseClusterCount = 32;
    currentCluster += upCaseClusterCount;

    // Allocate clusters for non-resident files (> 600 bytes)
    for (const item of items) {
      if (!item.isDir && item.size > 600) {
        item.startCluster = currentCluster;
        item.clusterCount = Math.max(1, Math.ceil(item.size / geo.clusterSizeBytes));
        currentCluster += item.clusterCount;
      }
    }

    // The $MFT allocation bitmap must be nonresident. Keep its data in a
    // dedicated cluster immediately before the volume cluster bitmap.
    const mftBitmapStartCluster = currentCluster;
    currentCluster += 1;

    // $Bitmap: 1 bit per cluster
    const totalVolumeClusters = Math.floor(geo.totalSectors / geo.sectorsPerCluster);
    const bitmapSizeBytes = Math.ceil(totalVolumeClusters / 8);
    const bitmapClusterCount = Math.max(1, Math.ceil(bitmapSizeBytes / geo.clusterSizeBytes));
    const bitmapStartCluster = currentCluster;
    currentCluster += bitmapClusterCount;

    return {
      items,
      totalRecords,
      mftClusterCount,
      rootIndexStartCluster,
      rootIndexClusterCount,
      rootSecurityDescriptorStartCluster,
      rootSecurityDescriptorClusterCount,
      attrDefStartCluster,
      attrDefClusterCount,
      sdsStartCluster,
      sdsClusterCount,
      upCaseStartCluster,
      upCaseClusterCount,
      mftBitmapStartCluster,
      bitmapStartCluster,
      bitmapClusterCount,
      bitmapSizeBytes,
      totalAllocatedClusters: currentCluster,
      totalVolumeClusters,
    };
  }

  private generateVbr(geo: NtfsGeometry): Uint8Array {
    const vbr = new Uint8Array(geo.bytesPerSector);

    // 0x00: JMP SHORT 0x52, NOP
    vbr[0] = 0xeb;
    vbr[1] = 0x52;
    vbr[2] = 0x90;

    // 0x03: OEM ID "NTFS    "
    for (let i = 0; i < 8; i++) vbr[3 + i] = NTFS_OEM_NAME.charCodeAt(i);

    // BPB
    this.writeUint16LE(vbr, 11, geo.bytesPerSector); // Bytes per sector (512)
    vbr[13] = geo.sectorsPerCluster; // Sectors per cluster (8)
    this.writeUint16LE(vbr, 14, 0); // Reserved sectors (0)
    vbr[21] = 0xf8; // Media descriptor (Fixed disk)
    this.writeUint16LE(vbr, 24, 63); // Sectors per track
    this.writeUint16LE(vbr, 26, 255); // Number of heads
    this.writeUint32LE(vbr, 28, this.partitionOffset); // Hidden sectors (LBA offset)

    // 0x24: Physical drive (0x80 = hard disk)
    vbr[36] = 0x80;
    // 0x26: Extended boot signature (0x80)
    vbr[38] = 0x80;

    // Usable NTFS sectors; the partition's last sector is reserved for backup VBR.
    this.writeUint64LE(vbr, 40, geo.totalSectors);

    // $MFT starting cluster (64-bit LE)
    this.writeUint64LE(vbr, 48, geo.mftCluster);

    // $MFTMirr starting cluster (64-bit LE)
    this.writeUint64LE(vbr, 56, geo.mftMirrCluster);

    // Clusters per MFT Record: 0xF6 = -10 => 2^10 = 1024 bytes (record size < cluster size)
    vbr[64] = 0xf6;

    // Clusters per Index Record: 1 cluster = 4096 bytes (positive because indexRecordSize >= clusterSize)
    vbr[68] = 0x01;

    // Volume Serial Number (64-bit LE)
    this.writeBigUint64LE(vbr, 72, geo.serialNumber);

    // Boot signature at end
    vbr[510] = 0x55;
    vbr[511] = 0xaa;

    return vbr;
  }

  private buildEmptyMftRecord(recordNumber: number): Uint8Array {
    const builder = new MftRecordBuilder(
      recordNumber,
      false,
      getRecordSequenceNumber(recordNumber),
      0
    );
    return builder.finish();
  }

  private buildReservedSystemRecord(recordNumber: number): Uint8Array {
    const builder = new MftRecordBuilder(recordNumber, false, recordNumber, 0x01);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0000);
    builder.addResidentAttribute(NtfsAttributeType.SecurityDescriptor, generateSystemSecurityDescriptor());
    builder.addResidentAttribute(NtfsAttributeType.Data, new Uint8Array(0));
    return builder.finish();
  }

  private generateMft(
    geo: NtfsGeometry,
    allocation: ReturnType<typeof this.allocate>
  ): Uint8Array {
    const mftBytes = new Uint8Array(allocation.mftClusterCount * geo.clusterSizeBytes);

    // 0. Pre-format all MFT records in the allocated clusters as valid empty unallocated records
    const totalMftRecords = (allocation.mftClusterCount * geo.clusterSizeBytes) / geo.mftRecordSize;
    for (let r = 0; r < totalMftRecords; r++) {
      mftBytes.set(this.buildEmptyMftRecord(r), r * geo.mftRecordSize);
    }

    // Build Record 0: $MFT
    const rec0 = this.buildMftRecord0(geo, allocation);
    mftBytes.set(rec0, 0 * geo.mftRecordSize);

    // Build Record 1: $MFTMirr
    const rec1 = this.buildMftRecord1(geo, allocation);
    mftBytes.set(rec1, 1 * geo.mftRecordSize);

    // Build Record 2: $LogFile
    const rec2 = this.buildLogFileRecord(geo);
    mftBytes.set(rec2, 2 * geo.mftRecordSize);

    // Build Record 3: $Volume
    const rec3 = this.buildVolumeRecord(geo);
    mftBytes.set(rec3, 3 * geo.mftRecordSize);

    // Build Record 4: $AttrDef
    const rec4 = this.buildAttrDefRecord(geo, allocation);
    mftBytes.set(rec4, 4 * geo.mftRecordSize);

    // Build Record 5: Root Directory (.)
    const rec5 = this.buildDirectoryRecord(this.root, NtfsSystemFile.RootDir, NtfsSystemFile.RootDir, allocation, geo);
    mftBytes.set(rec5, 5 * geo.mftRecordSize);

    // Build Record 6: $Bitmap
    const rec6 = this.buildBitmapRecord(geo, allocation);
    mftBytes.set(rec6, 6 * geo.mftRecordSize);

    // Build Record 7: $Boot
    const rec7 = this.buildBootRecord(geo);
    mftBytes.set(rec7, 7 * geo.mftRecordSize);

    // Build Record 8: $BadClus
    const rec8 = this.buildBadClusRecord(geo);
    mftBytes.set(rec8, 8 * geo.mftRecordSize);

    // Build Record 9: $Secure
    const rec9 = this.buildSecureRecord(geo, allocation);
    mftBytes.set(rec9, 9 * geo.mftRecordSize);

    // Build Record 10: $UpCase
    const rec10 = this.buildUpCaseRecord(geo, allocation);
    mftBytes.set(rec10, 10 * geo.mftRecordSize);

    // Build Record 11: $Extend
    const rec11 = this.buildExtendRecord(geo);
    mftBytes.set(rec11, 11 * geo.mftRecordSize);

    // NTFS 3.1 reserves these view-index files in the MFT even on a fresh
    // volume. Their links live in $Extend and their named indexes must exist
    // before Windows will consider the metadata complete.
    const rec24 = this.buildQuotaRecord();
    mftBytes.set(rec24, NtfsSystemFile.Quota * geo.mftRecordSize);
    const rec25 = this.buildObjIdRecord();
    mftBytes.set(rec25, NtfsSystemFile.ObjId * geo.mftRecordSize);
    const rec26 = this.buildReparseRecord();
    mftBytes.set(rec26, NtfsSystemFile.Reparse * geo.mftRecordSize);

    // Records 12..15 are reserved system-file slots. They are not linked
    // into the root directory, but a freshly formatted NTFS volume still
    // marks them in-use with valid FILE records. Leaving them as unallocated
    // records makes the MFT bitmap disagree with the MFT contents during
    // CHKDSK's orphan scan.
    for (let recordNumber = 12; recordNumber < NtfsSystemFile.UserFirst; recordNumber++) {
      const reserved = this.buildReservedSystemRecord(recordNumber);
      mftBytes.set(reserved, recordNumber * geo.mftRecordSize);
    }

    // Build User Records (16+)
    for (const item of allocation.items) {
      const rec = item.isDir
        ? this.buildDirectoryRecord(item.node, item.recordNumber, item.parentRecord, allocation, geo, item)
        : this.buildFileRecord(item, geo);
      mftBytes.set(rec, item.recordNumber * geo.mftRecordSize);
    }

    return mftBytes;
  }

  private generateMftMirror(
    geo: NtfsGeometry,
    allocation: ReturnType<typeof this.allocate>
  ): Uint8Array {
    const mirror = new Uint8Array(4096);
    mirror.set(this.buildMftRecord0(geo, allocation), 0);
    mirror.set(this.buildMftRecord1(geo, allocation), 1024);
    mirror.set(this.buildLogFileRecord(geo), 2048);
    mirror.set(this.buildVolumeRecord(geo), 3072);
    return mirror;
  }

  // Record 0: $MFT
  private buildMftRecord0(geo: NtfsGeometry, allocation: ReturnType<typeof this.allocate>): Uint8Array {
    const builder = new MftRecordBuilder(0, false, 1);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0100);
    const mftBytesTotal = allocation.mftClusterCount * geo.clusterSizeBytes;
    builder.addFileName(5, '$MFT', mftBytesTotal, mftBytesTotal, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);

    // Non-resident $DATA for $MFT clusters
    builder.addNonResidentData(0, geo.mftCluster, allocation.mftClusterCount, mftBytesTotal, mftBytesTotal);

    // $MFT::$BITMAP is a nonresident metadata stream. The NTFS driver uses
    // its mapping to allocate file records; a resident bitmap is rejected.
    builder.addNonResidentData(
      0,
      allocation.mftBitmapStartCluster,
      1,
      geo.clusterSizeBytes,
      Math.max(8, Math.ceil(allocation.totalRecords / 8)),
      NtfsAttributeType.Bitmap
    );

    return builder.finish();
  }

  // Record 1: $MFTMirr
  private buildMftRecord1(geo: NtfsGeometry, _allocation: ReturnType<typeof this.allocate>): Uint8Array {
    const builder = new MftRecordBuilder(1, false, 1);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0100);
    builder.addFileName(5, '$MFTMirr', 4096, 4096, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);
    builder.addNonResidentData(0, geo.mftMirrCluster, 1, 4096, 4096);
    return builder.finish();
  }

  // Record 2: $LogFile
  private buildLogFileRecord(geo: NtfsGeometry): Uint8Array {
    const builder = new MftRecordBuilder(2, false, 2);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0100);
    const logSizeBytes = geo.logFileClusterCount * geo.clusterSizeBytes;
    builder.addFileName(5, '$LogFile', logSizeBytes, logSizeBytes, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);
    builder.addNonResidentData(0, 4, geo.logFileClusterCount, logSizeBytes, logSizeBytes);
    return builder.finish();
  }

  // Record 3: $Volume
  private buildVolumeRecord(_geo: NtfsGeometry): Uint8Array {
    const builder = new MftRecordBuilder(3, false, 3);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0000);
    builder.addFileName(5, '$Volume', 0, 0, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);
    builder.addResidentAttribute(NtfsAttributeType.SecurityDescriptor, generateSystemSecurityDescriptor());

    // $VOLUME_NAME attribute (0x60)
    const labelBytes = new Uint8Array(this.volumeLabel.length * 2);
    for (let i = 0; i < this.volumeLabel.length; i++) {
      labelBytes[i * 2] = this.volumeLabel.charCodeAt(i) & 0xff;
      labelBytes[i * 2 + 1] = (this.volumeLabel.charCodeAt(i) >> 8) & 0xff;
    }
    builder.addResidentAttribute(NtfsAttributeType.VolumeName, labelBytes);

    // $VOLUME_INFORMATION attribute (0x70) - NTFS 3.1
    const volInfo = new Uint8Array(12);
    volInfo[8] = 3; // Major version 3
    volInfo[9] = 1; // Minor version 1
    builder.addResidentAttribute(NtfsAttributeType.VolumeInformation, volInfo);

    // Empty resident $DATA attribute (0x80)
    builder.addResidentAttribute(NtfsAttributeType.Data, new Uint8Array(0));

    return builder.finish();
  }

  // Record 4: $AttrDef
  private buildAttrDefRecord(_geo: NtfsGeometry, allocation: ReturnType<typeof this.allocate>): Uint8Array {
    const builder = new MftRecordBuilder(4, false, 4);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0000);
    builder.addFileName(5, '$AttrDef', 4096, 2560, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);
    builder.addResidentAttribute(NtfsAttributeType.SecurityDescriptor, generateSystemSecurityDescriptor());
    builder.addNonResidentData(0, allocation.attrDefStartCluster, 1, 4096, 2560);
    return builder.finish();
  }

  // Record 6: $Bitmap
  private buildBitmapRecord(geo: NtfsGeometry, allocation: ReturnType<typeof this.allocate>): Uint8Array {
    const builder = new MftRecordBuilder(6, false, 6);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0100);
    const bmpAllocated = allocation.bitmapClusterCount * geo.clusterSizeBytes;
    builder.addFileName(5, '$Bitmap', bmpAllocated, allocation.bitmapSizeBytes, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);
    builder.addNonResidentData(
      0,
      allocation.bitmapStartCluster,
      allocation.bitmapClusterCount,
      bmpAllocated,
      allocation.bitmapSizeBytes
    );
    return builder.finish();
  }

  // Record 7: $Boot
  private buildBootRecord(_geo: NtfsGeometry): Uint8Array {
    const builder = new MftRecordBuilder(7, false, 7);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0000);
    builder.addFileName(5, '$Boot', 8192, 8192, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);
    builder.addResidentAttribute(NtfsAttributeType.SecurityDescriptor, generateSystemSecurityDescriptor());
    builder.addNonResidentData(0, 0, 2, 8192, 8192);
    return builder.finish();
  }

  // Record 8: $BadClus
  private buildBadClusRecord(geo: NtfsGeometry): Uint8Array {
    const builder = new MftRecordBuilder(8, false, 8);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0100);
    builder.addFileName(5, '$BadClus', 0, 0, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);

    // 1. Unnamed resident 0-length $DATA (0x80)
    builder.addResidentAttribute(NtfsAttributeType.Data, new Uint8Array(0));

    // 2. Named non-resident $DATA "$Bad" (0x80) covering total clusters
    // In NTFS specification (and mkntfs/Windows format), $Bad is NOT a user-sparse attribute (flags = 0, standard 64-byte header).
    // It has allocatedSize = dataSize = initializedSize = volumeSizeBytes, and a single sparse run (LCN = -1) representing all clusters.
    const totalClusters = Math.floor(geo.totalSectors / geo.sectorsPerCluster);
    const volumeSizeBytes = totalClusters * geo.clusterSizeBytes;
    builder.addNamedNonResidentData(
      '$Bad',
      0,
      -1,
      totalClusters,
      volumeSizeBytes,
      volumeSizeBytes,
      NtfsAttributeType.Data,
      0
    );

    return builder.finish();
  }

  // Record 9: $Secure
  private buildSecureRecord(geo: NtfsGeometry, allocation: ReturnType<typeof this.allocate>): Uint8Array {
    // Flags: MFT_RECORD_IN_USE (0x01) | MFT_RECORD_IS_VIEW_INDEX (0x08) = 0x09
    const builder = new MftRecordBuilder(9, false, 9, 0x09);
    builder.addStandardInformation(
      this.volumeTime,
      NtfsFileFlags.Hidden | NtfsFileFlags.System | NTFS_FILE_ATTR_VIEW_INDEX_PRESENT,
      0x0101
    );
    builder.addFileName(
      5,
      '$Secure',
      0,
      0,
      NtfsFileFlags.Hidden | NtfsFileFlags.System | NTFS_FILE_ATTR_VIEW_INDEX_PRESENT,
      this.volumeTime
    );

    // Named Non-resident $DATA: "$SDS" with its three aligned descriptors.
    const sdsSizeBytes = NTFS_SDS_DATA_SIZE;
    const sdsAllocated = allocation.sdsClusterCount * geo.clusterSizeBytes;
    builder.addNamedNonResidentData('$SDS', 0, allocation.sdsStartCluster, allocation.sdsClusterCount, sdsAllocated, sdsSizeBytes);

    // Named Index Root: "$SDH" (COLLATION_NTOFS_SECURITY_HASH = 0x12)
    const sdhEntries = buildSdhIndexEntries();
    builder.addNamedIndexRoot('$SDH', 0x12, sdhEntries);

    // Named Index Root: "$SII" (COLLATION_NTOFS_ULONG = 0x10)
    const siiEntries = buildSiiIndexEntries();
    builder.addNamedIndexRoot('$SII', 0x10, siiEntries);

    return builder.finish();
  }

  // Record 10: $UpCase
  private buildUpCaseRecord(_geo: NtfsGeometry, allocation: ReturnType<typeof this.allocate>): Uint8Array {
    const builder = new MftRecordBuilder(10, false, 10);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0100);
    builder.addFileName(5, '$UpCase', 128 * 1024, 128 * 1024, NtfsFileFlags.Hidden | NtfsFileFlags.System, this.volumeTime);
    builder.addNonResidentData(
      0,
      allocation.upCaseStartCluster,
      allocation.upCaseClusterCount,
      128 * 1024,
      128 * 1024
    );

    // Named resident $DATA "$Info" (Windows 8+ UpCase table validation info with ECMA-182 CRC64)
    const upcaseInfo = new Uint8Array(32);
    const view = new DataView(upcaseInfo.buffer);
    view.setUint32(0, 32, true); // len = 32
    view.setUint32(4, 0, true); // filler = 0
    view.setBigUint64(8, 0xdadc7e776b1b690cn, true); // ECMA-182 CRC64 of standard 128KB upcase table
    builder.addNamedResidentAttribute('$Info', NtfsAttributeType.Data, upcaseInfo);

    return builder.finish();
  }

  // Record 11: $Extend
  private buildExtendRecord(_geo: NtfsGeometry): Uint8Array {
    const builder = new MftRecordBuilder(11, true, 11);
    builder.addStandardInformation(this.volumeTime, NtfsFileFlags.Hidden | NtfsFileFlags.System, 0x0101);
    builder.addFileName(
      5,
      '$Extend',
      0,
      0,
      NtfsFileFlags.Hidden | NtfsFileFlags.System | NTFS_FILE_ATTR_I30_INDEX_PRESENT,
      this.volumeTime
    );
    builder.addIndexRoot(this.collectExtendEntries(), NtfsSystemFile.Extend);
    return builder.finish();
  }

  private collectExtendEntries(): DirectoryChildEntry[] {
    return [
      { recordNumber: NtfsSystemFile.ObjId, name: '$ObjId', isDir: false, size: 0, allocatedSize: 0, mtime: this.volumeTime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System | NtfsFileFlags.Archive | NTFS_FILE_ATTR_VIEW_INDEX_PRESENT },
      { recordNumber: NtfsSystemFile.Quota, name: '$Quota', isDir: false, size: 0, allocatedSize: 0, mtime: this.volumeTime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System | NtfsFileFlags.Archive | NTFS_FILE_ATTR_VIEW_INDEX_PRESENT },
      { recordNumber: NtfsSystemFile.Reparse, name: '$Reparse', isDir: false, size: 0, allocatedSize: 0, mtime: this.volumeTime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System | NtfsFileFlags.Archive | NTFS_FILE_ATTR_VIEW_INDEX_PRESENT },
    ].sort((a, b) => compareNtfsFileNames(a.name, b.name));
  }

  private buildViewIndexRecord(recordNumber: number, name: string): MftRecordBuilder {
    const flags = NtfsFileFlags.Hidden | NtfsFileFlags.System | NtfsFileFlags.Archive | NTFS_FILE_ATTR_VIEW_INDEX_PRESENT;
    // IN_USE | IS_4 | IS_VIEW_INDEX. NTFS marks every $Extend sub-file
    // with IS_4 in addition to its named non-directory index bit.
    const builder = new MftRecordBuilder(recordNumber, false, 1, 0x0d);
    builder.addStandardInformation(this.volumeTime, flags, 0x0101);
    builder.addFileName(NtfsSystemFile.Extend, name, 0, 0, flags, this.volumeTime);
    return builder;
  }

  private buildQuotaRecord(): Uint8Array {
    const builder = this.buildViewIndexRecord(NtfsSystemFile.Quota, '$Quota');
    // MFT attributes are sorted by type and then by Unicode name. Both
    // indexes are AT_INDEX_ROOT, so $O must precede $Q on disk.
    builder.addNamedIndexRoot('$O', 0x11, this.buildQuotaSidEntries());
    builder.addNamedIndexRoot('$Q', 0x10, this.buildQuotaOwnerEntries());
    return builder.finish();
  }

  private buildObjIdRecord(): Uint8Array {
    const builder = this.buildViewIndexRecord(NtfsSystemFile.ObjId, '$ObjId');
    // The object-id index file is required, but a volume GUID entry is not.
    // Keep the index empty until an actual file receives an object ID.
    builder.addNamedIndexRoot('$O', 0x13, this.emptyIndexEntries());
    return builder.finish();
  }

  private buildReparseRecord(): Uint8Array {
    const builder = this.buildViewIndexRecord(NtfsSystemFile.Reparse, '$Reparse');
    builder.addNamedIndexRoot('$R', 0x13, this.emptyIndexEntries());
    return builder.finish();
  }

  private buildQuotaOwnerEntries(): Uint8Array {
    const first = new Uint8Array(0x48);
    const firstView = new DataView(first.buffer);
    firstView.setUint16(0, 0x14, true);
    firstView.setUint16(2, 0x30, true);
    firstView.setUint16(8, 0x48, true);
    firstView.setUint16(10, 4, true);
    firstView.setUint32(16, 1, true);
    this.writeQuotaControl(first, 20, false);

    const second = new Uint8Array(0x58);
    const secondView = new DataView(second.buffer);
    secondView.setUint16(0, 0x14, true);
    secondView.setUint16(2, 0x40, true);
    secondView.setUint16(8, 0x58, true);
    secondView.setUint16(10, 4, true);
    secondView.setUint32(16, 0x100, true);
    this.writeQuotaControl(second, 20, true);
    return this.concatBytes(first, second, this.emptyIndexEntries());
  }

  private writeQuotaControl(buffer: Uint8Array, offset: number, includeAdminSid: boolean): void {
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    view.setUint32(offset, 2, true);
    view.setUint32(offset + 4, 1, true); // QUOTA_FLAG_DEFAULT_LIMITS
    view.setBigUint64(offset + 8, 0n, true);
    view.setBigUint64(offset + 16, dateToFileTime(this.volumeTime), true);
    view.setBigInt64(offset + 24, -1n, true);
    view.setBigInt64(offset + 32, -1n, true);
    view.setBigUint64(offset + 40, 0n, true);
    if (includeAdminSid) {
      buffer[offset + 48] = 1;
      buffer[offset + 49] = 2;
      buffer[offset + 55] = 5;
      view.setUint32(offset + 56, 32, true);
      view.setUint32(offset + 60, 544, true);
    }
  }

  private buildQuotaSidEntries(): Uint8Array {
    const entry = new Uint8Array(0x28);
    const view = new DataView(entry.buffer);
    view.setUint16(0, 0x20, true);
    view.setUint16(2, 4, true);
    view.setUint16(8, 0x28, true);
    view.setUint16(10, 0x10, true);
    entry[16] = 1;
    entry[17] = 2;
    entry[23] = 5;
    view.setUint32(24, 32, true);
    view.setUint32(28, 544, true);
    view.setUint32(32, 0x100, true);
    return this.concatBytes(entry, this.emptyIndexEntries());
  }

  private emptyIndexEntries(): Uint8Array {
    const end = new Uint8Array(16);
    new DataView(end.buffer).setUint16(8, 16, true);
    new DataView(end.buffer).setUint16(12, 0x02, true);
    return end;
  }

  private concatBytes(...parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  private collectChildEntries(
    dirNode: VNode,
    recordNum: number,
    allocation: ReturnType<typeof this.allocate>,
    geo: NtfsGeometry
  ): DirectoryChildEntry[] {
    const childEntries: DirectoryChildEntry[] = [];

    // If Root Directory (Record 5), index self link '.' and all system files
    if (recordNum === NtfsSystemFile.RootDir) {
      const sysMtime = this.volumeTime;
      const mftSizeBytes = allocation.mftClusterCount * geo.clusterSizeBytes;
      const logSizeBytes = geo.logFileClusterCount * geo.clusterSizeBytes;
      const bootSizeBytes = 8192;
      const upcaseSizeBytes = 128 * 1024;
      const attrDefSizeBytes = 2560;

      childEntries.push(
        {
          recordNumber: 5,
          name: '.',
          isDir: true,
          size: 0,
          allocatedSize: 0,
          mtime: sysMtime,
          fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System | NTFS_FILE_ATTR_I30_INDEX_PRESENT,
        },
        { recordNumber: 0, name: '$MFT', isDir: false, size: mftSizeBytes, allocatedSize: mftSizeBytes, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        { recordNumber: 1, name: '$MFTMirr', isDir: false, size: 4096, allocatedSize: 4096, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        { recordNumber: 2, name: '$LogFile', isDir: false, size: logSizeBytes, allocatedSize: logSizeBytes, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        { recordNumber: 3, name: '$Volume', isDir: false, size: 0, allocatedSize: 0, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        { recordNumber: 4, name: '$AttrDef', isDir: false, size: attrDefSizeBytes, allocatedSize: 4096, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        { recordNumber: 6, name: '$Bitmap', isDir: false, size: allocation.bitmapSizeBytes, allocatedSize: allocation.bitmapClusterCount * geo.clusterSizeBytes, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        { recordNumber: 7, name: '$Boot', isDir: false, size: bootSizeBytes, allocatedSize: bootSizeBytes, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        { recordNumber: 8, name: '$BadClus', isDir: false, size: 0, allocatedSize: 0, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        {
          recordNumber: 9,
          name: '$Secure',
          isDir: false,
          size: 0,
          allocatedSize: 0,
          mtime: sysMtime,
          fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System | NTFS_FILE_ATTR_VIEW_INDEX_PRESENT,
        },
        { recordNumber: 10, name: '$UpCase', isDir: false, size: upcaseSizeBytes, allocatedSize: upcaseSizeBytes, mtime: sysMtime, fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System },
        {
          recordNumber: 11,
          name: '$Extend',
          isDir: true,
          size: 0,
          allocatedSize: 0,
          mtime: sysMtime,
          fileFlags: NtfsFileFlags.Hidden | NtfsFileFlags.System | NTFS_FILE_ATTR_I30_INDEX_PRESENT,
        }
      );
    }

    for (const child of dirNode.children || []) {
      const item = allocation.items.find((it) => it.node === child);
      if (item) {
        const allocatedBytes = item.isDir
          ? 0
          : item.size <= 600
            ? Math.ceil(item.size / 8) * 8
            : item.clusterCount * geo.clusterSizeBytes;

        childEntries.push({
          recordNumber: item.recordNumber,
          name: child.name,
          isDir: item.isDir,
          size: item.isDir ? 0 : item.size,
          allocatedSize: allocatedBytes,
          mtime: child.modifiedTime || this.volumeTime,
          fileFlags: item.isDir ? NTFS_FILE_ATTR_I30_INDEX_PRESENT : NtfsFileFlags.Archive,
        });
      }
    }

    // Sort entries according to NTFS Unicode Collation order
    childEntries.sort((a, b) => compareNtfsFileNames(a.name, b.name));
    return childEntries;
  }

  // Directory Record
  private buildDirectoryRecord(
    dirNode: VNode,
    recordNum: number,
    parentRec: number,
    allocation: ReturnType<typeof this.allocate>,
    geo: NtfsGeometry,
    item?: AllocatedItem
  ): Uint8Array {
    const builder = new MftRecordBuilder(recordNum, true, getRecordSequenceNumber(recordNum));
    const mtime = dirNode.modifiedTime || this.volumeTime;
    const standardInfoFlags = recordNum === NtfsSystemFile.RootDir
      ? (NtfsFileFlags.Hidden | NtfsFileFlags.System | NtfsFileFlags.Archive)
      : NtfsFileFlags.Directory;
    const fileNameFlags = recordNum === NtfsSystemFile.RootDir
      ? (NtfsFileFlags.Hidden | NtfsFileFlags.System | NTFS_FILE_ATTR_I30_INDEX_PRESENT)
      : NTFS_FILE_ATTR_I30_INDEX_PRESENT;

    builder.addStandardInformation(
      mtime,
      standardInfoFlags,
      recordNum === NtfsSystemFile.RootDir ? 0x0000 : NTFS_DEFAULT_FILE_SECURITY_ID
    );

    const dirName = recordNum === NtfsSystemFile.RootDir ? '.' : dirNode.name;
    builder.addFileName(parentRec, dirName, 0, 0, fileNameFlags, mtime);
    if (recordNum === NtfsSystemFile.RootDir) {
      const securityDescriptor = generateRootDirectorySecurityDescriptor();
      const allocatedBytes = allocation.rootSecurityDescriptorClusterCount * geo.clusterSizeBytes;
      builder.addNonResidentData(
        0,
        allocation.rootSecurityDescriptorStartCluster,
        allocation.rootSecurityDescriptorClusterCount,
        allocatedBytes,
        securityDescriptor.byteLength,
        NtfsAttributeType.SecurityDescriptor
      );
    }

    const childEntries = this.collectChildEntries(dirNode, recordNum, allocation, geo);

    if (recordNum === NtfsSystemFile.RootDir) {
      // Root Directory uses Large Index ($INDEX_ALLOCATION)
      builder.addLargeIndexRoot();
      builder.addIndexAllocation(allocation.rootIndexStartCluster, 1);
      builder.addIndexBitmap();
    } else if (item && item.indexStartCluster !== undefined) {
      // User directory with > 4 children uses Large Index
      builder.addLargeIndexRoot();
      builder.addIndexAllocation(item.indexStartCluster, 1);
      builder.addIndexBitmap();
    } else {
      // Small directory uses Resident Index
      builder.addIndexRoot(childEntries, recordNum);
    }

    return builder.finish();
  }

  // User File Record
  private buildFileRecord(
    item: AllocatedItem,
    geo: NtfsGeometry
  ): Uint8Array {
    const builder = new MftRecordBuilder(item.recordNumber, false, getRecordSequenceNumber(item.recordNumber));
    const mtime = item.node.modifiedTime || this.volumeTime;
    builder.addStandardInformation(mtime, NtfsFileFlags.Archive, NTFS_DEFAULT_FILE_SECURITY_ID);

    const allocatedBytes = item.size <= 600
      ? Math.ceil(item.size / 8) * 8
      : item.clusterCount * geo.clusterSizeBytes;

    builder.addFileName(item.parentRecord, item.node.name, allocatedBytes, item.size, NtfsFileFlags.Archive, mtime);

    if (item.size <= 600) {
      // Resident data: Small file content stored directly inside MFT record
      let dataBytes = new Uint8Array(0);
      if (item.node.data && item.node.data.byteLength > 0) {
        dataBytes = item.node.data;
      }
      builder.addResidentAttribute(NtfsAttributeType.Data, dataBytes);
    } else {
      // Non-resident data runs
      builder.addNonResidentData(
        0,
        item.startCluster,
        item.clusterCount,
        allocatedBytes,
        item.size
      );
    }

    return builder.finish();
  }

  private buildIndxBlock(entries: DirectoryChildEntry[], dirRecordNumber: number): Uint8Array {
    const block = new Uint8Array(4096);
    const view = new DataView(block.buffer, block.byteOffset);

    // 1. Magic 'INDX'
    block[0] = 0x49; // I
    block[1] = 0x4e; // N
    block[2] = 0x44; // D
    block[3] = 0x58; // X

    // 2. USA offset = 40 (0x28), USA count = 9 (1 USN + 8 sector fixup words)
    view.setUint16(4, 40, true);
    view.setUint16(6, 9, true);

    // 3. LSN = 0n, VCN = 0n
    view.setBigInt64(8, 0n, true);
    view.setBigInt64(16, 0n, true);

    // 4. Index Header starts at byte 24:
    const entriesOffsetInHeader = 40;
    const entriesStart = 24 + entriesOffsetInHeader; // 64
    view.setUint32(24 + 0, entriesOffsetInHeader, true);
    view.setUint32(24 + 8, 4096 - 24, true); // allocated_size
    block[24 + 12] = 0; // leaf node

    // 5. Build entries
    let writePos = entriesStart;
    for (const child of entries) {
      const childName = child.name;
      const fnValueLen = 66 + childName.length * 2;
      const entryLen = Math.ceil((16 + fnValueLen) / 8) * 8;

      const seq = getRecordSequenceNumber(child.recordNumber);
      const fileRef = BigInt(child.recordNumber) | (BigInt(seq) << 48n);
      view.setBigUint64(writePos + 0, fileRef, true);
      view.setUint16(writePos + 8, entryLen, true);
      view.setUint16(writePos + 10, fnValueLen, true);
      view.setUint16(writePos + 12, 0, true); // Flags

      const parentSeq = getRecordSequenceNumber(dirRecordNumber);
      const parentRef = BigInt(dirRecordNumber) | (BigInt(parentSeq) << 48n);
      view.setBigUint64(writePos + 16, parentRef, true);
      const ft = dateToFileTime(child.mtime);
      view.setBigUint64(writePos + 24, ft, true);
      view.setBigUint64(writePos + 32, ft, true);
      view.setBigUint64(writePos + 40, ft, true);
      view.setBigUint64(writePos + 48, ft, true);
      view.setBigUint64(writePos + 56, BigInt(child.allocatedSize), true);
      view.setBigUint64(writePos + 64, BigInt(child.size), true);
      const flags = child.fileFlags ?? (child.isDir ? NTFS_FILE_ATTR_I30_INDEX_PRESENT : NtfsFileFlags.Archive);
      view.setUint32(writePos + 72, flags, true);
      block[writePos + 80] = childName.length;
      block[writePos + 81] = 0x03; // Win32 & DOS

      for (let c = 0; c < childName.length; c++) {
        const code = childName.charCodeAt(c);
        block[writePos + 82 + c * 2] = code & 0xff;
        block[writePos + 82 + c * 2 + 1] = (code >> 8) & 0xff;
      }

      writePos += entryLen;
    }

    // 6. Dummy End Entry (16 bytes, flags = 0x02)
    view.setUint16(writePos + 8, 16, true);
    view.setUint16(writePos + 12, 0x02, true);
    writePos += 16;

    // Total index_length in Index Header
    const totalIndexLen = writePos - 24;
    view.setUint32(24 + 4, totalIndexLen, true);

    // 7. Apply USA fixup across the 8 sectors (512 bytes each).
    const usn = 1;
    view.setUint16(40, usn, true);
    for (let s = 0; s < 8; s++) {
      const secEndOffset = (s + 1) * 512 - 2;
      const origWord = block[secEndOffset] | (block[secEndOffset + 1] << 8);
      view.setUint16(42 + s * 2, origWord, true);
      block[secEndOffset] = usn & 0xff;
      block[secEndOffset + 1] = (usn >> 8) & 0xff;
    }

    return block;
  }

  private async streamDataAndBitmap(
    writer: ImageStreamWriter,
    geo: NtfsGeometry,
    allocation: ReturnType<typeof this.allocate>,
    onProgress?: (ratio: number, status: string) => void
  ): Promise<void> {
    // 1. Write Root Directory INDX Block (1 cluster = 4096 bytes)
    const rootChildEntries = this.collectChildEntries(this.root, NtfsSystemFile.RootDir, allocation, geo);
    const rootIndx = this.buildIndxBlock(rootChildEntries, NtfsSystemFile.RootDir);
    await writer.write(rootIndx);

    // Write the canonical NTFS 3.1 root security descriptor in its own
    // nonresident attribute allocation, padded to the allocated clusters.
    const rootSecurityDescriptor = generateRootDirectorySecurityDescriptor();
    const rootSecurityBuffer = new Uint8Array(
      allocation.rootSecurityDescriptorClusterCount * geo.clusterSizeBytes
    );
    rootSecurityBuffer.set(rootSecurityDescriptor);
    await writer.write(rootSecurityBuffer);

    // 2. Write any user directories with large indexes
    for (const item of allocation.items) {
      if (item.isDir && item.indexStartCluster !== undefined) {
        const userEntries = this.collectChildEntries(item.node, item.recordNumber, allocation, geo);
        const userIndx = this.buildIndxBlock(userEntries, item.recordNumber);
        await writer.write(userIndx);
      }
    }

    // 3. Write $AttrDef (1 cluster = 4096 bytes)
    const attrDefData = getNtfs3xAttrDef();
    const attrDefCluster = new Uint8Array(geo.clusterSizeBytes);
    attrDefCluster.set(attrDefData, 0);
    await writer.write(attrDefCluster);

    // 4. Write $Secure $SDS (65 clusters)
    const sdsData = generateSdsData();
    const sdsClusterTotal = allocation.sdsClusterCount * geo.clusterSizeBytes;
    const sdsBuffer = new Uint8Array(sdsClusterTotal);
    sdsBuffer.set(sdsData, 0);
    await writer.write(sdsBuffer);

    // 5. Write $UpCase table (128 KB = 32 clusters)
    const upcaseBytes = this.generateUpcaseTable();
    await writer.write(upcaseBytes);

    // 6. Stream user files data
    for (let i = 0; i < allocation.items.length; i++) {
      const item = allocation.items[i];
      if (!item.isDir && item.size > 600) {
        const progress = 0.6 + (i / allocation.items.length) * 0.35;
        onProgress?.(progress, `Writing file: ${item.node.name}`);
        await this.streamFileData(item.node, writer);

        // Pad to cluster boundary
        const padBytes = (geo.clusterSizeBytes - (item.size % geo.clusterSizeBytes)) % geo.clusterSizeBytes;
        if (padBytes > 0) {
          await writer.write(new Uint8Array(padBytes));
        }
      }
    }

    // 7. Write the nonresident $MFT::$BITMAP stream.
    const mftBitmap = new Uint8Array(geo.clusterSizeBytes);
    for (let recordNumber = 0; recordNumber < NtfsSystemFile.UserFirst; recordNumber++) {
      mftBitmap[recordNumber >> 3] |= 1 << (recordNumber & 7);
    }
    for (const recordNumber of [NtfsSystemFile.Quota, NtfsSystemFile.ObjId, NtfsSystemFile.Reparse]) {
      mftBitmap[recordNumber >> 3] |= 1 << (recordNumber & 7);
    }
    for (const item of allocation.items) {
      mftBitmap[item.recordNumber >> 3] |= 1 << (item.recordNumber & 7);
    }
    await writer.write(mftBitmap);

    // 8. Build and write the volume $Bitmap
    onProgress?.(0.95, 'Writing volume bitmap ($Bitmap)...');
    const bitmap = new Uint8Array(allocation.bitmapClusterCount * geo.clusterSizeBytes);
    // Mark all clusters 0..(totalAllocatedClusters - 1) as allocated
    const fullBytes = Math.floor(allocation.totalAllocatedClusters / 8);
    bitmap.fill(0xff, 0, fullBytes);
    const remBits = allocation.totalAllocatedClusters % 8;
    if (remBits > 0) {
      bitmap[fullBytes] = (1 << remBits) - 1;
    }

    // Cluster 3 is an intentional physical gap between $MFTMirr (cluster 2)
    // and $LogFile (cluster 4). It contains zero padding, but no NTFS file
    // owns it, so it must remain free in the volume bitmap.
    bitmap[0] &= ~(1 << 3);

    // The bitmap is rounded up to a whole byte, but the final byte can contain
    // bits for clusters beyond the end of the volume. NTFS requires those bits
    // to be set (allocated/unavailable).
    const volumeTailByte = Math.floor(allocation.totalVolumeClusters / 8);
    const volumeTailBit = allocation.totalVolumeClusters % 8;
    if (volumeTailByte < allocation.bitmapSizeBytes) {
      if (volumeTailBit > 0) {
        bitmap[volumeTailByte] |= 0xff << volumeTailBit;
      }
      bitmap.fill(0xff, volumeTailByte + (volumeTailBit > 0 ? 1 : 0), allocation.bitmapSizeBytes);
    }

    await writer.write(bitmap);
  }

  private async streamFileData(node: VNode, writer: ImageStreamWriter): Promise<void> {
    if (node.data && node.data.byteLength > 0) {
      await writer.write(node.data);
      return;
    }

    if (node.fileRef && typeof node.fileRef.stream === 'function') {
      const reader = (node.fileRef.stream() as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            await writer.write(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      return;
    }

    if (node.fileRef && typeof node.fileRef.arrayBuffer === 'function') {
      const ab = await node.fileRef.arrayBuffer();
      await writer.write(new Uint8Array(ab));
      return;
    }
  }

  private generateUpcaseTable(): Uint8Array {
    return generateNtfsUpcaseBuffer();
  }

  private writeUint16LE(arr: Uint8Array, offset: number, val: number) {
    arr[offset] = val & 0xff;
    arr[offset + 1] = (val >> 8) & 0xff;
  }

  private writeUint32LE(arr: Uint8Array, offset: number, val: number) {
    arr[offset] = val & 0xff;
    arr[offset + 1] = (val >> 8) & 0xff;
    arr[offset + 2] = (val >> 16) & 0xff;
    arr[offset + 3] = (val >> 24) & 0xff;
  }

  private writeUint64LE(arr: Uint8Array, offset: number, val: number) {
    this.writeUint32LE(arr, offset, val);
    this.writeUint32LE(arr, offset + 4, 0);
  }

  private writeBigUint64LE(arr: Uint8Array, offset: number, val: bigint) {
    const low = Number(val & 0xffffffffn);
    const high = Number((val >> 32n) & 0xffffffffn);
    this.writeUint32LE(arr, offset, low);
    this.writeUint32LE(arr, offset + 4, high);
  }
}

class MftRecordBuilder {
  private buffer: Uint8Array;
  private offset: number;
  private nextAttrId: number = 0;
  private sequenceNumber: number;

  constructor(recordNumber: number, isDirectory: boolean, sequenceNumber?: number, flags?: number) {
    this.buffer = new Uint8Array(NTFS_FILE_RECORD_SIZE);
    this.offset = 56; // Attributes start at offset 56 (0x38)
    this.sequenceNumber = sequenceNumber ?? getRecordSequenceNumber(recordNumber);

    // 0x00: 'FILE' magic
    this.buffer[0] = 0x46; // F
    this.buffer[1] = 0x49; // I
    this.buffer[2] = 0x4c; // L
    this.buffer[3] = 0x45; // E
    // 0x04: Offset to USA (48 = 0x30)
    this.writeUint16(4, 0x30);
    // 0x06: Size in words of USA (3 = 1 USN + 2 sector fixups)
    this.writeUint16(6, 3);
    // 0x10: Sequence number
    this.writeUint16(16, this.sequenceNumber);
    // 0x16: Flags (0x01 = InUse, 0x02 = Directory, 0x04 = Extend sub-file,
    // 0x08 = named non-directory view index)
    const defaultFlags = (isDirectory ? 0x02 : 0x00) | 0x01;
    const recFlags = flags ?? defaultFlags;
    // 0x12: Hard link count (0 if unallocated, 1 if in use)
    this.writeUint16(18, recFlags === 0 ? 0 : 1);
    // 0x14: Offset to first attribute (56 = 0x38)
    this.writeUint16(20, 0x38);
    this.writeUint16(22, recFlags);
    // 0x1c: Allocated size of record (1024)
    this.writeUint32(28, NTFS_FILE_RECORD_SIZE);
    // 0x2c: MFT record number
    this.writeUint32(44, recordNumber);
    // 0x30: USA sequence number (1)
    this.writeUint16(48, 1);
  }

  // NTFS 3.1 Standard Information (72 bytes value)
  addStandardInformation(mtime: Date, flags: number, securityId: number = 0x0100): void {
    const attrOffset = this.offset;
    const valueLength = 72;
    const totalAttrLength = 24 + valueLength; // 96 bytes

    // Resident attribute header (24 bytes)
    this.writeUint32(attrOffset, NtfsAttributeType.StandardInformation);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 0; // Resident
    this.buffer[attrOffset + 9] = 0; // Name length
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeUint32(attrOffset + 16, valueLength);
    this.writeUint16(attrOffset + 20, 24); // Offset to value

    // Value (72 bytes)
    const fileTime = dateToFileTime(mtime);
    const valOffset = attrOffset + 24;
    this.writeBigUint64(valOffset + 0, fileTime); // Create time
    this.writeBigUint64(valOffset + 8, fileTime); // Alteration time
    this.writeBigUint64(valOffset + 16, fileTime); // MFT change time
    this.writeBigUint64(valOffset + 24, fileTime); // Access time
    this.writeUint32(valOffset + 32, flags); // DOS File Permissions
    this.writeUint32(valOffset + 36, 0); // Max versions
    this.writeUint32(valOffset + 40, 0); // Version number
    this.writeUint32(valOffset + 44, 0); // Class ID
    this.writeUint32(valOffset + 48, 0); // Owner ID
    this.writeUint32(valOffset + 52, securityId); // Security ID indexes an entry in $Secure/$SII
    this.writeBigUint64(valOffset + 56, 0n); // Quota charged
    this.writeBigUint64(valOffset + 64, 0n); // USN

    this.offset += totalAttrLength;
  }

  addFileName(
    parentRec: number,
    name: string,
    allocatedSize: number,
    realSize: number,
    flags: number,
    mtime: Date
  ): void {
    const attrOffset = this.offset;
    const nameChars = name.length;
    const valueLength = 66 + nameChars * 2;
    const totalAttrLength = Math.ceil((24 + valueLength) / 8) * 8; // 8-byte aligned

    // Resident header
    this.writeUint32(attrOffset, NtfsAttributeType.FileName);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 0; // Resident
    this.buffer[attrOffset + 9] = 0; // Name length
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeUint32(attrOffset + 16, valueLength);
    this.writeUint16(attrOffset + 20, 24);
    this.buffer[attrOffset + 22] = 1; // Indexed = 1

    // Value
    const valOffset = attrOffset + 24;
    const parentSeq = getRecordSequenceNumber(parentRec);
    const parentRef = BigInt(parentRec) | (BigInt(parentSeq) << 48n);
    this.writeBigUint64(valOffset + 0, parentRef);

    const fileTime = dateToFileTime(mtime);
    this.writeBigUint64(valOffset + 8, fileTime);
    this.writeBigUint64(valOffset + 16, fileTime);
    this.writeBigUint64(valOffset + 24, fileTime);
    this.writeBigUint64(valOffset + 32, fileTime);
    this.writeBigUint64(valOffset + 40, BigInt(allocatedSize));
    this.writeBigUint64(valOffset + 48, BigInt(realSize));
    this.writeUint32(valOffset + 56, flags);
    this.writeUint32(valOffset + 60, 0); // Reparse tag
    this.buffer[valOffset + 64] = nameChars;
    this.buffer[valOffset + 65] = 0x03; // Namespace: Win32 & DOS

    for (let i = 0; i < nameChars; i++) {
      const code = name.charCodeAt(i);
      this.buffer[valOffset + 66 + i * 2] = code & 0xff;
      this.buffer[valOffset + 66 + i * 2 + 1] = (code >> 8) & 0xff;
    }

    this.offset += totalAttrLength;
  }

  addResidentAttribute(attrType: NtfsAttributeType, data: Uint8Array): void {
    const attrOffset = this.offset;
    const valueLength = data.byteLength;
    const totalAttrLength = Math.ceil((24 + valueLength) / 8) * 8;

    this.writeUint32(attrOffset, attrType);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 0; // Resident
    this.buffer[attrOffset + 9] = 0;
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeUint32(attrOffset + 16, valueLength);
    this.writeUint16(attrOffset + 20, 24);

    if (valueLength > 0) {
      this.buffer.set(data, attrOffset + 24);
    }

    this.offset += totalAttrLength;
  }

  addNamedResidentAttribute(name: string, attrType: NtfsAttributeType, data: Uint8Array): void {
    const attrOffset = this.offset;
    const nameChars = name.length;
    const nameOffset = 24;

    const valueOffset = Math.ceil((nameOffset + nameChars * 2) / 8) * 8;
    const valueLength = data.byteLength;
    const totalAttrLength = Math.ceil((valueOffset + valueLength) / 8) * 8;

    this.writeUint32(attrOffset, attrType);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 0; // Resident
    this.buffer[attrOffset + 9] = nameChars;
    this.writeUint16(attrOffset + 10, nameOffset);
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeUint32(attrOffset + 16, valueLength);
    this.writeUint16(attrOffset + 20, valueOffset);

    for (let i = 0; i < nameChars; i++) {
      this.buffer[attrOffset + nameOffset + i * 2] = name.charCodeAt(i) & 0xff;
      this.buffer[attrOffset + nameOffset + i * 2 + 1] = 0;
    }

    if (valueLength > 0) {
      this.buffer.set(data, attrOffset + valueOffset);
    }

    this.offset += totalAttrLength;
  }

  addNonResidentData(
    startVcn: number,
    startLcn: number,
    clusterCount: number,
    allocatedSize: number,
    realSize: number,
    attrType: NtfsAttributeType = NtfsAttributeType.Data,
    attrFlags: number = 0
  ): void {
    const attrOffset = this.offset;
    const isSparseOrCompressed = (attrFlags & 0x8001) !== 0;
    const runListOffset = isSparseOrCompressed ? 0x48 : 0x40;
    const runBytes = this.encodeDataRun(clusterCount, startLcn);
    const totalAttrLength = Math.ceil((runListOffset + runBytes.length) / 8) * 8;

    this.writeUint32(attrOffset, attrType);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 1; // Non-resident
    this.buffer[attrOffset + 9] = 0; // Name length = 0
    this.writeUint16(attrOffset + 10, 0); // Name offset
    this.writeUint16(attrOffset + 12, attrFlags);
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeBigUint64(attrOffset + 16, BigInt(startVcn)); // Starting VCN
    this.writeBigUint64(attrOffset + 24, BigInt(startVcn + clusterCount - 1)); // Ending VCN
    this.writeUint16(attrOffset + 32, runListOffset); // Offset to run list
    this.writeBigUint64(attrOffset + 40, BigInt(allocatedSize));
    this.writeBigUint64(attrOffset + 48, BigInt(realSize));
    this.writeBigUint64(attrOffset + 56, BigInt(realSize)); // Initialized size

    if (isSparseOrCompressed) {
      this.writeBigUint64(attrOffset + 64, BigInt(allocatedSize));
    }

    this.buffer.set(runBytes, attrOffset + runListOffset);
    this.offset += totalAttrLength;
  }

  addNamedNonResidentData(
    name: string,
    startVcn: number,
    startLcn: number,
    clusterCount: number,
    allocatedSize: number,
    realSize: number,
    attrType: NtfsAttributeType = NtfsAttributeType.Data,
    attrFlags: number = 0
  ): void {
    const attrOffset = this.offset;
    const isSparseOrCompressed = (attrFlags & 0x8001) !== 0;
    const nameChars = name.length;
    const nameOffset = isSparseOrCompressed ? 0x48 : 0x40;

    const runListOffset = Math.ceil((nameOffset + nameChars * 2) / 8) * 8;
    const runBytes = this.encodeDataRun(clusterCount, startLcn);
    const totalAttrLength = Math.ceil((runListOffset + runBytes.length) / 8) * 8;

    this.writeUint32(attrOffset, attrType);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 1; // Non-resident
    this.buffer[attrOffset + 9] = nameChars;
    this.writeUint16(attrOffset + 10, nameOffset);
    this.writeUint16(attrOffset + 12, attrFlags); // Flags (e.g. 0x8000 for sparse)
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeBigUint64(attrOffset + 16, BigInt(startVcn));
    this.writeBigUint64(attrOffset + 24, BigInt(startVcn + clusterCount - 1));
    this.writeUint16(attrOffset + 32, runListOffset);
    this.writeBigUint64(attrOffset + 40, BigInt(allocatedSize));
    this.writeBigUint64(attrOffset + 48, BigInt(realSize));
    this.writeBigUint64(attrOffset + 56, BigInt(realSize));

    if (isSparseOrCompressed) {
      this.writeBigUint64(attrOffset + 64, BigInt(allocatedSize));
    }

    for (let i = 0; i < nameChars; i++) {
      this.buffer[attrOffset + nameOffset + i * 2] = name.charCodeAt(i) & 0xff;
      this.buffer[attrOffset + nameOffset + i * 2 + 1] = 0;
    }

    this.buffer.set(runBytes, attrOffset + runListOffset);
    this.offset += totalAttrLength;
  }

  addEmptyIndexRoot(): void {
    this.addIndexRoot([], 0);
  }

  addLargeIndexRoot(): void {
    const attrOffset = this.offset;
    const nameStr = '$I30';
    const nameChars = 4;
    const nameOffset = 24;

    const endEntryLen = 24;
    const valueOffset = Math.ceil((nameOffset + nameChars * 2) / 8) * 8; // 32
    const valueLength = 32 + endEntryLen; // 56
    const totalAttrLength = Math.ceil((valueOffset + valueLength) / 8) * 8; // 88

    this.writeUint32(attrOffset, NtfsAttributeType.IndexRoot);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 0; // Resident
    this.buffer[attrOffset + 9] = nameChars;
    this.writeUint16(attrOffset + 10, nameOffset);
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeUint32(attrOffset + 16, valueLength);
    this.writeUint16(attrOffset + 20, valueOffset);

    for (let i = 0; i < nameChars; i++) {
      this.buffer[attrOffset + nameOffset + i * 2] = nameStr.charCodeAt(i) & 0xff;
      this.buffer[attrOffset + nameOffset + i * 2 + 1] = 0;
    }

    const vOff = attrOffset + valueOffset;
    this.writeUint32(vOff + 0, NtfsAttributeType.FileName);
    this.writeUint32(vOff + 4, 1); // Collation rule (CollationFilename)
    this.writeUint32(vOff + 8, 4096); // Index record size
    this.buffer[vOff + 12] = 1; // Clusters per index record

    // Index Node Header: ih_flags = 1 (LARGE_INDEX)
    this.writeUint32(vOff + 16, 16); // entries_offset
    this.writeUint32(vOff + 20, 16 + endEntryLen); // index_length
    this.writeUint32(vOff + 24, 16 + endEntryLen); // allocated_size
    this.buffer[vOff + 28] = 1; // ih_flags: LARGE_INDEX

    // Single termination entry with child VCN 0
    const eOff = vOff + 32;
    this.writeUint16(eOff + 8, endEntryLen);
    this.writeUint16(eOff + 10, 0); // key_length = 0
    this.writeUint16(eOff + 12, 0x03); // INDEX_ENTRY_END (0x02) | INDEX_ENTRY_NODE (0x01)
    // Child VCN = 0 at offset 16 of entry:
    this.writeBigUint64(eOff + 16, 0n);

    this.offset += totalAttrLength;
  }

  addIndexAllocation(startLcn: number, clusterCount: number): void {
    this.addNamedNonResidentData('$I30', 0, startLcn, clusterCount, clusterCount * 4096, clusterCount * 4096, NtfsAttributeType.IndexAllocation);
  }

  addIndexBitmap(): void {
    const bmp = new Uint8Array(8);
    bmp[0] = 0x01; // VCN 0 in use
    this.addNamedResidentAttribute('$I30', NtfsAttributeType.Bitmap, bmp);
  }

  addNamedIndexRoot(
    name: string,
    collationRule: number,
    entriesData: Uint8Array
  ): void {
    const attrOffset = this.offset;
    const nameChars = name.length;
    const nameOffset = 24;

    const valueOffset = Math.ceil((nameOffset + nameChars * 2) / 8) * 8;
    const valueLength = 32 + entriesData.byteLength;
    const totalAttrLength = Math.ceil((valueOffset + valueLength) / 8) * 8;

    this.writeUint32(attrOffset, NtfsAttributeType.IndexRoot);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 0; // Resident
    this.buffer[attrOffset + 9] = nameChars;
    this.writeUint16(attrOffset + 10, nameOffset);
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeUint32(attrOffset + 16, valueLength);
    this.writeUint16(attrOffset + 20, valueOffset);

    for (let i = 0; i < nameChars; i++) {
      this.buffer[attrOffset + nameOffset + i * 2] = name.charCodeAt(i) & 0xff;
      this.buffer[attrOffset + nameOffset + i * 2 + 1] = 0;
    }

    // Index Root Value
    const vOff = attrOffset + valueOffset;
    this.writeUint32(vOff + 0, 0); // Indexed attribute: AT_UNUSED (0)
    this.writeUint32(vOff + 4, collationRule); // Collation rule
    this.writeUint32(vOff + 8, 4096); // Index record size
    this.buffer[vOff + 12] = 1; // Clusters per index record

    // Index Node Header
    this.writeUint32(vOff + 16, 16); // Offset to first entry
    this.writeUint32(vOff + 20, 16 + entriesData.byteLength); // Total entries size
    this.writeUint32(vOff + 24, 16 + entriesData.byteLength); // Allocated entries size
    this.buffer[vOff + 28] = 0; // Flags: leaf node

    this.buffer.set(entriesData, vOff + 32);
    this.offset += totalAttrLength;
  }

  addIndexRoot(
    entries: DirectoryChildEntry[],
    dirRecordNumber: number
  ): void {
    const attrOffset = this.offset;
    const nameStr = '$I30';
    const nameChars = nameStr.length; // 4
    const nameOffset = 24;

    const entryBlocks: Uint8Array[] = [];
    let entriesLength = 0;

    for (const child of entries) {
      const childName = child.name;
      const fnValueLen = 66 + childName.length * 2;
      const entryLen = Math.ceil((16 + fnValueLen) / 8) * 8;

      const entryBuf = new Uint8Array(entryLen);
      const seq = getRecordSequenceNumber(child.recordNumber);
      const fileRef = BigInt(child.recordNumber) | (BigInt(seq) << 48n);
      const view = new DataView(entryBuf.buffer, entryBuf.byteOffset);
      view.setBigUint64(0, fileRef, true);
      view.setUint16(8, entryLen, true);
      view.setUint16(10, fnValueLen, true);
      view.setUint16(12, 0, true); // Flags

      // $FILE_NAME value inside entry at offset 16
      const parentSeq = getRecordSequenceNumber(dirRecordNumber);
      const parentRef = BigInt(dirRecordNumber) | (BigInt(parentSeq) << 48n);
      view.setBigUint64(16, parentRef, true);
      const ft = dateToFileTime(child.mtime);
      view.setBigUint64(24, ft, true);
      view.setBigUint64(32, ft, true);
      view.setBigUint64(40, ft, true);
      view.setBigUint64(48, ft, true);
      view.setBigUint64(56, BigInt(child.allocatedSize), true);
      view.setBigUint64(64, BigInt(child.size), true);
      const flags = child.fileFlags ?? (child.isDir ? NTFS_FILE_ATTR_I30_INDEX_PRESENT : NtfsFileFlags.Archive);
      view.setUint32(72, flags, true);
      entryBuf[80] = childName.length;
      entryBuf[81] = 0x03; // Win32 & DOS

      for (let c = 0; c < childName.length; c++) {
        const code = childName.charCodeAt(c);
        entryBuf[82 + c * 2] = code & 0xff;
        entryBuf[82 + c * 2 + 1] = (code >> 8) & 0xff;
      }

      entryBlocks.push(entryBuf);
      entriesLength += entryLen;
    }

    // Dummy end entry (16 bytes, flags = 0x02)
    const endEntry = new Uint8Array(16);
    const endView = new DataView(endEntry.buffer, endEntry.byteOffset);
    endView.setUint16(8, 16, true);
    endView.setUint16(12, 0x02, true); // End of node
    entryBlocks.push(endEntry);
    entriesLength += 16;

    const valueOffset = Math.ceil((nameOffset + nameChars * 2) / 8) * 8;
    const valueLength = 32 + entriesLength;
    const totalAttrLength = Math.ceil((valueOffset + valueLength) / 8) * 8;

    this.writeUint32(attrOffset, NtfsAttributeType.IndexRoot);
    this.writeUint32(attrOffset + 4, totalAttrLength);
    this.buffer[attrOffset + 8] = 0; // Resident
    this.buffer[attrOffset + 9] = nameChars;
    this.writeUint16(attrOffset + 10, nameOffset);
    this.writeUint16(attrOffset + 14, this.nextAttrId++);
    this.writeUint32(attrOffset + 16, valueLength);
    this.writeUint16(attrOffset + 20, valueOffset);

    for (let i = 0; i < nameChars; i++) {
      this.buffer[attrOffset + nameOffset + i * 2] = nameStr.charCodeAt(i) & 0xff;
      this.buffer[attrOffset + nameOffset + i * 2 + 1] = 0;
    }

    // Index Root Value
    const vOff = attrOffset + valueOffset;
    this.writeUint32(vOff + 0, NtfsAttributeType.FileName); // Indexed attribute ($FILE_NAME)
    this.writeUint32(vOff + 4, 1); // Collation rule (CollationFilename)
    this.writeUint32(vOff + 8, 4096); // Index record size
    this.buffer[vOff + 12] = 1; // Clusters per index record

    // Index Node Header
    this.writeUint32(vOff + 16, 16);
    this.writeUint32(vOff + 20, 16 + entriesLength);
    this.writeUint32(vOff + 24, 16 + entriesLength);
    this.buffer[vOff + 28] = 0; // Leaf node

    let writePos = vOff + 32;
    for (const eb of entryBlocks) {
      this.buffer.set(eb, writePos);
      writePos += eb.byteLength;
    }

    this.offset += totalAttrLength;
  }

  // Finalizes record, adds 0xFFFFFFFF end marker, and applies Update Sequence
  // Array (USA) fixups.
  finish(): Uint8Array {
    this.writeUint32(this.offset, NtfsAttributeType.End);
    this.offset += 8;
    this.writeUint32(24, this.offset); // Bytes used in MFT record
    this.writeUint16(40, this.nextAttrId); // Next attribute instance (offset 40 / 0x28)

    // There are two 512-byte sectors in a 1 KiB FILE record, so the USA
    // contains the update sequence number plus two saved trailers. The
    // constructor sets the header's USA offset (0x30) and word count (3).
    const usn = 1;
    this.writeUint16(48, usn);

    // Sector 0 (bytes 510..511):
    const sec0Word = this.buffer[510] | (this.buffer[511] << 8);
    this.writeUint16(50, sec0Word);
    this.buffer[510] = usn & 0xff;
    this.buffer[511] = (usn >> 8) & 0xff;

    // Sector 1 (bytes 1022..1023):
    const sec1Word = this.buffer[1022] | (this.buffer[1023] << 8);
    this.writeUint16(52, sec1Word);
    this.buffer[1022] = usn & 0xff;
    this.buffer[1023] = (usn >> 8) & 0xff;

    return this.buffer;
  }

  private encodeDataRun(count: number, lcn: number): Uint8Array {
    const countBytes: number[] = [];
    let tempC = count;
    while (tempC > 0) {
      countBytes.push(tempC & 0xff);
      tempC = Math.floor(tempC / 256);
    }
    if (countBytes.length === 0) countBytes.push(0);

    if (lcn < 0) {
      // Sparse run (LCN length = 0, no LCN bytes written, high nibble = 0)
      const header = countBytes.length & 0x0f;
      const result = new Uint8Array(1 + countBytes.length + 1);
      result[0] = header;
      result.set(countBytes, 1);
      result[result.length - 1] = 0x00; // End marker
      return result;
    }

    const lcnBytes: number[] = [];
    let tempL = lcn;
    while (tempL > 0) {
      lcnBytes.push(tempL & 0xff);
      tempL = Math.floor(tempL / 256);
    }
    if (lcnBytes.length === 0) lcnBytes.push(0);
    if ((lcnBytes[lcnBytes.length - 1] & 0x80) !== 0) {
      lcnBytes.push(0x00);
    }

    const header = (lcnBytes.length << 4) | (countBytes.length & 0x0f);
    const result = new Uint8Array(1 + countBytes.length + lcnBytes.length + 1);
    result[0] = header;
    result.set(countBytes, 1);
    result.set(lcnBytes, 1 + countBytes.length);
    result[result.length - 1] = 0x00; // End marker
    return result;
  }

  private writeUint16(offset: number, val: number) {
    this.buffer[offset] = val & 0xff;
    this.buffer[offset + 1] = (val >> 8) & 0xff;
  }

  private writeUint32(offset: number, val: number) {
    this.buffer[offset] = val & 0xff;
    this.buffer[offset + 1] = (val >> 8) & 0xff;
    this.buffer[offset + 2] = (val >> 16) & 0xff;
    this.buffer[offset + 3] = (val >> 24) & 0xff;
  }

  private writeBigUint64(offset: number, val: bigint) {
    const low = Number(val & 0xffffffffn);
    const high = Number((val >> 32n) & 0xffffffffn);
    this.writeUint32(offset, low);
    this.writeUint32(offset + 4, high);
  }
}
