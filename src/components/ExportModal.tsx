import React, { useState, useMemo } from 'react';
import {
  AlertTriangle,
  Box,
  Check,
  Database,
  Disc,
  Download,
  FolderArchive,
  HardDrive,
  Info,
  Save,
  X,
} from 'lucide-react';
import { DiskFormat, VNode } from '../lib/types';
import { VirtualFS } from '../lib/virtual-fs/virtual-fs';

export interface ExportSettings {
  format: DiskFormat;
  volumeLabel: string;
  capacityMb?: number;
  forceBrowserDownload?: boolean;
  isZip?: boolean;
}

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  vfs: VirtualFS;
  currentFileName: string;
  onExport: (settings: ExportSettings) => Promise<void>;
  isSaving: boolean;
}

const MAX_FAT32_FILE_SIZE = 4294967295; // 4 GB - 1 byte

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  vfs,
  currentFileName,
  onExport,
  isSaving,
}) => {
  const root = vfs.getRoot();
  const currentInfo = vfs.getImageInfo();
  const activeFmt = vfs.getFormat();

  // Inspect files to find any file > 4GB and compute total size
  const { totalBytes, fileCount, dirCount, fileOver4GB } = useMemo<{
    totalBytes: number;
    fileCount: number;
    dirCount: number;
    fileOver4GB: { name: string; size: number } | null;
  }>(() => {
    let bytes = 0;
    let files = 0;
    let dirs = 0;
    let over4gb: { name: string; size: number } | null = null;

    const inspect = (node: VNode) => {
      if (node !== root) {
        if (node.isDirectory) {
          dirs++;
        } else {
          files++;
          const sz = node.fileRef?.size ?? node.data?.byteLength ?? node.size ?? 0;
          bytes += sz;
          if (sz > MAX_FAT32_FILE_SIZE && !over4gb) {
            over4gb = { name: node.name, size: sz };
          }
        }
      }
      for (const child of node.children || []) {
        inspect(child);
      }
    };
    inspect(root);
    return { totalBytes: bytes, fileCount: files, dirCount: dirs, fileOver4GB: over4gb };
  }, [root]);

  // Initial tab selection
  const initialCategory = useMemo<'vhdx' | 'vmdk' | 'iso' | 'raw' | 'zip'>(() => {
    if (activeFmt.startsWith('vhdx')) return 'vhdx';
    if (activeFmt.startsWith('vmdk')) return 'vmdk';
    if (activeFmt === 'iso') return 'iso';
    if (activeFmt.startsWith('fat') || activeFmt === 'exfat') return 'raw';
    return 'vhdx'; // default to modern VHDX
  }, [activeFmt]);

  const [category, setCategory] = useState<'vhdx' | 'vmdk' | 'iso' | 'raw' | 'zip'>(initialCategory);

  // Filesystem selection for VHDX & VMDK & Raw
  const initialFs = useMemo<'fat32' | 'exfat' | 'ntfs' | 'xfs'>(() => {
    if (fileOver4GB) return 'exfat';
    if (activeFmt.includes('xfs')) return 'xfs';
    if (activeFmt.includes('ntfs')) return 'ntfs';
    if (activeFmt.includes('exfat')) return 'exfat';
    return 'fat32';
  }, [activeFmt, fileOver4GB]);

  const [fsType, setFsType] = useState<'fat32' | 'exfat' | 'ntfs' | 'xfs'>(initialFs);

  // Raw disk format options
  const [rawSubtype, setRawSubtype] = useState<'floppy' | 'fat16' | 'fat32' | 'exfat' | 'ntfs' | 'xfs'>(
    fileOver4GB ? 'exfat' : activeFmt === 'xfs' ? 'xfs' : activeFmt === 'fat12' ? 'floppy' : activeFmt === 'fat16' ? 'fat16' : activeFmt === 'ntfs' ? 'ntfs' : 'fat32'
  );

  // Volume Label
  const [volumeLabel, setVolumeLabel] = useState(
    currentInfo.volumeLabel || currentFileName.replace(/\.[^/.]+$/, '').toUpperCase() || 'VIRTUAL_DISK'
  );

  // Minimum required MB for virtual disk
  const minRequiredMb = useMemo(() => {
    const overheadBytes = Math.ceil(totalBytes * 1.3) + 32 * 1024 * 1024;
    return Math.max(1024, Math.ceil(overheadBytes / (1024 * 1024)));
  }, [totalBytes]);

  // Virtual capacity in MB for VHDX / VMDK
  const defaultCapacityPreset = useMemo(() => {
    if (minRequiredMb <= 1024) return '1024';
    if (minRequiredMb <= 2048) return '2048';
    if (minRequiredMb <= 4096) return '4096';
    if (minRequiredMb <= 8192) return '8192';
    if (minRequiredMb <= 16384) return '16384';
    return minRequiredMb.toString();
  }, [minRequiredMb]);

  const [capacityMb, setCapacityMb] = useState<string>(defaultCapacityPreset);

  if (!isOpen) return null;

  const hasFileSystemAccess = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const handleExportSubmit = async (forceBrowserDownload: boolean = false) => {
    let resolvedFormat: DiskFormat;
    const mbNum = parseInt(capacityMb, 10) || minRequiredMb;

    if (category === 'vhdx') {
      resolvedFormat =
        fsType === 'xfs'
          ? 'vhdx-xfs'
          : fsType === 'ntfs'
          ? 'vhdx-ntfs'
          : fsType === 'exfat'
          ? 'vhdx-exfat'
          : 'vhdx-fat32';
    } else if (category === 'vmdk') {
      resolvedFormat =
        fsType === 'xfs'
          ? 'vmdk-xfs'
          : fsType === 'ntfs'
          ? 'vmdk-ntfs'
          : fsType === 'exfat'
          ? 'vmdk-exfat'
          : 'vmdk-fat32';
    } else if (category === 'iso') {
      resolvedFormat = 'iso';
    } else if (category === 'zip') {
      resolvedFormat = 'iso'; // zip is handled separately by App.tsx
    } else {
      resolvedFormat = rawSubtype === 'floppy' ? 'fat12' : rawSubtype;
    }

    const cleanLabel = volumeLabel.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_') || 'DISK';

    await onExport({
      format: resolvedFormat,
      volumeLabel: cleanLabel,
      capacityMb: category === 'vhdx' || category === 'vmdk' ? mbNum : undefined,
      forceBrowserDownload,
      isZip: category === 'zip',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-xl overflow-hidden my-auto">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Save className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Save &amp; Export Disk Image</h2>
              <div className="text-[11px] text-slate-400">
                {fileCount} {fileCount === 1 ? 'file' : 'files'}
                {dirCount > 0 && `, ${dirCount} ${dirCount === 1 ? 'folder' : 'folders'}`} • {formatSize(totalBytes)} content
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSaving}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 4GB Alert if applicable */}
        {fileOver4GB && (
          <div className="mx-5 mt-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2.5 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-amber-300">File exceeds 4 GB limit: </span>
              <code className="text-amber-100 font-mono">{fileOver4GB.name}</code> ({formatSize(fileOver4GB.size)}).
              <div className="mt-0.5 text-[11px] text-amber-300/80">
                FAT32 cannot store individual files over 4 GB. <strong>exFAT</strong> is automatically selected for maximum compatibility.
              </div>
            </div>
          </div>
        )}

        {/* Category / Container Selection */}
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
              1. Choose Container Format
            </label>
            <div className="grid grid-cols-5 gap-2 text-xs">
              {/* VHDX */}
              <button
                type="button"
                onClick={() => setCategory('vhdx')}
                className={`p-2.5 rounded-lg border text-center transition cursor-pointer flex flex-col items-center gap-1.5 ${
                  category === 'vhdx'
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300 shadow-sm'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <Database className="w-5 h-5" />
                <div className="font-bold">VHDX</div>
                <div className="text-[10px] opacity-75 leading-tight">Hyper-V / Win</div>
              </button>

              {/* VMDK */}
              <button
                type="button"
                onClick={() => setCategory('vmdk')}
                className={`p-2.5 rounded-lg border text-center transition cursor-pointer flex flex-col items-center gap-1.5 ${
                  category === 'vmdk'
                    ? 'border-violet-500 bg-violet-500/15 text-violet-300 shadow-sm'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <Box className="w-5 h-5" />
                <div className="font-bold">VMDK</div>
                <div className="text-[10px] opacity-75 leading-tight">VMware/VBox</div>
              </button>

              {/* ISO */}
              <button
                type="button"
                onClick={() => setCategory('iso')}
                className={`p-2.5 rounded-lg border text-center transition cursor-pointer flex flex-col items-center gap-1.5 ${
                  category === 'iso'
                    ? 'border-sky-500 bg-sky-500/15 text-sky-300 shadow-sm'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <Disc className="w-5 h-5" />
                <div className="font-bold">ISO</div>
                <div className="text-[10px] opacity-75 leading-tight">CD / DVD</div>
              </button>

              {/* Raw Disk / Floppy */}
              <button
                type="button"
                onClick={() => setCategory('raw')}
                className={`p-2.5 rounded-lg border text-center transition cursor-pointer flex flex-col items-center gap-1.5 ${
                  category === 'raw'
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 shadow-sm'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <HardDrive className="w-5 h-5" />
                <div className="font-bold">IMG / RAW</div>
                <div className="text-[10px] opacity-75 leading-tight">Raw Disk/Floppy</div>
              </button>

              {/* ZIP */}
              <button
                type="button"
                onClick={() => setCategory('zip')}
                className={`p-2.5 rounded-lg border text-center transition cursor-pointer flex flex-col items-center gap-1.5 ${
                  category === 'zip'
                    ? 'border-amber-500 bg-amber-500/15 text-amber-300 shadow-sm'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <FolderArchive className="w-5 h-5" />
                <div className="font-bold">ZIP</div>
                <div className="text-[10px] opacity-75 leading-tight">Zip Archive</div>
              </button>
            </div>
          </div>

          {/* Filesystem Selection (for VHDX & VMDK) */}
          {(category === 'vhdx' || category === 'vmdk') && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                2. Partition Filesystem
              </label>
              <div className="grid grid-cols-4 gap-2 text-xs">
                {/* FAT32 */}
                <button
                  type="button"
                  disabled={Boolean(fileOver4GB)}
                  onClick={() => setFsType('fat32')}
                  className={`p-3 rounded-lg border text-left transition cursor-pointer relative ${
                    fsType === 'fat32' && !fileOver4GB
                      ? 'border-sky-500 bg-sky-500/15 text-sky-200 ring-1 ring-sky-500/30'
                      : fileOver4GB
                      ? 'border-slate-800/50 bg-slate-950/40 text-slate-500 cursor-not-allowed'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between font-bold text-sm">
                    <span>FAT32</span>
                    {fsType === 'fat32' && !fileOver4GB && <Check className="w-4 h-4 text-sky-400" />}
                  </div>
                  <div className="text-[11px] mt-1 text-slate-400 leading-snug">
                    Broadest compatibility: DOS, Windows, Linux, macOS, UEFI boot.
                  </div>
                  <div className="text-[10px] text-slate-400/80 mt-1 font-mono">Max file: 4 GB</div>
                </button>

                {/* exFAT */}
                <button
                  type="button"
                  onClick={() => setFsType('exfat')}
                  className={`p-3 rounded-lg border text-left transition cursor-pointer relative ${
                    fsType === 'exfat' || fileOver4GB
                      ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/30'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between font-bold text-sm">
                    <span className="flex items-center gap-1.5">
                      <span>exFAT</span>
                      {fileOver4GB && (
                        <span className="text-[9px] px-1 py-0.2 bg-emerald-500/30 text-emerald-300 rounded font-normal">
                          Required
                        </span>
                      )}
                    </span>
                    {(fsType === 'exfat' || fileOver4GB) && <Check className="w-4 h-4 text-emerald-400" />}
                  </div>
                  <div className="text-[11px] mt-1 text-slate-400 leading-snug">
                    Modern standard: No 4 GB limits, Windows, macOS, Linux native.
                  </div>
                  <div className="text-[10px] text-slate-400/80 mt-1 font-mono">Max file: 16 EB</div>
                </button>

                {/* NTFS */}
                <button
                  type="button"
                  onClick={() => setFsType('ntfs')}
                  className={`p-3 rounded-lg border text-left transition cursor-pointer relative ${
                    fsType === 'ntfs' && !fileOver4GB
                      ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-500/30'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between font-bold text-sm">
                    <span>NTFS</span>
                    {fsType === 'ntfs' && !fileOver4GB && <Check className="w-4 h-4 text-indigo-400" />}
                  </div>
                  <div className="text-[11px] mt-1 text-slate-400 leading-snug">
                    Windows native: Full MFT, standard info, runs, Hyper-V &amp; VM ready.
                  </div>
                  <div className="text-[10px] text-slate-400/80 mt-1 font-mono">Max file: 16 TB</div>
                </button>

                {/* XFS */}
                <button
                  type="button"
                  onClick={() => setFsType('xfs')}
                  className={`p-3 rounded-lg border text-left transition cursor-pointer relative ${
                    fsType === 'xfs' && !fileOver4GB
                      ? 'border-amber-500 bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between font-bold text-sm">
                    <span>XFS</span>
                    {fsType === 'xfs' && !fileOver4GB && <Check className="w-4 h-4 text-amber-400" />}
                  </div>
                  <div className="text-[11px] mt-1 text-slate-400 leading-snug">
                    Linux native: 64-bit extent journaling (RHEL, Rocky, CentOS, SUSE).
                  </div>
                  <div className="text-[10px] text-slate-400/80 mt-1 font-mono">Max file: 8 EB</div>
                </button>
              </div>
            </div>
          )}

          {/* Raw Disk Subtype (if raw selected) */}
          {category === 'raw' && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                2. Image Subtype
              </label>
              <div className="grid grid-cols-6 gap-2 text-xs">
                {[
                  { id: 'floppy', label: '1.44M Floppy', desc: 'FAT12', disabled: totalBytes > 1440 * 1024 },
                  { id: 'fat16', label: 'FAT16 Disk', desc: 'Up to 2GB', disabled: Boolean(fileOver4GB) },
                  { id: 'fat32', label: 'FAT32 Disk', desc: 'Standard MBR', disabled: Boolean(fileOver4GB) },
                  { id: 'exfat', label: 'exFAT Disk', desc: 'Large Files', disabled: false },
                  { id: 'ntfs', label: 'NTFS Disk', desc: 'Windows MFT', disabled: false },
                  { id: 'xfs', label: 'XFS Disk', desc: 'Linux Native', disabled: false },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => setRawSubtype(item.id as any)}
                    className={`p-2.5 rounded-lg border text-center transition cursor-pointer ${
                      rawSubtype === item.id
                        ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                        : item.disabled
                        ? 'border-slate-800/40 bg-slate-950/40 text-slate-600 cursor-not-allowed'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-bold">{item.label}</div>
                    <div className="text-[10px] text-slate-400">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Capacity Settings (for VHDX & VMDK) */}
          {(category === 'vhdx' || category === 'vmdk') && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  3. Virtual Disk Capacity
                </label>
                <span className="text-[11px] text-slate-400">
                  Min suggested: <span className="font-mono text-slate-300">{minRequiredMb} MB</span>
                </span>
              </div>

              <div className="grid grid-cols-6 gap-1.5 mb-2">
                {[
                  { label: '1 GB', mb: '1024' },
                  { label: '2 GB', mb: '2048' },
                  { label: '4 GB', mb: '4096' },
                  { label: '8 GB', mb: '8192' },
                  { label: '16 GB', mb: '16384' },
                  { label: '32 GB', mb: '32768' },
                ].map((preset) => {
                  const isTooSmall = parseInt(preset.mb, 10) < minRequiredMb;
                  return (
                    <button
                      key={preset.mb}
                      type="button"
                      disabled={isTooSmall}
                      onClick={() => setCapacityMb(preset.mb)}
                      className={`py-1.5 px-1 rounded-md border text-center font-mono cursor-pointer transition text-xs ${
                        capacityMb === preset.mb
                          ? 'border-sky-500 bg-sky-500/20 text-sky-300 font-bold'
                          : isTooSmall
                          ? 'border-slate-800/40 bg-slate-950/40 text-slate-600 cursor-not-allowed'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={minRequiredMb}
                  value={capacityMb}
                  onChange={(e) => setCapacityMb(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-sky-500 font-mono text-xs"
                  placeholder="Custom capacity in MB"
                />
                <span className="text-slate-400 shrink-0 font-mono text-xs">MB</span>
              </div>

              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-400">
                <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>
                  <strong>Dynamic Sparse Disk:</strong> The exported file only takes up space for your actual files ({formatSize(totalBytes)}), not the full capacity.
                </span>
              </div>
            </div>
          )}

          {/* Volume Label Input */}
          {category !== 'zip' && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                {category === 'iso' ? '2. Volume Label' : '4. Volume Label'}
              </label>
              <input
                type="text"
                maxLength={category === 'iso' ? 32 : 11}
                value={volumeLabel}
                onChange={(e) => setVolumeLabel(e.target.value)}
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-sky-500 font-mono text-xs uppercase"
                placeholder={category === 'iso' ? 'CDROM (up to 32 chars)' : 'DISK (up to 11 chars)'}
              />
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="px-5 py-3.5 bg-slate-950 border-t border-slate-800 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="px-3.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 rounded-md hover:bg-slate-800 transition cursor-pointer"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            {/* Fallback download button when streaming is available */}
            {hasFileSystemAccess && category !== 'zip' && (
              <button
                type="button"
                disabled={isSaving}
                onClick={() => handleExportSubmit(true)}
                className="px-3 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-md border border-slate-700 transition cursor-pointer flex items-center gap-1.5"
                title="Download file through your browser download manager"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Browser Download</span>
              </button>
            )}

            {/* Primary Action Button */}
            <button
              type="button"
              disabled={isSaving}
              onClick={() => handleExportSubmit(false)}
              className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:bg-sky-800 rounded-md shadow transition cursor-pointer flex items-center gap-1.5"
            >
              {hasFileSystemAccess && category !== 'zip' ? (
                <>
                  <HardDrive className="w-4 h-4 text-sky-200" />
                  <span>Stream Directly to Disk</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Download Image</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
