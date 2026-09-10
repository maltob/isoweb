import React, { useEffect, useState } from 'react';
import { Breadcrumbs } from './components/Breadcrumbs';
import { DiskInfoModal } from './components/DiskInfoModal';
import { FileTable } from './components/FileTable';
import { Header } from './components/Header';
import { InputModal } from './components/InputModal';
import { NewImageModal } from './components/NewImageModal';
import { OpfsManagerModal } from './components/OpfsManagerModal';
import { PreviewModal } from './components/PreviewModal';
import { ProgressBar } from './components/ProgressBar';
import { Sidebar } from './components/Sidebar';
import { DiskImageLoader } from './lib/loader';
import {
  extractEntriesFromDataTransfer,
  readDirectoryHandle,
  DroppedFileEntry,
} from './lib/drop-handler';
import { OpfsManager } from './lib/storage/opfs';
import { DiskFormat, VNode } from './lib/types';
import { downloadBlob } from './lib/utils';
import { VirtualFS } from './lib/virtual-fs/virtual-fs';

export const App: React.FC = () => {
  // Active Virtual Filesystem
  const [vfs, setVfs] = useState<VirtualFS>(() => {
    // Initial default demo ISO
    const initial = VirtualFS.createNew('iso', 'ISOWEB_DEMO');
    const welcomeDoc = `# Welcome to ISOWeb!
A 100% browser-only, high-performance builder and viewer for VM disk images (.ISO and .IMG).

Features:
- Works completely offline with zero server dependencies
- High-performance slice-based reading for multi-gigabyte files
- Full ISO 9660 + Joliet (Unicode / Long Filenames) support
- Full FAT12 (Floppy), FAT16, and FAT32 (.IMG) support
- Built-in Hex Inspector & Text/Image Previews
- Origin Private File System (OPFS) persistent library
- Drag-and-drop files directly from your desktop
- Instant ZIP archive extraction

Try adding your own files, creating folders, or clicking "Save / Export" to download your disk image!
`;
    initial.addFile('/', 'README.TXT', new TextEncoder().encode(welcomeDoc));
    initial.createDirectory('/', 'BOOT');
    const sampleConfig = `TIMEOUT 5\nDEFAULT linux\n\nLABEL linux\n  KERNEL /BOOT/VMLINUZ\n  APPEND initrd=/BOOT/INITRD.IMG root=/dev/ram0\n`;
    initial.addFile('/BOOT', 'ISOLINUX.CFG', new TextEncoder().encode(sampleConfig));
    initial.createDirectory('/', 'DRIVERS');
    initial.addFile(
      '/DRIVERS',
      'NETCARD.DOS',
      new Uint8Array([0x55, 0xaa, 0x00, 0x12, 0x34, 0x56, 0x78])
    );
    return initial;
  });

  const [currentFileName, setCurrentFileName] = useState('ISOWEB_DEMO.iso');
  const [currentPath, setCurrentPath] = useState('/');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  // Modal states
  const [previewNode, setPreviewNode] = useState<VNode | null>(null);
  const [isNewImageOpen, setIsNewImageOpen] = useState(false);
  const [isDiskInfoOpen, setIsDiskInfoOpen] = useState(false);
  const [isOpfsOpen, setIsOpfsOpen] = useState(false);
  const [inputModalState, setInputModalState] = useState<{
    isOpen: boolean;
    title: string;
    label: string;
    initialVal: string;
    onConfirm: (val: string) => void;
  }>({
    isOpen: false,
    title: '',
    label: '',
    initialVal: '',
    onConfirm: () => {},
  });

  // Progress state
  const [progressState, setProgressState] = useState<{
    visible: boolean;
    ratio: number;
    status: string;
  }>({ visible: false, ratio: 0, status: '' });

  // Update trigger
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick((t) => t + 1);

  const currentDir = vfs.findNode(currentPath) || vfs.getRoot();

  // Navigation
  const handleNavigate = (path: string) => {
    setSelectedPaths(new Set());
    setSearchTerm('');
    setCurrentPath(path);
  };

  // Open file from local computer
  const handleOpenFile = async (file: File) => {
    try {
      setProgressState({ visible: true, ratio: 0.2, status: `Loading ${file.name}...` });
      const loadedVfs = await DiskImageLoader.loadFromFile(file);
      setVfs(loadedVfs);
      setCurrentFileName(file.name);
      setCurrentPath('/');
      setSelectedPaths(new Set());
      setProgressState({ visible: false, ratio: 1, status: 'Done' });
    } catch (e) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      alert(`Failed to open disk image: ${e}`);
    }
  };

  // Open image from OPFS handle
  const handleOpenFromOpfs = async (fileHandle: FileSystemFileHandle) => {
    try {
      setProgressState({ visible: true, ratio: 0.2, status: `Loading ${fileHandle.name} from OPFS...` });
      const loadedVfs = await DiskImageLoader.loadFromOpfs(fileHandle);
      setVfs(loadedVfs);
      setCurrentFileName(fileHandle.name);
      setCurrentPath('/');
      setSelectedPaths(new Set());
      setProgressState({ visible: false, ratio: 1, status: 'Done' });
    } catch (e) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      alert(`Failed to load image from OPFS: ${e}`);
    }
  };

  // Create new image
  const handleCreateNew = (
    format: DiskFormat,
    volumeLabel: string,
    sizePreset?: string,
    hasMbr?: boolean
  ) => {
    const newVfs = VirtualFS.createNew(format, volumeLabel, sizePreset, hasMbr);
    const ext = format === 'iso' ? '.iso' : format.startsWith('vmdk') ? '.vmdk' : '.img';
    setVfs(newVfs);
    setCurrentFileName(`${volumeLabel.toLowerCase()}${ext}`);
    setCurrentPath('/');
    setSelectedPaths(new Set());
  };

  // Download / Save to computer (Streams directly to hard drive with File System Access API)
  const handleSaveImage = async () => {
    const format = vfs.getFormat();
    const ext = format === 'iso' ? '.iso' : format.startsWith('vmdk') ? '.vmdk' : '.img';
    const description = format.startsWith('vmdk')
      ? 'VMware / VirtualBox VMDK Virtual Disk'
      : format === 'iso'
      ? 'ISO 9660 Disc Image'
      : 'Raw VM Disk Image';

    // Check if File System Access API is available for direct disk streaming
    if ('showSaveFilePicker' in window) {
      try {
        const baseName = currentFileName.replace(/\.[^/.]+$/, '');
        const defaultName = currentFileName.endsWith(ext) ? currentFileName : `${baseName}${ext}`;
        // @ts-expect-error showSaveFilePicker is standard in Chromium/Edge
        const fileHandle: FileSystemFileHandle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types: [
            {
              description,
              accept: {
                'application/octet-stream': [ext],
              },
            },
          ],
        });

        setProgressState({ visible: true, ratio: 0, status: 'Streaming image directly to disk...' });
        await vfs.buildToDisk(fileHandle, (ratio, status) => {
          setProgressState({ visible: true, ratio, status });
        });
        setProgressState({ visible: false, ratio: 1, status: 'Saved to disk!' });
        return;
      } catch (err: any) {
        if (err.name === 'AbortError') return; // user cancelled file picker
        console.warn('showSaveFilePicker error, falling back to browser download:', err);
      }
    }

    // Fallback to in-memory/blob download
    try {
      setProgressState({ visible: true, ratio: 0, status: 'Building disk image...' });
      const blob = await vfs.buildImageBlob((ratio, status) => {
        setProgressState({ visible: true, ratio, status });
      });
      downloadBlob(blob, currentFileName);
      setProgressState({ visible: false, ratio: 1, status: 'Completed' });
    } catch (e) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      alert(`Failed to save image: ${e}`);
    }
  };

  // Save to OPFS (Streams directly into OPFS sandbox with Zero RAM used!)
  const handleSaveToOpfs = async () => {
    if (!OpfsManager.isSupported()) {
      alert('OPFS (Origin Private File System) is not supported in this browser.');
      return;
    }
    try {
      setProgressState({ visible: true, ratio: 0, status: 'Streaming image directly into OPFS...' });
      await vfs.buildToOpfs(currentFileName, (ratio, status) => {
        setProgressState({ visible: true, ratio, status });
      });
      setProgressState({ visible: false, ratio: 1, status: 'Saved to OPFS' });
      alert(`Successfully streamed and saved "${currentFileName}" into OPFS storage (Zero RAM used)!`);
    } catch (e) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      alert(`Failed to save to OPFS: ${e}`);
    }
  };

  // Export all as ZIP
  const handleExportZip = async () => {
    try {
      setProgressState({ visible: true, ratio: 0, status: 'Packaging files into ZIP...' });
      const zipBlob = await vfs.exportAsZip((ratio, name) => {
        setProgressState({ visible: true, ratio, status: `Archiving: ${name}` });
      });
      const zipName = currentFileName.replace(/\.[^/.]+$/, '') + '_files.zip';
      downloadBlob(zipBlob, zipName);
      setProgressState({ visible: false, ratio: 1, status: 'Done' });
    } catch (e) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      alert(`Failed to export ZIP: ${e}`);
    }
  };

  // Add a list of dropped or selected file/folder entries (supporting full directory hierarchies and empty folders)
  const handleAddDroppedEntries = async (entries: DroppedFileEntry[]) => {
    if (entries.length === 0) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      return;
    }

    setProgressState({
      visible: true,
      ratio: 0,
      status: `Staging ${entries.length} item(s)...`,
    });

    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const displayName = entry.file
          ? entry.file.name
          : entry.relativePath.split('/').pop() || 'folder';

        setProgressState({
          visible: true,
          ratio: (i + 1) / entries.length,
          status: `Staging (${i + 1}/${entries.length}): ${displayName}`,
        });

        const parts = entry.relativePath.split('/').filter(Boolean);

        if (entry.isDirectory) {
          // Directory entry: ensure every directory in the path is created
          let targetPath = currentPath;
          for (const part of parts) {
            vfs.createDirectory(targetPath, part);
            targetPath = targetPath === '/' ? `/${part}` : `${targetPath}/${part}`;
          }
        } else if (entry.file) {
          // File entry: ensure parent directories are created, then add file
          const fileName = parts.pop() || entry.file.name;
          let targetPath = currentPath;
          for (const part of parts) {
            vfs.createDirectory(targetPath, part);
            targetPath = targetPath === '/' ? `/${part}` : `${targetPath}/${part}`;
          }

          // Zero-RAM addition: attach entry.file as a lazy File pointer instead of reading arrayBuffer into RAM!
          vfs.addFile(targetPath, fileName, undefined, new Date(entry.file.lastModified), entry.file);
        }
      }
    } finally {
      setProgressState({ visible: false, ratio: 1, status: 'Done' });
      forceUpdate();
    }
  };

  // Add files
  const handleAddFiles = async (files: FileList) => {
    const entries: DroppedFileEntry[] = [];
    for (let i = 0; i < files.length; i++) {
      entries.push({ isDirectory: false, file: files[i], relativePath: files[i].name });
    }
    await handleAddDroppedEntries(entries);
  };

  // Add folder with files
  const handleAddFolderFiles = async (files: FileList) => {
    const entries: DroppedFileEntry[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      entries.push({
        isDirectory: false,
        file,
        relativePath: file.webkitRelativePath || file.name,
      });
    }
    await handleAddDroppedEntries(entries);
  };

  // Add directory handle from showDirectoryPicker
  const handleAddDirectoryHandle = async (dirHandle: FileSystemDirectoryHandle) => {
    try {
      setProgressState({ visible: true, ratio: 0.1, status: `Reading folder ${dirHandle.name}...` });
      const entries = await readDirectoryHandle(dirHandle);
      await handleAddDroppedEntries(entries);
    } catch (e) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      alert(`Failed to import folder: ${e}`);
    }
  };

  // Handle DataTransfer drop (folders or files)
  const handleDropDataTransfer = async (dataTransfer: DataTransfer) => {
    if (dataTransfer.files && dataTransfer.files.length === 1) {
      const first = dataTransfer.files[0];
      const lower = first.name.toLowerCase();
      if (
        lower.endsWith('.iso') ||
        lower.endsWith('.img') ||
        lower.endsWith('.ima') ||
        lower.endsWith('.vfd') ||
        lower.endsWith('.vmdk')
      ) {
        if (confirm(`Would you like to open "${first.name}" as a VM disk image?`)) {
          handleOpenFile(first);
          return;
        }
      }
    }

    try {
      setProgressState({ visible: true, ratio: 0.1, status: 'Scanning folder contents...' });
      const entries = await extractEntriesFromDataTransfer(dataTransfer);
      await handleAddDroppedEntries(entries);
    } catch (e) {
      setProgressState({ visible: false, ratio: 0, status: '' });
      alert(`Failed to process dropped items: ${e}`);
    }
  };

  // Create folder prompt
  const handleOpenCreateFolder = () => {
    setInputModalState({
      isOpen: true,
      title: 'Create New Subfolder',
      label: 'Folder Name',
      initialVal: 'NEW_FOLDER',
      onConfirm: (name) => {
        try {
          vfs.createDirectory(currentPath, name);
          forceUpdate();
        } catch (e) {
          alert(String(e));
        }
      },
    });
  };

  // Rename node
  const handleRenameNode = (node: VNode) => {
    setInputModalState({
      isOpen: true,
      title: `Rename ${node.isDirectory ? 'Folder' : 'File'}`,
      label: 'New Name',
      initialVal: node.name,
      onConfirm: (newName) => {
        if (vfs.renameNode(node.path, newName)) {
          forceUpdate();
        } else {
          alert('Failed to rename item.');
        }
      },
    });
  };

  // Delete node
  const handleDeleteNode = (node: VNode) => {
    if (confirm(`Are you sure you want to delete "${node.name}"?`)) {
      vfs.deleteNode(node.path);
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        next.delete(node.path);
        return next;
      });
      forceUpdate();
    }
  };

  // Delete selected
  const handleDeleteSelected = () => {
    if (confirm(`Are you sure you want to delete ${selectedPaths.size} selected item(s)?`)) {
      for (const path of selectedPaths) {
        vfs.deleteNode(path);
      }
      setSelectedPaths(new Set());
      forceUpdate();
    }
  };

  // Download single file
  const handleDownloadSingleFile = async (node: VNode) => {
    try {
      const bytes = await vfs.getFileBytes(node);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      downloadBlob(blob, node.name);
    } catch (e) {
      alert(`Failed to extract file: ${e}`);
    }
  };

  // Selection handlers
  const handleToggleSelect = (path: string, isMulti: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(isMulti ? prev : []);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleSelectAll = (select: boolean) => {
    if (!select) {
      setSelectedPaths(new Set());
    } else {
      const paths = new Set<string>();
      for (const child of currentDir.children || []) {
        paths.add(child.path);
      }
      setSelectedPaths(paths);
    }
  };

  // Global drag-and-drop support on window
  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const handleWindowDrop = async (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        await handleDropDataTransfer(e.dataTransfer);
      }
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [currentPath, vfs]);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Header & Action Controls */}
      <Header
        imageInfo={vfs.getImageInfo()}
        fileName={currentFileName}
        rootSize={vfs.getRoot().size}
        onNewImage={() => setIsNewImageOpen(true)}
        onOpenFile={handleOpenFile}
        onSaveImage={handleSaveImage}
        onSaveToOpfs={handleSaveToOpfs}
        onExportZip={handleExportZip}
        onOpenOpfsManager={() => setIsOpfsOpen(true)}
        onOpenDiskInfo={() => setIsDiskInfoOpen(true)}
        isSaving={progressState.visible}
      />

      {/* Path Breadcrumbs & Folder Action Bar */}
      <Breadcrumbs
        currentPath={currentPath}
        onNavigate={handleNavigate}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        onAddFiles={handleAddFiles}
        onAddFolderFiles={handleAddFolderFiles}
        onAddDirectoryHandle={handleAddDirectoryHandle}
        onCreateFolder={handleOpenCreateFolder}
        selectedCount={selectedPaths.size}
        onDeleteSelected={handleDeleteSelected}
      />

      {/* Main Content Area: Sidebar + File Explorer Table */}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          root={vfs.getRoot()}
          currentPath={currentPath}
          onNavigate={handleNavigate}
          imageInfo={vfs.getImageInfo()}
        />

        <FileTable
          currentDir={currentDir}
          searchTerm={searchTerm}
          onNavigate={handleNavigate}
          onPreviewFile={(node) => setPreviewNode(node)}
          onDownloadFile={handleDownloadSingleFile}
          onRenameFile={handleRenameNode}
          onDeleteFile={handleDeleteNode}
          onDropDataTransfer={handleDropDataTransfer}
          selectedPaths={selectedPaths}
          onToggleSelect={handleToggleSelect}
          onSelectAll={handleSelectAll}
        />
      </div>

      {/* Preview & Hex Inspector Modal */}
      {previewNode && (
        <PreviewModal
          node={previewNode}
          getFileBytes={(n) => vfs.getFileBytes(n)}
          onClose={() => setPreviewNode(null)}
          onDownload={handleDownloadSingleFile}
        />
      )}

      {/* New Image Modal */}
      {isNewImageOpen && (
        <NewImageModal
          onClose={() => setIsNewImageOpen(false)}
          onCreate={handleCreateNew}
        />
      )}

      {/* Disk Info Modal */}
      {isDiskInfoOpen && (
        <DiskInfoModal
          imageInfo={vfs.getImageInfo()}
          root={vfs.getRoot()}
          fileName={currentFileName}
          onClose={() => setIsDiskInfoOpen(false)}
        />
      )}

      {/* OPFS Storage Manager Modal */}
      {isOpfsOpen && (
        <OpfsManagerModal
          onClose={() => setIsOpfsOpen(false)}
          onLoadImage={handleOpenFromOpfs}
        />
      )}

      {/* Text / Folder Prompt Input Modal */}
      {inputModalState.isOpen && (
        <InputModal
          title={inputModalState.title}
          label={inputModalState.label}
          initialValue={inputModalState.initialVal}
          onConfirm={inputModalState.onConfirm}
          onClose={() =>
            setInputModalState((prev) => ({ ...prev, isOpen: false }))
          }
        />
      )}

      {/* Progress Bar Toast */}
      {progressState.visible && (
        <ProgressBar
          ratio={progressState.ratio}
          status={progressState.status}
        />
      )}
    </div>
  );
};

export default App;
