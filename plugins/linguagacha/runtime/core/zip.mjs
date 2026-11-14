import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export function readZipEntries(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP archive: End of Central Directory not found.");
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  let offset = cdOffset;
  for (let idx = 0; idx < totalEntries && offset + 46 <= buf.length; idx += 1) {
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error("Invalid ZIP archive: Central Directory header signature mismatch.");
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const rawName = buf.subarray(offset + 46, offset + 46 + nameLen);
    const isUtf8 = (flags & 0x0800) !== 0;
    const rawPath = (isUtf8 ? rawName.toString("utf8") : rawName.toString("utf8")).replace(/\\/gu, "/");
    const isDir = rawPath.endsWith("/");

    if (buf.readUInt32LE(localHeaderOffset) !== SIG_LOCAL) {
      throw new Error(`Invalid ZIP local header for ${rawPath}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedSlice = buf.subarray(dataStart, dataStart + compressedSize);

    let data = Buffer.alloc(0);
    if (!isDir && compressedSize > 0) {
      if (method === 0) {
        data = Buffer.from(compressedSlice);
      } else if (method === 8) {
        data = zlib.inflateRawSync(compressedSlice);
      } else {
        throw new Error(`Unsupported ZIP compression method ${method} for ${rawPath}`);
      }
    } else if (!isDir && uncompressedSize === 0) {
      data = Buffer.alloc(0);
    }

    entries.set(rawPath, {
      name: rawPath,
      dir: isDir,
      method,
      data,
    });

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * 构建标准 ZIP Buffer。若包含 `mimetype` 条目，强制放在首个条目并以 STORE（无压缩、无 extra 字段）写入，符合 EPUB OCF 规范。
 */
export function writeZipBuffer(entriesInput, options = {}) {
  const defaultCompression = (options.compression ?? "STORE").toUpperCase();
  const ordered = [];

  const list = entriesInput instanceof Map
    ? [...entriesInput.entries()].map(([name, val]) =>
        val && typeof val === "object" && !(val instanceof Uint8Array) && !Buffer.isBuffer(val) && "data" in val
          ? { name, data: val.data, compression: val.compression, dir: Boolean(val.dir) }
          : { name, data: val, compression: undefined, dir: false },
      )
    : Array.isArray(entriesInput)
      ? entriesInput
      : Object.entries(entriesInput).map(([name, data]) => ({ name, data }));

  const mimetypeIdx = list.findIndex((e) => (e.name ?? e.path) === "mimetype");
  if (mimetypeIdx >= 0) {
    ordered.push({ ...list[mimetypeIdx], name: "mimetype", compression: "STORE", dir: false });
  }
  for (let i = 0; i < list.length; i += 1) {
    if (i === mimetypeIdx) continue;
    ordered.push(list[i]);
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const item of ordered) {
    const normName = String(item.name ?? item.path).replace(/\\/gu, "/");
    if (item.dir || normName.endsWith("/")) continue;

    const nameBytes = Buffer.from(normName, "utf8");
    const rawData =
      typeof item.data === "string"
        ? Buffer.from(item.data, "utf8")
        : Buffer.isBuffer(item.data)
          ? item.data
          : Buffer.from(item.data ?? []);

    const crc = zlib.crc32(rawData) >>> 0;
    const compMode = normName === "mimetype" ? "STORE" : (item.compression ?? defaultCompression).toUpperCase();
    let method = 0;
    let payload = rawData;
    if (compMode === "DEFLATE" && rawData.length > 0) {
      const deflated = zlib.deflateRawSync(rawData);
      if (deflated.length < rawData.length) {
        method = 8;
        payload = deflated;
      }
    }

    const isAscii = normName.split("").every((c) => c.charCodeAt(0) < 0x80);
    const flags = isAscii ? 0 : 0x0800; // UTF-8 flag only when non-ASCII so mimetype stays ultra-minimal

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(SIG_LOCAL, 0);
    localHeader.writeUInt16LE(20, 4); // version needed 2.0
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x0021, 12); // mod date (1980-01-01)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length MUST be 0 for EPUB mimetype

    localParts.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(SIG_CENTRAL, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const entryCount = centralParts.length / 2;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

/** 安全展开 ZIP 到指定目录（阻止路径穿越），供 sources/<file_path>/ 容器展开使用 */
export function extractZipToDirectory(zipBytes, targetDir) {
  const entries = readZipEntries(zipBytes);
  const resolvedRoot = path.resolve(targetDir);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  for (const [entryName, entry] of entries) {
    const cleanRel = entryName.replace(/^\/+/u, "");
    if (!cleanRel) continue;
    const dest = path.resolve(resolvedRoot, ...cleanRel.split("/"));
    if (!dest.startsWith(resolvedRoot + path.sep) && dest !== resolvedRoot) {
      throw new Error(`Unsafe ZIP entry path rejected: ${entryName}`);
    }
    if (entry.dir) {
      fs.mkdirSync(dest, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
    }
  }
  return entries;
}
