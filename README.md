# ISOWeb - Browser-Only VM Disk Image Studio (.ISO & .IMG)

A 100% client-side, offline, high-performance VM disk image builder, viewer, and editor for `.ISO` (ISO 9660 + Joliet) and `.IMG` (FAT12, FAT16, FAT32) formats.

## Key Features

- **100% Offline & Browser-Only**: Zero server dependencies, zero telemetry, full client-side privacy.
- **High-Performance Slice-Based Reading**: Opens multi-gigabyte ISO and IMG images instantaneously by lazily streaming sector blocks on demand using `Blob.slice()` and OPFS access handles.
- **ISO 9660 + Joliet Support**:
  - Full Primary Volume Descriptor (PVD) and Supplementary Volume Descriptor (SVD) generation and parsing.
  - UCS-2 Big Endian Unicode support for long filenames and mixed case.
  - El Torito boot descriptor detection.
  - Path Table and hierarchical directory record generator with 2048-byte sector alignment.
- **FAT12 / FAT16 / FAT32 (.IMG) Support**:
  - 1.44MB, 2.88MB, and 720KB standard Floppy disk images.
  - Custom size FAT16 (up to 2GB) and FAT32 raw disk / USB images.
  - MBR partition table detection vs raw volume boot records.
  - VFAT Long File Names (LFN) encoding and decoding with 8.3 short name fallbacks.
  - Dual FAT tables (FAT1 & mirror FAT2) and cluster chain allocation.
- **Origin Private File System (OPFS)**:
  - Persistent browser disk library: save your VM images directly in your browser's sandboxed storage.
  - Storage quota indicator and management.
- **Desktop-Grade File Explorer UI**:
  - Drag-and-drop files directly from your desktop into the active folder.
  - Tree view directory sidebar with breadcrumb navigation.
  - Multi-select, sorting (name, size, type, modified date), inline rename and deletion.
  - Hex & Sector Inspector (16 bytes/row, ASCII column, offset address, sector pagination).
  - Quick text and image preview.
  - One-click ZIP extraction of all image contents.

## Getting Started

### Development Server
```bash
npm run dev
```
Open `http://localhost:3000` in your browser.

### Run Tests
```bash
npm test
```

### Production Build
```bash
npm run build
```
The optimized static build will be placed in the `dist/` directory.

### Preview Production Build
```bash
npm run preview
```
