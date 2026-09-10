import React, { useRef, useState } from 'react';
import {
  Archive,
  ChevronDown,
  Database,
  Disc,
  Download,
  FilePlus,
  HardDrive,
  Info,
  Save,
  Upload,
} from 'lucide-react';
import { DiskImageInfo } from '../lib/types';
import { formatBytes } from '../lib/utils';

interface HeaderProps {
  imageInfo: DiskImageInfo;
  fileName: string;
  rootSize: number;
  onNewImage: () => void;
  onOpenFile: (file: File) => void;
  onSaveImage: () => void;
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
    }
  };

  return (
    <header className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex items-center justify-between gap-4 select-none shrink-0">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".iso,.img,.ima,.vfd,.flp,.bin,.raw,.vmdk"
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
              ISOWeb
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

        {/* Save & Export Dropdown */}
        <div className="relative">
          <button
            onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-sky-800 text-white rounded-md transition shadow-sm cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Save / Export</span>
            <ChevronDown className="w-3 h-3 ml-0.5 opacity-80" />
          </button>

          {isExportMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setIsExportMenuOpen(false)}
              />
              <div className="absolute right-0 mt-1.5 w-60 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-30 py-1 text-xs">
                <button
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onSaveImage();
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                >
                  <Download className="w-4 h-4 text-sky-400" />
                  <div>
                    <div className="font-semibold">
                      Download {imageInfo.format.startsWith('vmdk') ? '.VMDK' : imageInfo.format === 'iso' ? '.ISO' : '.IMG'}
                    </div>
                    <div className="text-[11px] text-slate-400">Save disk image to your computer</div>
                  </div>
                </button>

                <button
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onSaveToOpfs();
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                >
                  <Save className="w-4 h-4 text-emerald-400" />
                  <div>
                    <div className="font-semibold">Save to OPFS Storage</div>
                    <div className="text-[11px] text-slate-400">Store persistently in browser library</div>
                  </div>
                </button>

                <button
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onExportZip();
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-slate-700/70 flex items-center gap-2.5 text-slate-200 cursor-pointer"
                >
                  <Archive className="w-4 h-4 text-amber-400" />
                  <div>
                    <div className="font-semibold">Extract All as ZIP</div>
                    <div className="text-[11px] text-slate-400">Download all files in an archive</div>
                  </div>
                </button>
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
