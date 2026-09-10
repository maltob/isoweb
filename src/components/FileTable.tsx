import React, { useState } from 'react';
import {
  Archive,
  Code2,
  Download,
  Eye,
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  Music,
  Pencil,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { VNode } from '../lib/types';
import { formatBytes, formatDate, getFileCategory, getFileExtension } from '../lib/utils';

interface FileTableProps {
  currentDir: VNode;
  searchTerm: string;
  onNavigate: (path: string) => void;
  onPreviewFile: (node: VNode) => void;
  onDownloadFile: (node: VNode) => void;
  onRenameFile: (node: VNode) => void;
  onDeleteFile: (node: VNode) => void;
  onDropDataTransfer: (dataTransfer: DataTransfer) => void;
  selectedPaths: Set<string>;
  onToggleSelect: (path: string, isMulti: boolean) => void;
  onSelectAll: (select: boolean) => void;
}

type SortField = 'name' | 'size' | 'type' | 'date';
type SortOrder = 'asc' | 'desc';

export const FileTable: React.FC<FileTableProps> = ({
  currentDir,
  searchTerm,
  onNavigate,
  onPreviewFile,
  onDownloadFile,
  onRenameFile,
  onDeleteFile,
  onDropDataTransfer,
  selectedPaths,
  onToggleSelect,
  onSelectAll,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const children = currentDir.children || [];

  // Filter
  const filtered = children.filter((child) =>
    child.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    // Folders always first
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }

    let cmp = 0;
    if (sortField === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (sortField === 'size') {
      cmp = a.size - b.size;
    } else if (sortField === 'type') {
      const extA = getFileExtension(a.name);
      const extB = getFileExtension(b.name);
      cmp = extA.localeCompare(extB);
    } else if (sortField === 'date') {
      cmp = a.modifiedTime.getTime() - b.modifiedTime.getTime();
    }

    return sortOrder === 'asc' ? cmp : -cmp;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer) {
      onDropDataTransfer(e.dataTransfer);
    }
  };

  const allSelected = sorted.length > 0 && sorted.every((n) => selectedPaths.has(n.path));

  const getIcon = (node: VNode) => {
    if (node.isDirectory) {
      return <Folder className="w-4 h-4 text-sky-400 shrink-0" />;
    }
    const cat = getFileCategory(node.name, false);
    switch (cat) {
      case 'image':
        return <FileImage className="w-4 h-4 text-pink-400 shrink-0" />;
      case 'text':
        return <FileText className="w-4 h-4 text-emerald-400 shrink-0" />;
      case 'code':
        return <FileCode className="w-4 h-4 text-amber-400 shrink-0" />;
      case 'executable':
        return <Code2 className="w-4 h-4 text-red-400 shrink-0" />;
      case 'archive':
      case 'disk':
        return <Archive className="w-4 h-4 text-purple-400 shrink-0" />;
      case 'audio':
        return <Music className="w-4 h-4 text-indigo-400 shrink-0" />;
      default:
        return <File className="w-4 h-4 text-slate-400 shrink-0" />;
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex-1 flex flex-col relative overflow-hidden bg-slate-950/40 select-none ${
        isDragOver ? 'ring-2 ring-sky-500 bg-sky-950/20' : ''
      }`}
    >
      {/* Drag overlay notice */}
      {isDragOver && (
        <div className="absolute inset-0 bg-sky-950/80 backdrop-blur-xs flex flex-col items-center justify-center z-20 pointer-events-none text-sky-200">
          <UploadCloud className="w-12 h-12 animate-bounce text-sky-400 mb-2" />
          <p className="text-base font-semibold">Drop files here to add to {currentDir.name === '/' ? 'Root' : currentDir.name}</p>
          <p className="text-xs text-sky-300">Files will be staged in the VM image</p>
        </div>
      )}

      {/* Table header */}
      <div className="bg-slate-900/90 border-b border-slate-800 text-[11px] font-semibold text-slate-400 flex items-center px-4 py-2 shrink-0">
        <div className="w-8 flex items-center justify-center">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => onSelectAll(e.target.checked)}
            className="rounded border-slate-700 text-sky-600 focus:ring-sky-500 bg-slate-800 cursor-pointer"
          />
        </div>
        <div
          onClick={() => handleSort('name')}
          className="flex-1 flex items-center gap-1 cursor-pointer hover:text-slate-200"
        >
          <span>NAME</span>
          {sortField === 'name' && (sortOrder === 'asc' ? ' ↑' : ' ↓')}
        </div>
        <div
          onClick={() => handleSort('size')}
          className="w-24 text-right cursor-pointer hover:text-slate-200"
        >
          <span>SIZE</span>
          {sortField === 'size' && (sortOrder === 'asc' ? ' ↑' : ' ↓')}
        </div>
        <div
          onClick={() => handleSort('type')}
          className="w-24 text-center hidden sm:block cursor-pointer hover:text-slate-200"
        >
          <span>TYPE</span>
          {sortField === 'type' && (sortOrder === 'asc' ? ' ↑' : ' ↓')}
        </div>
        <div
          onClick={() => handleSort('date')}
          className="w-36 text-right hidden md:block cursor-pointer hover:text-slate-200"
        >
          <span>MODIFIED</span>
          {sortField === 'date' && (sortOrder === 'asc' ? ' ↑' : ' ↓')}
        </div>
        <div className="w-28 text-right hidden lg:block text-slate-400">
          <span>SECTOR / CLUS</span>
        </div>
        <div className="w-28 text-right pr-2">
          <span>ACTIONS</span>
        </div>
      </div>

      {/* Table body */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/40">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400 text-xs gap-2">
            <Folder className="w-10 h-10 text-slate-700" />
            <p className="font-medium text-slate-400">This folder is empty</p>
            <p className="text-[11px] text-slate-400">Drag files from your desktop here, or use "+ Add Files"</p>
          </div>
        ) : (
          sorted.map((node) => {
            const isSelected = selectedPaths.has(node.path);
            const ext = getFileExtension(node.name).toUpperCase() || 'FILE';

            return (
              <div
                key={node.path}
                onClick={(e) => onToggleSelect(node.path, e.shiftKey || e.ctrlKey || e.metaKey)}
                onDoubleClick={() => {
                  if (node.isDirectory) {
                    onNavigate(node.path);
                  } else {
                    onPreviewFile(node);
                  }
                }}
                className={`flex items-center px-4 py-2 text-xs transition cursor-pointer group ${
                  isSelected
                    ? 'bg-sky-950/40 text-sky-200 font-medium'
                    : 'text-slate-300 hover:bg-slate-900/60'
                }`}
              >
                {/* Checkbox */}
                <div
                  className="w-8 flex items-center justify-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect(node.path, true)}
                    className="rounded border-slate-700 text-sky-600 focus:ring-sky-500 bg-slate-800 cursor-pointer"
                  />
                </div>

                {/* Name */}
                <div className="flex-1 flex items-center gap-2 min-w-0 pr-2">
                  {getIcon(node)}
                  <span className="truncate hover:underline" title={node.name}>
                    {node.name}
                  </span>
                  {node.data && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      New
                    </span>
                  )}
                </div>

                {/* Size */}
                <div className="w-24 text-right font-mono text-[11px] text-slate-400">
                  {node.isDirectory ? '-' : formatBytes(node.size)}
                </div>

                {/* Type */}
                <div className="w-24 text-center hidden sm:block text-[11px] text-slate-400">
                  {node.isDirectory ? 'Folder' : ext}
                </div>

                {/* Modified Date */}
                <div className="w-36 text-right hidden md:block text-[11px] text-slate-400">
                  {formatDate(node.modifiedTime)}
                </div>

                {/* Sector / Cluster info */}
                <div className="w-28 text-right hidden lg:block font-mono text-[10px] text-slate-400">
                  {node.sourceSector !== undefined
                    ? `LBA ${node.sourceSector}`
                    : node.startCluster !== undefined
                    ? `Clus ${node.startCluster}`
                    : '-'}
                </div>

                {/* Actions */}
                <div
                  className="w-28 flex items-center justify-end gap-1 opacity-80 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!node.isDirectory && (
                    <>
                      <button
                        onClick={() => onPreviewFile(node)}
                        className="p-1 hover:text-sky-400 hover:bg-slate-800 rounded transition"
                        title="Preview & Hex Inspect"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDownloadFile(node)}
                        className="p-1 hover:text-emerald-400 hover:bg-slate-800 rounded transition"
                        title="Download / Extract"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => onRenameFile(node)}
                    className="p-1 hover:text-amber-400 hover:bg-slate-800 rounded transition"
                    title="Rename"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDeleteFile(node)}
                    className="p-1 hover:text-rose-400 hover:bg-slate-800 rounded transition"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer bar */}
      <div className="bg-slate-900/90 border-t border-slate-800 px-4 py-1.5 flex items-center justify-between text-[11px] text-slate-400 shrink-0">
        <div>
          <span>{filtered.length} item(s)</span>
          {selectedPaths.size > 0 && (
            <span className="ml-2 text-sky-400">({selectedPaths.size} selected)</span>
          )}
        </div>
        <div>
          Total Folder Size:{' '}
          <span className="font-mono text-slate-300">
            {formatBytes(
              filtered.reduce((acc, curr) => acc + (curr.isDirectory ? 0 : curr.size), 0)
            )}
          </span>
        </div>
      </div>
    </div>
  );
};
