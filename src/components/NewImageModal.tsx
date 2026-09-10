import React, { useState } from 'react';
import { Disc, HardDrive, Sparkles, X } from 'lucide-react';
import { DiskFormat } from '../lib/types';

interface NewImageModalProps {
  onClose: () => void;
  onCreate: (format: DiskFormat, volumeLabel: string, sizePreset?: string) => void;
}

export const NewImageModal: React.FC<NewImageModalProps> = ({ onClose, onCreate }) => {
  const [tab, setTab] = useState<'iso' | 'floppy' | 'disk'>('iso');
  const [volumeLabel, setVolumeLabel] = useState('VM_DISK');
  const [floppySize, setFloppySize] = useState('1.44M');
  const [diskSizeMb, setDiskSizeMb] = useState('32');
  const [diskFs, setDiskFs] = useState<'fat16' | 'fat32'>('fat16');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'iso') {
      onCreate('iso', volumeLabel || 'CDROM');
    } else if (tab === 'floppy') {
      onCreate('fat12', volumeLabel || 'FLOPPY', floppySize);
    } else {
      onCreate(diskFs, volumeLabel || 'DOS_DISK', diskSizeMb);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-white">Create New Disk Image</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-slate-800 bg-slate-950/50 text-xs">
          <button
            type="button"
            onClick={() => setTab('iso')}
            className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 font-medium transition cursor-pointer border-b-2 ${
              tab === 'iso'
                ? 'border-sky-500 text-sky-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Disc className="w-3.5 h-3.5" />
            <span>ISO Image</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('floppy')}
            className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 font-medium transition cursor-pointer border-b-2 ${
              tab === 'floppy'
                ? 'border-amber-500 text-amber-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Floppy (.IMG)</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('disk')}
            className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 font-medium transition cursor-pointer border-b-2 ${
              tab === 'disk'
                ? 'border-emerald-500 text-emerald-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Disk / USB (.IMG)</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {/* Volume Label Input */}
          <div>
            <label className="block font-medium text-slate-300 mb-1">
              Volume Label / Disk Name
            </label>
            <input
              type="text"
              value={volumeLabel}
              onChange={(e) => setVolumeLabel(e.target.value.toUpperCase())}
              maxLength={tab === 'iso' ? 32 : 11}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
              placeholder="MY_VM_DISK"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              {tab === 'iso' ? 'Up to 32 characters (ISO 9660)' : 'Up to 11 characters (FAT format)'}
            </p>
          </div>

          {/* ISO Options */}
          {tab === 'iso' && (
            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="joliet"
                  checked={true}
                  readOnly
                  className="rounded border-slate-700 text-sky-600 bg-slate-800"
                />
                <label htmlFor="joliet" className="text-slate-300 font-medium">
                  Enable Joliet Unicode (Long Filenames)
                </label>
              </div>
              <p className="text-[11px] text-slate-500 pl-5">
                Standard for modern VM hypervisors (QEMU, VirtualBox, VMware, Proxmox). Allows lowercase and Unicode filenames.
              </p>
            </div>
          )}

          {/* Floppy Options */}
          {tab === 'floppy' && (
            <div className="space-y-3">
              <div>
                <label className="block font-medium text-slate-300 mb-1">Floppy Capacity</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: '1.44M', label: '1.44 MB', desc: 'Standard 3.5" HD' },
                    { id: '2.88M', label: '2.88 MB', desc: 'Extended 3.5" ED' },
                    { id: '720K', label: '720 KB', desc: 'Double Density DD' },
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setFloppySize(preset.id)}
                      className={`p-2 rounded border text-left cursor-pointer transition ${
                        floppySize === preset.id
                          ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="font-semibold">{preset.label}</div>
                      <div className="text-[10px] opacity-75">{preset.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                Formatted with FAT12 and VFAT Long File Names support. Perfect for vintage DOS, BIOS flashing, and boot disks.
              </p>
            </div>
          )}

          {/* Disk / USB Options */}
          {tab === 'disk' && (
            <div className="space-y-3">
              <div>
                <label className="block font-medium text-slate-300 mb-1">Filesystem Type</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDiskFs('fat16');
                      if (parseInt(diskSizeMb, 10) > 2048) setDiskSizeMb('512');
                    }}
                    className={`p-2 rounded border text-left cursor-pointer transition ${
                      diskFs === 'fat16'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">FAT16</div>
                    <div className="text-[10px] opacity-75">Up to 2 GB disks</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDiskFs('fat32')}
                    className={`p-2 rounded border text-left cursor-pointer transition ${
                      diskFs === 'fat32'
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">FAT32</div>
                    <div className="text-[10px] opacity-75">Large VM drives / EFI</div>
                  </button>
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Disk Size (MB)</label>
                <div className="grid grid-cols-4 gap-1.5 mb-2">
                  {['10', '32', '64', '128', '256', '512', '1024'].map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setDiskSizeMb(size)}
                      className={`py-1 px-2 rounded border text-center font-mono cursor-pointer transition ${
                        diskSizeMb === size
                          ? 'border-sky-500 bg-sky-500/20 text-sky-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {size} MB
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min="1"
                  max="4096"
                  value={diskSizeMb}
                  onChange={(e) => setDiskSizeMb(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
                  placeholder="Custom size in MB"
                />
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="pt-2 border-t border-slate-800 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-medium rounded transition shadow cursor-pointer"
            >
              Create Image
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
