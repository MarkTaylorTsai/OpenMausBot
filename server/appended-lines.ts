// Reading a file that only grows by whole lines (a usage ledger) without reading what was already read.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHECKED_BYTES = 64;

function readBytes(fd: number, from: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const count = readSync(fd, bytes, got, length - got, from + got);
    if (count === 0) break;
    got += count;
  }
  return bytes.subarray(0, got);
}

export class AppendedLines {
  private readonly path: string;
  private ino: number | null = null;
  private offset = 0;
  private lastBytes: Buffer = Buffer.alloc(0);
  private terminated = true;

  constructor(path: string) {
    this.path = path;
  }

  /** The text added since the last read. `restart` says the text is the whole file instead: the first read, a file that
   * shrank, was replaced or no longer ends as it did, or one whose last read ended in the middle of a line. Throws what
   * opening or reading the file throws, and then remembers nothing new. */
  read(): { restart: boolean; text: string } {
    const fd = openSync(this.path, "r");
    try {
      const stat = fstatSync(fd);
      if (this.ino === stat.ino && this.terminated && stat.size >= this.offset) {
        const kept = this.lastBytes.length;
        const from = this.offset - kept;
        const bytes = readBytes(fd, from, stat.size - from);
        if (bytes.length >= kept && bytes.subarray(0, kept).equals(this.lastBytes)) {
          this.remember(stat.ino, from, bytes);
          return { restart: false, text: bytes.toString("utf8", kept) };
        }
      }
      const bytes = readBytes(fd, 0, stat.size);
      this.remember(stat.ino, 0, bytes);
      return { restart: true, text: bytes.toString("utf8") };
    } finally {
      closeSync(fd);
    }
  }

  private remember(ino: number, from: number, bytes: Buffer): void {
    this.ino = ino;
    this.offset = from + bytes.length;
    this.lastBytes = Buffer.from(bytes.subarray(Math.max(0, bytes.length - CHECKED_BYTES)));
    this.terminated = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
  }
}
