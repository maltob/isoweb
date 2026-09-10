import React, { useEffect, useState } from 'react';
import {
  Database,
  Disc,
  Download,
  FolderOpen,
  HardDrive,
  Trash2,
  X,
} from 'lucide-react';
import { OpfsManager } from '../lib/storage/opfs';
import { SavedOpfsImage } from '../lib/types';
import { downloadBlob, formatBytes, formatDate } from '../lib/utils';

interface OpfsManagerModalProps {
  onClose: () => void;
  onLoadImage: (fileHandle: FileSystemFileHandle) => void;
}

export const OpfsManagerModal: React.FC<OpfsManagerModalProps> = ({
  onClose,
  onLoadImage,
}) => {
  const [images, setImages] = useState<SavedOpfsImage[]>([]);
  const [quota, setQuota] = useState<{ usedBytes: number; quotaBytes: number; ratio: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadList = async () => {
    setLoading(true);
    try {
      const list = await OpfsManager.listImages();
      setImages(list);
      const q = await OpfsManager.getStorageQuota();
      setQuota(q);
    } catch (e) {
      console.error('Failed to load OPFS list:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadList();
  }, []);

  const handleOpen = async (name: string) => {
    try {
      const handle = await OpfsManager.getImageFileHandle(name);
      onLoadImage(handle);
      onClose();
    } catch (e) {
      alert(`Failed to open OPFS file: ${e}`);
    }
  };

  const handleDownload = async (name: string) => {
    try {
      const file = await OpfsManager.getImageFile(name);
      downloadBlob(file, name);
    } catch (e) {
      alert(`Failed to download file from OPFS: ${e}`);
    }
  };

  const handleDelete = async (name: string) => {
    if (confirm(`Are you sure you want to delete "${name}" from OPFS storage?`)) {
      try {
        await OpfsManager.deleteImage(name);
        await loadList();
      } catch (e) {
        alert(`Failed to delete file: ${e}`);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">OPFS VM Disk Library</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quota bar */}
        {quota && (
          <div className="px-5 py-2.5 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <div>
              Storage Used: <span className="font-mono text-slate-200">{formatBytes(quota.usedBytes)}</span> of{' '}
              <span className="font-mono text-slate-200">{formatBytes(quota.quotaBytes)}</span>
            </div>
            <div className="w-32 bg-slate-800 rounded-full h-2 overflow-hidden">
              <div
                className="bg-emerald-500 h-full rounded-full transition-all"
                style={{ width: `${Math.max(1, quota.ratio * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Body */}
        <div className="p-5 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-slate-400 text-xs">
              <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span>Scanning OPFS storage...</span>
            </div>
          ) : images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center text-slate-400 text-xs gap-3">
              <Database className="w-10 h-10 text-slate-700" />
              <div>
                <p className="font-medium text-slate-300">No images stored in OPFS yet</p>
                <p className="text-[11px] text-slate-500 max-w-sm mt-1">
                  Use "Save / Export &gt; Save to OPFS Storage" from the top menu to persist VM disk images directly inside your browser for instant offline access!
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-lg overflow-hidden bg-slate-950/40">
              {images.map((img) => (
                <div
                  key={img.name}
                  className="p-3.5 flex items-center justify-between gap-3 hover:bg-slate-900/60 transition text-xs"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 bg-slate-900 rounded border border-slate-800">
                      {img.format === 'iso' ? (
                        <Disc className="w-4 h-4 text-sky-400" />
                      ) : (
                        <HardDrive className="w-4 h-4 text-amber-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-white truncate">{img.name}</div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-2">
                        <span>{formatBytes(img.size)}</span>
                        <span>•</span>
                        <span>{formatDate(img.lastModified)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleOpen(img.name)}
                      className="flex items-center gap-1 px-2.5 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs transition cursor-pointer"
                      title="Load into Explorer"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>Open</span>
                    </button>
                    <button
                      onClick={() => handleDownload(img.name)}
                      className="p-1 hover:text-emerald-400 hover:bg-slate-800 rounded text-slate-400 transition cursor-pointer"
                      title="Download to Computer"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(img.name)}
                      className="p-1 hover:text-rose-400 hover:bg-slate-800 rounded text-slate-400 transition cursor-pointer"
                      title="Delete from OPFS"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
