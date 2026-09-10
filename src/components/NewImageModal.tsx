import React, { useState } from 'react';
import { Box, Disc, HardDrive, Sparkles, X } from 'lucide-react';
import { DiskFormat } from '../lib/types';

interface NewImageModalProps {
  onClose: () => void;
  onCreate: (format: DiskFormat, volumeLabel: string, sizePreset?: string, hasMbr?: boolean) => void;
}

export const NewImageModal: React.FC<NewImageModalProps> = ({ onClose, onCreate }) => {
  const [tab, setTab] = useState<'vmdk' | 'iso' | 'disk' | 'floppy'>('vmdk');
  const [volumeLabel, setVolumeLabel] = useState('VM_DISK');
  const [floppySize, setFloppySize] = useState('1.44M');
  const [diskSizeMb, setDiskSizeMb] = useState('128');
  const [diskFs, setDiskFs] = useState<'fat16' | 'fat32' | 'exfat'>('fat16');
  const [diskPartitioning, setDiskPartitioning] = useState<'mbr' | 'superfloppy'>('mbr');

  // VMDK state
  const [vmdkFs, setVmdkFs] = useState<'fat32' | 'exfat'>('fat32');
  const [vmdkSizeMb, setVmdkSizeMb] = useState('1024'); // 1GB default

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'vmdk') {
      const format: DiskFormat = vmdkFs === 'fat32' ? 'vmdk-fat32' : 'vmdk-exfat';
      onCreate(format, volumeLabel || 'VMDK_DISK', vmdkSizeMb, true);
    } else if (tab === 'iso') {
      onCreate('iso', volumeLabel || 'CDROM');
    } else if (tab === 'floppy') {
      onCreate('fat12', volumeLabel || 'FLOPPY', floppySize, false);
    } else {
      let finalMb = parseInt(diskSizeMb, 10) || 128;
      if (diskFs === 'fat16' && finalMb > 2048) {
        finalMb = 2048;
      } else if (diskFs === 'fat32' && finalMb < 34) {
        finalMb = 34; // FAT32 requires at least 65,525 clusters
      } else if (finalMb > 2048) {
        finalMb = 2048;
      }
      onCreate(diskFs, volumeLabel || 'DOS_DISK', finalMb.toString(), diskPartitioning === 'mbr');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
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
        <div className="grid grid-cols-4 border-b border-slate-800 bg-slate-950/50 text-xs">
          <button
            type="button"
            onClick={() => setTab('vmdk')}
            className={`py-2.5 flex items-center justify-center gap-1.5 font-medium transition cursor-pointer border-b-2 ${
              tab === 'vmdk'
                ? 'border-violet-500 text-violet-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Box className="w-3.5 h-3.5" />
            <span>VMDK</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('iso')}
            className={`py-2.5 flex items-center justify-center gap-1.5 font-medium transition cursor-pointer border-b-2 ${
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
            onClick={() => setTab('disk')}
            className={`py-2.5 flex items-center justify-center gap-1.5 font-medium transition cursor-pointer border-b-2 ${
              tab === 'disk'
                ? 'border-emerald-500 text-emerald-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Raw Disk</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('floppy')}
            className={`py-2.5 flex items-center justify-center gap-1.5 font-medium transition cursor-pointer border-b-2 ${
              tab === 'floppy'
                ? 'border-amber-500 text-amber-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Floppy</span>
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
              {tab === 'iso' ? 'Up to 32 characters (ISO 9660)' : 'Up to 11 characters (FAT/exFAT label)'}
            </p>
          </div>

          {/* VMDK Options */}
          {tab === 'vmdk' && (
            <div className="space-y-3">
              <div>
                <label className="block font-medium text-slate-300 mb-1">Partition Filesystem</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setVmdkFs('fat32')}
                    className={`p-2.5 rounded border text-left cursor-pointer transition ${
                      vmdkFs === 'fat32'
                        ? 'border-violet-500 bg-violet-500/10 text-violet-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">FAT32 Partition</div>
                    <div className="text-[10px] opacity-75 mt-0.5">UEFI / EFI System Partition, DOS/Win/Linux</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setVmdkFs('exfat')}
                    className={`p-2.5 rounded border text-left cursor-pointer transition ${
                      vmdkFs === 'exfat'
                        ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">exFAT Partition</div>
                    <div className="text-[10px] opacity-75 mt-0.5">Large files &gt;4GB, modern Windows/Linux/macOS</div>
                  </button>
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Virtual Disk Capacity</label>
                <div className="grid grid-cols-5 gap-1.5 mb-2">
                  {[
                    { label: '512 MB', mb: '512' },
                    { label: '1 GB', mb: '1024' },
                    { label: '2 GB', mb: '2048' },
                    { label: '4 GB', mb: '4096' },
                    { label: '8 GB', mb: '8192' },
                  ].map((preset) => (
                    <button
                      key={preset.mb}
                      type="button"
                      onClick={() => setVmdkSizeMb(preset.mb)}
                      className={`py-1 px-1.5 rounded border text-center font-mono cursor-pointer transition text-[11px] ${
                        vmdkSizeMb === preset.mb
                          ? 'border-violet-500 bg-violet-500/20 text-violet-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="64"
                    max="65536"
                    value={vmdkSizeMb}
                    onChange={(e) => setVmdkSizeMb(e.target.value)}
                    className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-violet-500 font-mono"
                    placeholder="Custom capacity in MB"
                  />
                  <span className="text-slate-400 shrink-0 font-mono text-xs">MB</span>
                </div>
              </div>

              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-[11px] text-slate-400 space-y-1">
                <div className="text-violet-400 font-medium">VMware, VirtualBox &amp; QEMU Compatible</div>
                <div>
                  Formats a single-file <code className="text-slate-300">monolithicSparse</code> VMDK with virtual MBR (Partition 1 @ Sector 2048). Unallocated blocks consume zero disk space!
                </div>
              </div>
            </div>
          )}

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
                <label className="block font-medium text-slate-300 mb-1">Partition Scheme</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setDiskPartitioning('mbr')}
                    className={`p-2 rounded border text-left cursor-pointer transition ${
                      diskPartitioning === 'mbr'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">MBR Partitioned</div>
                    <div className="text-[10px] opacity-75">Partition 1 @ 1MB (VMs &amp; USB)</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDiskPartitioning('superfloppy')}
                    className={`p-2 rounded border text-left cursor-pointer transition ${
                      diskPartitioning === 'superfloppy'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">Raw Superfloppy</div>
                    <div className="text-[10px] opacity-75">Unpartitioned VBR @ Sector 0</div>
                  </button>
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Filesystem Type</label>
                <div className="grid grid-cols-3 gap-2">
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
                    onClick={() => {
                      setDiskFs('fat32');
                      if (parseInt(diskSizeMb, 10) < 34) setDiskSizeMb('64');
                    }}
                    className={`p-2 rounded border text-left cursor-pointer transition ${
                      diskFs === 'fat32'
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">FAT32</div>
                    <div className="text-[10px] opacity-75">Large drives / EFI</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDiskFs('exfat')}
                    className={`p-2 rounded border text-left cursor-pointer transition ${
                      diskFs === 'exfat'
                        ? 'border-teal-500 bg-teal-500/10 text-teal-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold">exFAT</div>
                    <div className="text-[10px] opacity-75">Files &gt;4GB</div>
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-slate-300">Disk Size (MB)</label>
                  <span className="text-[11px] text-slate-500 font-mono">Max 2048 MB (2 GB)</span>
                </div>
                <div className="grid grid-cols-4 gap-1.5 mb-2">
                  {['16', '32', '64', '128', '256', '512', '1024', '2048'].map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setDiskSizeMb(size)}
                      className={`py-1 px-2 rounded border text-center font-mono cursor-pointer transition ${
                        diskSizeMb === size
                          ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {size} MB
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={diskFs === 'fat32' ? 34 : 16}
                    max="2048"
                    value={diskSizeMb}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (val > 2048) {
                        setDiskSizeMb('2048');
                      } else {
                        setDiskSizeMb(e.target.value);
                      }
                    }}
                    className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="Custom size in MB (max 2048)"
                  />
                  <span className="text-slate-400 shrink-0 font-mono text-xs">MB</span>
                </div>
                {diskFs === 'fat32' && parseInt(diskSizeMb, 10) < 34 && (
                  <p className="mt-1 text-[11px] text-amber-400">
                    Note: FAT32 requires at least 34 MB to allocate standard 65,525 clusters.
                  </p>
                )}
              </div>

              {/* Informational tip recommending VMDK for large drives */}
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-[11px] text-slate-400 flex items-start gap-2">
                <span className="text-sky-400 shrink-0">💡</span>
                <div>
                  <span className="text-slate-200 font-medium">Need a larger disk (4 GB – 16 GB+)?</span> Raw <code className="text-slate-300">.IMG</code> files allocate every single byte on download. Use the <strong className="text-violet-400 cursor-pointer" onClick={() => setTab('vmdk')}>VMDK</strong> tab for sparse virtual disks that take almost zero disk space until filled.
                </div>
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
