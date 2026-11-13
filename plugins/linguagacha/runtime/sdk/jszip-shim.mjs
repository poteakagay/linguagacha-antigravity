import { readZipEntries, writeZipBuffer } from "../core/zip.mjs";

class JSZipFileEntry {
  constructor(name, data, dir = false, compression = undefined) {
    this.name = name;
    this._data = Buffer.isBuffer(data)
      ? data
      : typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.from(data ?? []);
    this.dir = dir;
    this.compression = compression;
  }

  async async(type = "uint8array") {
    const t = String(type).toLowerCase();
    if (t === "string" || t === "text") return this._data.toString("utf8");
    if (t === "nodebuffer") return Buffer.from(this._data);
    if (t === "arraybuffer") {
      return this._data.buffer.slice(this._data.byteOffset, this._data.byteOffset + this._data.byteLength);
    }
    return new Uint8Array(this._data);
  }
}

export default class JSZip {
  constructor() {
    this.files = Object.create(null);
  }

  static async loadAsync(data) {
    const zip = new JSZip();
    const entries = readZipEntries(data);
    for (const [name, entry] of entries) {
      zip.files[name] = new JSZipFileEntry(name, entry.data, entry.dir);
    }
    return zip;
  }

  file(name, data, options) {
    const norm = String(name).replace(/\\/gu, "/");
    if (arguments.length === 1) {
      const found = this.files[norm];
      return found && !found.dir ? found : null;
    }
    this.files[norm] = new JSZipFileEntry(norm, data, false, options?.compression);
    return this;
  }

  folder(name) {
    const prefix = String(name).replace(/\\/gu, "/").replace(/\/+$/u, "") + "/";
    if (!this.files[prefix]) {
      this.files[prefix] = new JSZipFileEntry(prefix, Buffer.alloc(0), true);
    }
    return {
      file: (subName, data, opts) => this.file(prefix + subName, data, opts),
    };
  }

  remove(name) {
    const norm = String(name).replace(/\\/gu, "/");
    delete this.files[norm];
    for (const key of Object.keys(this.files)) {
      if (key.startsWith(norm + "/")) delete this.files[key];
    }
    return this;
  }

  async generateAsync(options = {}) {
    const list = Object.values(this.files).map((entry) => ({
      name: entry.name,
      data: entry._data,
      dir: entry.dir,
      compression: entry.compression,
    }));
    const buf = writeZipBuffer(list, { compression: options.compression ?? "STORE" });
    const t = String(options.type ?? "nodebuffer").toLowerCase();
    if (t === "uint8array") return new Uint8Array(buf);
    if (t === "base64") return buf.toString("base64");
    if (t === "arraybuffer") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return buf;
  }
}

export { JSZip };
