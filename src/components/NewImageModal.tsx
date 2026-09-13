import React, { useState } from 'react';
import { FilePlus, Sparkles, X } from 'lucide-react';

interface NewImageModalProps {
  onClose: () => void;
  onCreate: (volumeLabel: string, includeDemoFiles: boolean) => void;
}

export const NewImageModal: React.FC<NewImageModalProps> = ({ onClose, onCreate }) => {
  const [volumeLabel, setVolumeLabel] = useState('NEW_DISK');
  const [includeDemoFiles, setIncludeDemoFiles] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate(volumeLabel.trim().toUpperCase() || 'NEW_DISK', includeDemoFiles);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <FilePlus className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">New Disk Image</h2>
              <div className="text-[11px] text-slate-400">Start with a clean staging workspace</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {/* Volume Label Input */}
          <div>
            <label className="block font-medium text-slate-300 mb-1">
              Disk / Volume Name
            </label>
            <input
              type="text"
              value={volumeLabel}
              onChange={(e) => setVolumeLabel(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '_'))}
              maxLength={16}
              autoFocus
              className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-sky-500 font-mono tracking-wide"
              placeholder="NEW_DISK"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Format, filesystem (FAT32 / exFAT), and disk capacity are chosen when you <strong>Save / Export</strong>.
            </p>
          </div>

          {/* Template Selection */}
          <div className="space-y-2">
            <label className="block font-medium text-slate-300">Workspace Content</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setIncludeDemoFiles(false)}
                className={`p-3 rounded-lg border text-left cursor-pointer transition flex flex-col gap-1 ${
                  !includeDemoFiles
                    ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                }`}
              >
                <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-sky-400"></span>
                  Blank Workspace
                </div>
                <div className="text-[10px] opacity-75">Empty root directory ready for your files and folders</div>
              </button>

              <button
                type="button"
                onClick={() => setIncludeDemoFiles(true)}
                className={`p-3 rounded-lg border text-left cursor-pointer transition flex flex-col gap-1 ${
                  includeDemoFiles
                    ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                }`}
              >
                <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                  Demo Files
                </div>
                <div className="text-[10px] opacity-75">Includes sample README.TXT and BOOT files</div>
              </button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-medium rounded-md transition shadow cursor-pointer"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

