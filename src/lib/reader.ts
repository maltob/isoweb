// Zero-copy, high-performance random access reader
// Enables reading multi-gigabyte ISO and IMG files with instant lazy sector access

export interface RandomAccessReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  readSync?(offset: number, length: number): Uint8Array;
  close?(): Promise<void> | void;
}

export class BlobReader implements RandomAccessReader {
  private blob: Blob;
  readonly size: number;

  constructor(blob: Blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset >= this.size) {
      return new Uint8Array(0);
    }
    const end = Math.min(offset + length, this.size);
    const slice = this.blob.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

export class BufferReader implements RandomAccessReader {
  private buffer: Uint8Array;
  readonly size: number;

  constructor(buffer: Uint8Array | ArrayBuffer) {
    if (buffer instanceof ArrayBuffer) {
      this.buffer = new Uint8Array(buffer);
    } else {
      this.buffer = buffer;
    }
    this.size = this.buffer.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.readSync(offset, length);
  }

  readSync(offset: number, length: number): Uint8Array {
    if (offset < 0 || offset >= this.size) {
      return new Uint8Array(0);
    }
    const end = Math.min(offset + length, this.size);
    return this.buffer.subarray(offset, end);
  }
}

export class OpfsReader implements RandomAccessReader {
  private fileHandle: FileSystemFileHandle;
  private file: File | null = null;
  size: number = 0;

  private constructor(fileHandle: FileSystemFileHandle, size: number) {
    this.fileHandle = fileHandle;
    this.size = size;
  }

  static async create(fileHandle: FileSystemFileHandle): Promise<OpfsReader> {
    const file = await fileHandle.getFile();
    const reader = new OpfsReader(fileHandle, file.size);
    reader.file = file;
    return reader;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!this.file) {
      this.file = await this.fileHandle.getFile();
      this.size = this.file.size;
    }
    if (offset < 0 || offset >= this.size) {
      return new Uint8Array(0);
    }
    const end = Math.min(offset + length, this.size);
    const slice = this.file.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
