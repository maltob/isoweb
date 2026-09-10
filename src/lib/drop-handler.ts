// Helper to recursively extract all files and subdirectories from drag-and-drop or folder pickers

export interface DroppedFileEntry {
  file: File;
  relativePath: string; // e.g. "MyFolder/Sub/document.txt"
}

/**
 * Recursively extracts all files from a drag-and-drop DataTransfer object.
 * Uses webkitGetAsEntry() to properly walk folders and subfolders.
 */
export async function extractEntriesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<DroppedFileEntry[]> {
  const items = dataTransfer.items;
  const results: DroppedFileEntry[] = [];

  if (items && items.length > 0) {
    const queue: Promise<void>[] = [];

    const readEntry = async (entry: any, basePath: string) => {
      if (!entry) return;

      if (entry.isFile) {
        try {
          const file: File = await new Promise((resolve, reject) => {
            entry.file(resolve, reject);
          });
          const relPath = basePath ? `${basePath}/${file.name}` : file.name;
          results.push({ file, relativePath: relPath });
        } catch (err) {
          console.warn('Could not read file entry:', entry.name, err);
        }
      } else if (entry.isDirectory) {
        const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
        const dirReader = entry.createReader();

        // WebKit requires calling readEntries() repeatedly until an empty array is returned
        const readAllEntries = async (): Promise<any[]> => {
          let all: any[] = [];
          while (true) {
            const batch: any[] = await new Promise((resolve, reject) => {
              dirReader.readEntries(resolve, reject);
            });
            if (!batch || batch.length === 0) break;
            all = all.concat(batch);
          }
          return all;
        };

        try {
          const entries = await readAllEntries();
          for (const child of entries) {
            await readEntry(child, dirPath);
          }
        } catch (err) {
          console.warn('Could not read directory entries:', entry.name, err);
        }
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
          queue.push(readEntry(entry, ''));
        } else {
          const file = item.getAsFile();
          if (file) {
            results.push({ file, relativePath: file.name });
          }
        }
      }
    }

    await Promise.all(queue);
    if (results.length > 0) {
      return results;
    }
  }

  // Fallback to standard files list
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];
      results.push({
        file,
        relativePath: file.webkitRelativePath || file.name,
      });
    }
  }

  return results;
}

/**
 * Recursively extracts all files from a directory handle (File System Access API)
 */
export async function readDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string = ''
): Promise<DroppedFileEntry[]> {
  const results: DroppedFileEntry[] = [];
  const currentPath = basePath ? `${basePath}/${dirHandle.name}` : dirHandle.name;

  // @ts-expect-error entries() is standard on FileSystemDirectoryHandle
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile();
      results.push({
        file,
        relativePath: `${currentPath}/${name}`,
      });
    } else if (handle.kind === 'directory') {
      const subResults = await readDirectoryHandle(
        handle as FileSystemDirectoryHandle,
        currentPath
      );
      results.push(...subResults);
    }
  }

  return results;
}
