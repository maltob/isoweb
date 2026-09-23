// Central Registry for Modular File System Drivers
import { RandomAccessReader } from '../reader';
import { FileSystemDriver, SupportedPartitionFs } from './fs-types';
import { Fat32Driver } from './drivers/fat-driver';
import { ExFatDriver } from './drivers/exfat-driver';
import { NtfsDriver } from './drivers/ntfs-driver';
import { XfsDriver } from './drivers/xfs-driver';

export class FileSystemRegistry {
  private static drivers: Map<string, FileSystemDriver> = new Map();
  private static initialized = false;

  static initialize(): void {
    if (this.initialized) return;
    this.register(new Fat32Driver());
    this.register(new ExFatDriver());
    this.register(new NtfsDriver());
    this.register(new XfsDriver());
    this.initialized = true;
  }

  static register(driver: FileSystemDriver): void {
    this.drivers.set(driver.id, driver);
  }

  static getDriver(type: SupportedPartitionFs | string): FileSystemDriver {
    this.initialize();
    const driver = this.drivers.get(type);
    if (!driver) {
      throw new Error(`Unsupported filesystem type: "${type}". Supported types: ${Array.from(this.drivers.keys()).join(', ')}`);
    }
    return driver;
  }

  static hasDriver(type: string): boolean {
    this.initialize();
    return this.drivers.has(type);
  }

  static listDrivers(): FileSystemDriver[] {
    this.initialize();
    return Array.from(this.drivers.values());
  }

  static async detectDriver(
    reader: RandomAccessReader,
    sectorOffset: number = 0
  ): Promise<FileSystemDriver | null> {
    this.initialize();
    for (const driver of this.drivers.values()) {
      if (await driver.detect(reader, sectorOffset)) {
        return driver;
      }
    }
    return null;
  }
}
