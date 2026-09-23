import { describe, it } from 'vitest';
import { BufferReader } from '../lib/reader';
import { VhdxParser } from '../lib/vhdx/vhdx-parser';
import * as fs from 'fs';

describe('inspect', () => {
  it('inspects test-ntfs.vhdx', async () => {
    const filePath = 'scratch/test-ntfs.vhdx';
    if (!fs.existsSync(filePath)) return;
    const buf = fs.readFileSync(filePath);
    const file = new BufferReader(buf);
    const vhdx = new VhdxParser(file);
    const { virtualReader } = await vhdx.parse();

    console.log('--- VHDX Header Info ---');
    console.log('Virtual Disk Size:', virtualReader.size, 'bytes (', virtualReader.size / 1024 / 1024, 'MB )');

    // Read Sector 0 MBR
    const mbr = await virtualReader.read(0, 512);
    console.log('\n--- MBR (Sector 0) ---');
    console.log('MBR Sig:', mbr[510].toString(16), mbr[511].toString(16));
    const partType = mbr[450];
    const partLba = mbr[454] | (mbr[455] << 8) | (mbr[456] << 16) | (mbr[457] << 24);
    const partSectors = mbr[458] | (mbr[459] << 8) | (mbr[460] << 16) | (mbr[461] << 24);
    console.log('Partition 1: Type 0x' + partType.toString(16), 'Start LBA:', partLba, 'Sectors:', partSectors);

    // Read Primary VBR at LBA 2048
    const primaryVbr = await virtualReader.read(partLba * 512, 512);
    const viewVbr = new DataView(primaryVbr.buffer, primaryVbr.byteOffset);
    const oem = String.fromCharCode(...primaryVbr.slice(3, 11));
    console.log('\n--- Primary VBR (LBA ' + partLba + ') ---');
    console.log('OEM:', JSON.stringify(oem));
    console.log('Bytes per sector:', viewVbr.getUint16(11, true));
    console.log('Sectors per cluster:', primaryVbr[13]);
    console.log('Media descriptor:', '0x' + primaryVbr[21].toString(16));
    console.log('Total sectors (BPB):', viewVbr.getBigUint64(40, true).toString());
    console.log('MFT Cluster:', viewVbr.getBigUint64(48, true).toString());
    console.log('MFTMirr Cluster:', viewVbr.getBigUint64(56, true).toString());
    console.log('Clusters per MFT record:', primaryVbr[64], '(signed:', (primaryVbr[64] << 24) >> 24, ')');
    console.log('Clusters per Index record:', primaryVbr[68], '(signed:', (primaryVbr[68] << 24) >> 24, ')');
    console.log('VBR Sig:', primaryVbr[510].toString(16), primaryVbr[511].toString(16));

    // Read Backup VBR at last sector of disk / partition
    const backupLba = partLba + partSectors - 1;
    const backupVbr = await virtualReader.read(backupLba * 512, 512);
    console.log('\n--- Backup VBR (LBA ' + backupLba + ') ---');
    console.log('Backup OEM:', JSON.stringify(String.fromCharCode(...backupVbr.slice(3, 11))));
    console.log('Backup VBR Sig:', backupVbr[510].toString(16), backupVbr[511].toString(16));
    let match = true;
    for (let i = 0; i < 512; i++) {
      if (primaryVbr[i] !== backupVbr[i]) {
        match = false;
        console.log('Mismatch at byte', i, 'Primary:', primaryVbr[i], 'Backup:', backupVbr[i]);
        break;
      }
    }
    console.log('Primary and Backup VBR match 100%:', match);

    // Inspect MFT records
    const mftCluster = Number(viewVbr.getBigUint64(48, true));
    const mftByteOffset = (partLba + mftCluster * primaryVbr[13]) * 512;
    console.log('\n--- MFT Records starting at byte offset', mftByteOffset, '---');

    for (let rec = 0; rec <= 11; rec++) {
      const recBytes = await virtualReader.read(mftByteOffset + rec * 1024, 1024);
      const magic = String.fromCharCode(...recBytes.slice(0, 4));
      const viewRec = new DataView(recBytes.buffer, recBytes.byteOffset);
      const seq = viewRec.getUint16(16, true);
      const firstAttrOfs = viewRec.getUint16(20, true);
      const flags = viewRec.getUint16(22, true);
      const bytesInUse = viewRec.getUint32(24, true);
      const bytesAlloc = viewRec.getUint32(28, true);
      const recordNum = viewRec.getUint32(44, true);
      console.log(`Record ${rec}: magic=${magic}, seq=${seq}, flags=0x${flags.toString(16)}, bytesInUse=${bytesInUse}, bytesAlloc=${bytesAlloc}, recNum=${recordNum}, firstAttr=${firstAttrOfs}`);

      // Inspect attributes
      let aOfs = firstAttrOfs;
      const attrTypes: string[] = [];
      while (aOfs + 8 <= recBytes.length) {
        const aType = viewRec.getUint32(aOfs, true);
        if (aType === 0xffffffff) {
          attrTypes.push('END(0xFFFFFFFF)');
          break;
        }
        const aLen = viewRec.getUint32(aOfs + 4, true);
        const nonRes = recBytes[aOfs + 8];
        const nameLen = recBytes[aOfs + 9];
        let name = '';
        if (nameLen > 0) {
          const nameOfs = viewRec.getUint16(aOfs + 10, true);
          for (let c = 0; c < nameLen; c++) {
            name += String.fromCharCode(viewRec.getUint16(aOfs + nameOfs + c * 2, true));
          }
        }
        attrTypes.push(`0x${aType.toString(16)}${name ? ':' + name : ''}(${nonRes ? 'NR' : 'Res'},len=${aLen})`);
        if (aLen === 0) break;
        aOfs += aLen;
      }
      console.log(`  Attrs: ${attrTypes.join(', ')}`);
    }
  });
});
