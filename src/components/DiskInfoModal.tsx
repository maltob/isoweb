import React from 'react';
import { Disc, HardDrive, Info, ShieldCheck, X } from 'lucide-react';
import { DiskImageInfo, VNode } from '../lib/types';
import { formatBytes } from '../lib/utils';

interface DiskInfoModalProps {
  imageInfo: DiskImageInfo;
  root: VNode;
  fileName: string;
  onClose: () => void;
}

export const DiskInfoModal: React.FC<DiskInfoModalProps> = ({
  imageInfo,
  root,
  fileName,
  onClose,
}) => {
  const countStats = (rootNode: VNode) => {
    let files = 0;
    let dirs = 0;
    const walk = (n: VNode) => {
      if (n !== rootNode && n.isDirectory) dirs++;
      if (!n.isDirectory) files++;
      for (const c of n.children || []) walk(c);
    };
    walk(rootNode);
    return { files, dirs };
  };

  const { files, dirs } = countStats(root);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-white">Disk Image Properties</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Main Info Card */}
          <div className="p-4 bg-slate-950 rounded-lg border border-slate-800 flex items-center gap-4">
            <div className="p-3 bg-slate-900 rounded-lg text-sky-400 border border-slate-800">
              {imageInfo.format === 'iso' ? (
                <Disc className="w-8 h-8" />
              ) : (
                <HardDrive className="w-8 h-8 text-amber-400" />
              )}
            </div>
            <div>
              <h3 className="text-base font-bold text-white">{fileName}</h3>
              <p className="text-slate-400">{imageInfo.formatName}</p>
              <p className="text-slate-500 font-mono text-[11px] mt-0.5">
                Volume Label: <span className="text-slate-300">{imageInfo.volumeLabel || 'NONE'}</span>
              </p>
            </div>
          </div>

          {/* Technical Specs Table */}
          <div className="border border-slate-800 rounded-lg overflow-hidden divide-y divide-slate-800 bg-slate-950/60">
            <div className="flex items-center justify-between p-2.5">
              <span className="text-slate-400">Total Capacity:</span>
              <span className="font-mono text-slate-200">
                {formatBytes(imageInfo.totalSize)} ({imageInfo.totalSize.toLocaleString()} bytes)
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5">
              <span className="text-slate-400">Sector / Block Size:</span>
              <span className="font-mono text-slate-200">{imageInfo.sectorSize} Bytes</span>
            </div>
            <div className="flex items-center justify-between p-2.5">
              <span className="text-slate-400">Total Sectors:</span>
              <span className="font-mono text-slate-200">{imageInfo.totalSectors.toLocaleString()}</span>
            </div>
            {imageInfo.clusterSize && (
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-400">Cluster Size:</span>
                <span className="font-mono text-slate-200">{imageInfo.clusterSize} Bytes</span>
              </div>
            )}
            <div className="flex items-center justify-between p-2.5">
              <span className="text-slate-400">Files / Directories:</span>
              <span className="font-mono text-slate-200">
                {files} file(s), {dirs} directory(ies)
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5">
              <span className="text-slate-400">Used Data Space:</span>
              <span className="font-mono text-slate-200">{formatBytes(root.size)}</span>
            </div>
            {imageInfo.format === 'iso' && (
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-400">Joliet Unicode Extension:</span>
                <span className="text-emerald-400 font-medium">
                  {imageInfo.hasJoliet ? 'Enabled (UCS-2 Unicode)' : 'Disabled'}
                </span>
              </div>
            )}
            {imageInfo.isBootable && (
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-400">Bootable Image:</span>
                <span className="text-emerald-400 font-medium flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {imageInfo.bootSystem || 'Yes'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex justify-end bg-slate-900/60">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition cursor-pointer text-xs font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
