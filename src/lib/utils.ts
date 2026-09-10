// Formatting and UI helper utilities

export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(dm))} ${sizes[idx]}`;
}

export function formatDate(date: Date | string | number): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

export type FileCategory =
  | 'folder'
  | 'image'
  | 'text'
  | 'executable'
  | 'archive'
  | 'disk'
  | 'code'
  | 'audio'
  | 'unknown';

export function getFileCategory(name: string, isDirectory: boolean): FileCategory {
  if (isDirectory) return 'folder';
  const ext = getFileExtension(name);

  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) {
    return 'image';
  }
  if (['txt', 'log', 'nfo', 'diz', 'md', 'cfg', 'ini', 'inf', 'sys', 'bat', 'cmd'].includes(ext)) {
    return 'text';
  }
  if (['c', 'cpp', 'h', 'hpp', 'asm', 's', 'py', 'js', 'ts', 'json', 'xml', 'html'].includes(ext)) {
    return 'code';
  }
  if (['exe', 'com', 'bin', 'elf', 'efi', 'rom', 'dll', 'so', 'o'].includes(ext)) {
    return 'executable';
  }
  if (['zip', 'gz', 'tar', 'tgz', '7z', 'rar', 'cab', 'iso', 'img', 'ima'].includes(ext)) {
    return 'archive';
  }
  if (['iso', 'img', 'vdi', 'qcow2', 'vmdk', 'vhd', 'vhdx'].includes(ext)) {
    return 'disk';
  }
  if (['mp3', 'wav', 'ogg', 'mid', 'midi'].includes(ext)) {
    return 'audio';
  }

  return 'unknown';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
