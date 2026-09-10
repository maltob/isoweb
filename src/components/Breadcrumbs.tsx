import React, { useEffect, useRef } from 'react';
import {
  ArrowUp,
  FolderPlus,
  Home,
  Search,
  Trash2,
  Upload,
  FolderUp,
} from 'lucide-react';

interface BreadcrumbsProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onAddFiles: (files: FileList) => void;
  onAddFolderFiles: (files: FileList) => void;
  onAddDirectoryHandle?: (handle: FileSystemDirectoryHandle) => void;
  onCreateFolder: () => void;
  selectedCount: number;
  onDeleteSelected?: () => void;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({
  currentPath,
  onNavigate,
  searchTerm,
  onSearchChange,
  onAddFiles,
  onAddFolderFiles,
  onAddDirectoryHandle,
  onCreateFolder,
  selectedCount,
  onDeleteSelected,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  const segments = currentPath.split('/').filter(Boolean);

  const handleUpLevel = () => {
    if (currentPath === '/' || currentPath === '') return;
    const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
    onNavigate(parent);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddFolderFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleFolderClick = async () => {
    if ('showDirectoryPicker' in window && onAddDirectoryHandle) {
      try {
        // @ts-expect-error showDirectoryPicker is standard in modern browsers
        const dirHandle = await window.showDirectoryPicker();
        if (dirHandle) {
          onAddDirectoryHandle(dirHandle);
          return;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return;
      }
    }
    folderInputRef.current?.click();
  };

  return (
    <div className="bg-slate-900/90 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
      {/* Hidden file inputs */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        multiple
        className="hidden"
      />
      <input
        type="file"
        ref={folderInputRef}
        onChange={handleFolderInputChange}
        // @ts-expect-error webkitdirectory is standard for folder picking
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
      />

      {/* Path Breadcrumbs */}
      <div className="flex items-center gap-1.5 overflow-x-auto py-1 max-w-full">
        <button
          onClick={handleUpLevel}
          disabled={currentPath === '/' || currentPath === ''}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent transition cursor-pointer"
          title="Go Up One Level"
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => onNavigate('/')}
          className={`flex items-center gap-1 px-2 py-1 rounded transition cursor-pointer ${
            currentPath === '/'
              ? 'bg-slate-800 text-sky-400 font-semibold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <Home className="w-3.5 h-3.5" />
          <span>Root</span>
        </button>

        {segments.map((segment, idx) => {
          const subPath = '/' + segments.slice(0, idx + 1).join('/');
          const isCurrent = idx === segments.length - 1;

          return (
            <React.Fragment key={subPath}>
              <span className="text-slate-600">/</span>
              <button
                onClick={() => onNavigate(subPath)}
                className={`px-2 py-1 rounded transition cursor-pointer ${
                  isCurrent
                    ? 'bg-slate-800 text-sky-400 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {segment}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* Search & Folder Actions */}
      <div className="flex items-center gap-2">
        {/* Quick Filter */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Filter files..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-36 md:w-48 pl-8 pr-2.5 py-1 bg-slate-950 border border-slate-700/80 rounded-md text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
          />
        </div>

        {/* Add Files */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition cursor-pointer"
          title="Import files into current folder"
        >
          <Upload className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden sm:inline">Add Files</span>
        </button>

        {/* Add Folder */}
        <button
          onClick={handleFolderClick}
          className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition cursor-pointer"
          title="Import local directory into current folder"
        >
          <FolderUp className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden sm:inline">Add Folder</span>
        </button>

        {/* New Folder */}
        <button
          onClick={onCreateFolder}
          className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition cursor-pointer"
          title="Create an empty subfolder"
        >
          <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
          <span className="hidden sm:inline">New Folder</span>
        </button>

        {/* Delete Selected (if any selected) */}
        {selectedCount > 0 && onDeleteSelected && (
          <button
            onClick={onDeleteSelected}
            className="flex items-center gap-1 px-2.5 py-1 bg-rose-900/40 hover:bg-rose-800/60 text-rose-300 rounded border border-rose-700/50 transition cursor-pointer"
            title={`Delete ${selectedCount} selected item(s)`}
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            <span>Delete ({selectedCount})</span>
          </button>
        )}
      </div>
    </div>
  );
};
