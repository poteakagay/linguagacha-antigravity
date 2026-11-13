import { detectEncoding } from "../core/language.mjs";

export function detect(buffer) {
  return detectEncoding(buffer);
}

export function encodingExists(encoding) {
  try {
    new TextDecoder(String(encoding).trim());
    return true;
  } catch {
    return false;
  }
}

export function decode(buffer, encoding = "utf-8") {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return new TextDecoder(String(encoding).trim(), { fatal: false }).decode(u8);
}

export function encode(str, encoding = "utf-8") {
  const norm = String(encoding).trim().toLowerCase();
  if (norm === "utf-8" || norm === "utf8") {
    return Buffer.from(String(str), "utf8");
  }
  if (norm === "utf-16le" || norm === "utf16le") {
    return Buffer.from(String(str), "utf16le");
  }
  return Buffer.from(String(str), "utf8");
}

export default {
  detect,
  encodingExists,
  decode,
  encode,
};
