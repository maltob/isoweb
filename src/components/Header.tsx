import React, { useRef, useState } from 'react';
import {
  Archive,
  Box,
  ChevronDown,
  Database,
  Disc,
  Download,
  FilePlus,
  HardDrive,
  Info,
  Save,
  Sliders,
  Upload,
} from 'lucide-react';
import { DiskFormat, DiskImageInfo } from '../lib/types';
import { formatBytes } from '../lib/utils';

interface HeaderProps {
  imageInfo: DiskImageInfo;
  fileName: string;
  rootSize: number;
  onNewImage: () => void;
  onOpenFile: (file: File) => void;
  onOpenExportModal: () => void;
  onSaveImage: (format?: DiskFormat) => void;
  onSaveToOpfs: () => void;
  onExportZip: () => void;
  onOpenOpfsManager: () => void;
  onOpenDiskInfo: () => void;
  isSaving?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  imageInfo,
  fileName,
  rootSize,
  onNewImage,
  onOpenFile,
  onOpenExportModal,
  onSaveImage,
  onSaveToOpfs,
  onExportZip,
  onOpenOpfsManager,
  onOpenDiskInfo,
  isSaving,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onOpenFile(e.target.files[0]);
      e.target.value = '';
    }
  };

  const getFormatBadge = () => {
    switch (imageInfo.format) {
      case 'iso':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30">
            <Disc className="w-3.5 h-3.5" />
            ISO 9660 {imageInfo.hasJoliet ? '+ Joliet' : ''}
          </span>
        );
      case 'fat12':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            FAT12 Floppy
          </span>
        );
      case 'fat16':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            FAT16 Disk
          </span>
        );
      case 'fat32':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            FAT32 Disk
          </span>
        );
      case 'exfat':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-teal-500/20 text-teal-300 border border-teal-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            exFAT Disk
          </span>
        );
      case 'vmdk-fat32':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            VMDK (FAT32)
          </span>
        );
      case 'vmdk-exfat':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            VMDK (exFAT)
          </span>
        );
      case 'vhdx-fat32':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            VHDX (FAT32)
          </span>
        );
      case 'vhdx-exfat':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            <HardDrive className="w-3.5 h-3.5" />
            VHDX (exFAT)
          </span>
        );
    }
  };

  return (
    <header className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex items-center justify-between gap-4 select-none shrink-0">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".iso,.img,.ima,.vfd,.flp,.bin,.raw,.vmdk,.vhdx"
        className="hidden"
      />

      {/* Brand & Active Disk Information */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2 bg-gradient-to-r from-sky-500 to-indigo-600 p-2 rounded-lg shadow-sm">
          <Disc className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-1.5">
              Disk WebUI
              <span className="text-[10px] font-normal px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded border border-slate-700">
                Offline VM Disk Studio
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400 truncate">
            <span className="font-medium text-slate-200 truncate">{fileName}</span>
            <span>•</span>
            <span className="text-slate-400 truncate">Label: {imageInfo.volumeLabel || 'UNLABELED'}</span>
            <span>•</span>
            {imageInfo.format === 'iso' ? (
              <span className="text-slate-300">
                Size: <span className="font-mono text-sky-400 font-semibold">{formatBytes(imageInfo.totalSize)}</span>
                <span className="text-slate-500 ml-1">({formatBytes(rootSize)} files)</span>
              </span>
            ) : (
              <span className="text-slate-300">
                Used: <span className="font-mono text-amber-400 font-semibold">{formatBytes(rootSize)}</span> /{' '}
                <span className="font-mono text-slate-400">{formatBytes(imageInfo.totalSize)}</span>
              </span>
            )}
          </div>
        </div>
        <div className="hidden sm:block ml-2">{getFormatBadge()}</div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2">
        {/* New Image */}
        <button
          onClick={onNewImage}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md border border-slate-700 transition cursor-pointer"
          title="Create a new ISO or Floppy/Disk image"
        >
          <FilePlus className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden md:inline">New Image</span>
        </button>

        {/* Open Image */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md border border-slate-700 transition cursor-pointer"
          title="Open an existing .ISO or .IMG from your computer"
        >
          <Upload className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden md:inline">Open</span>
        </button>

        {/* Save & Export Button & Dropdown */}
        <div className="relative inline-flex rounded-md shadow-sm">
          <button
            onClick={onOpenExportModal}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 disabled:bg-sky-800 text-white rounded-l-md transition cursor-pointer border-r border-sky-700/60"
            title="Configure export format, filesystem, and capacity"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Save / Export</span>
          </button>
          <button
            onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
            disabled={isSaving}
            className="px-1.5 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:bg-sky-800 text-white rounded-r-md transition cursor-pointer"
            title="Quick download options"
          >
            <ChevronDown className="w-3.5 h-3.5 opacity-85" />
          </button>

          {isExportMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setIsExportMenuOpen(false)}
              />
              <div className="absolute right-0 mt-8 w-72 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-30 py-1.5 text-xs divide-y divide-slate-700/50">
                {/* Save & Export Options Modal trigger */}
                <div className="p-1">
                  <button
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      onOpenExportModal();
                    }}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-sky-600/20 text-sky-300 font-semibold flex items-center gap-2.5 transition cursor-pointer border border-sky-500/30"
                  >
                    <Sliders className="w-4 h-4 text-sky-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div>Export Options...</div>
                      <div className="text-[10px] font-normal text-sky-400/80">Choose format, FAT32/exFAT, capacity</div>
                    </div>
                  </button>
                </div>

                <div className="space-y-0.5 py-1.5">
                  <div className="px-3.5 pt-1 pb-1 text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                    Quick Download
                  </div>

                  {/* Download as VMDK */}
                  <button
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      onSaveImage(imageInfo.format.startsWith('vmdk') ? undefined : 'vmdk-fat32');
                    }}
                    className="w-full text-left px-3.5 py-1.5 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                  >
                    <Box className="w-4 h-4 text-violet-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold flex items-center gap-1.5">
                        <span>Download .VMDK</span>
                        {imageInfo.format.startsWith('vmdk') && (
                          <span className="text-[9px] px-1 py-0.2 font-normal bg-violet-500/20 text-violet-300 rounded border border-violet-500/40">Active</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">VMware / VirtualBox virtual disk</div>
                    </div>
                  </button>

                  {/* Download as VHDX */}
                  <button
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      onSaveImage(imageInfo.format.startsWith('vhdx') ? undefined : 'vhdx-fat32');
                    }}
                    className="w-full text-left px-3.5 py-1.5 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                  >
                    <Database className="w-4 h-4 text-cyan-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold flex items-center gap-1.5">
                        <span>Download .VHDX</span>
                        {imageInfo.format.startsWith('vhdx') && (
                          <span className="text-[9px] px-1 py-0.2 font-normal bg-cyan-500/20 text-cyan-300 rounded border border-cyan-500/40">Active</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">Microsoft Hyper-V virtual disk</div>
                    </div>
                  </button>

                  {/* Download as ISO */}
                  <button
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      onSaveImage(imageInfo.format === 'iso' ? undefined : 'iso');
                    }}
                    className="w-full text-left px-3.5 py-1.5 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                  >
                    <Disc className="w-4 h-4 text-sky-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold flex items-center gap-1.5">
                        <span>Download .ISO</span>
                        {imageInfo.format === 'iso' && (
                          <span className="text-[9px] px-1 py-0.2 font-normal bg-sky-500/20 text-sky-300 rounded border border-sky-500/40">Active</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">ISO 9660 + Joliet optical disc</div>
                    </div>
                  </button>

                  {/* Download as Floppy IMG if files fit or if active format is floppy */}
                  {(imageInfo.format === 'fat12' || rootSize <= 1400000) && (
                    <button
                      onClick={() => {
                        setIsExportMenuOpen(false);
                        onSaveImage('fat12');
                      }}
                      className="w-full text-left px-3.5 py-1.5 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                    >
                      <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold flex items-center gap-1.5">
                          <span>Download .IMG (1.44MB Floppy)</span>
                          {imageInfo.format === 'fat12' && (
                            <span className="text-[9px] px-1 py-0.2 font-normal bg-amber-500/20 text-amber-300 rounded border border-amber-500/40">Active</span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">Standard 3.5" HD Floppy (FAT12)</div>
                      </div>
                    </button>
                  )}

                  {/* Download as Hard Disk IMG */}
                  <button
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      onSaveImage(
                        imageInfo.format === 'fat16' || imageInfo.format === 'fat32' || imageInfo.format === 'exfat'
                          ? undefined
                          : 'fat32'
                      );
                    }}
                    className="w-full text-left px-3.5 py-1.5 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                  >
                    <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold flex items-center gap-1.5">
                        <span>Download Raw Disk (.raw)</span>
                        {(imageInfo.format === 'fat16' || imageInfo.format === 'fat32' || imageInfo.format === 'exfat') && (
                          <span className="text-[9px] px-1 py-0.2 font-normal bg-emerald-500/20 text-emerald-300 rounded border border-emerald-500/40">Active</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">MBR partitioned FAT32/exFAT hard disk</div>
                    </div>
                  </button>
                </div>

                <div className="space-y-0.5 pt-1.5">
                  <div className="px-3.5 pt-1 pb-1 text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                    Browser & Archive
                  </div>

                  <button
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      onSaveToOpfs();
                    }}
                    className="w-full text-left px-3.5 py-1.5 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                  >
                    <Save className="w-4 h-4 text-amber-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">Save to OPFS Storage</div>
                      <div className="text-[10px] text-slate-400 truncate">Store persistently in browser sandbox</div>
                    </div>
                  </button>

                  <button
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      onExportZip();
                    }}
                    className="w-full text-left px-3.5 py-1.5 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                  >
                    <Archive className="w-4 h-4 text-pink-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">Extract All as ZIP</div>
                      <div className="text-[10px] text-slate-400 truncate">Download staged files in an archive</div>
                    </div>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* OPFS Storage Manager */}
        <button
          onClick={onOpenOpfsManager}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md border border-slate-700 transition cursor-pointer"
          title="Manage OPFS Saved Images"
        >
          <Database className="w-3.5 h-3.5 text-emerald-400" />
          <span className="hidden lg:inline">OPFS Library</span>
        </button>

        {/* Disk Info */}
        <button
          onClick={onOpenDiskInfo}
          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-md transition cursor-pointer"
          title="View Disk Geometry & Info"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
