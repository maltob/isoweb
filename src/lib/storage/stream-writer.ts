// Zero-RAM streaming writer abstractions for OPFS and Direct-to-Disk operations

export interface ImageStreamWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class FileSystemAccessStreamWriter implements ImageStreamWriter {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  bytesWritten = 0;

  constructor(writableStream: WritableStream<Uint8Array>) {
    this.writer = writableStream.getWriter();
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writer.write(chunk);
    this.bytesWritten += chunk.byteLength;
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}

export class BlobAccumulatorWriter implements ImageStreamWriter {
  private chunks: Uint8Array[] = [];
  private mimeType: string;

  constructor(mimeType: string = 'application/octet-stream') {
    this.mimeType = mimeType;
  }

  async write(chunk: Uint8Array): Promise<void> {
    // Retain chunk
    this.chunks.push(chunk);
  }

  async close(): Promise<void> {
    // No-op
  }

  getBlob(): Blob {
    return new Blob(this.chunks, { type: this.mimeType });
  }
}
