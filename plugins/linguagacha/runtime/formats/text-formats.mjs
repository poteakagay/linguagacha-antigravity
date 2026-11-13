import fs from "node:fs";
import path from "node:path";
import { decodeTextContent, hasLanguageBodyCharacter } from "../core/language.mjs";
import { readZipEntries } from "../core/zip.mjs";
import { splitTextLines } from "../core/text-rules.mjs";

export const GENERIC_ITEMS_MEMBER = "items.json";

export function createBaseItem(payload) {
  return {
    src: String(payload.src ?? ""),
    dst: String(payload.dst ?? ""),
    name_src: typeof payload.name_src === "string" ? payload.name_src : null,
    name_dst: typeof payload.name_dst === "string" ? payload.name_dst : null,
    extra_field: payload.extra_field ?? "",
    tag: String(payload.tag ?? ""),
    row: Number(payload.row ?? 0),
    file_type: String(payload.file_type ?? "NONE"),
    file_path: String(payload.file_path ?? ""),
    status: String(payload.status ?? "NONE"),
    skip_internal_filter: Boolean(payload.skip_internal_filter),
  };
}

export function readTranslationForGeneration(item) {
  return item.status === "PROCESSED" ? String(item.dst ?? "") : undefined;
}

function writeUtf8File(targetPath, text) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, text, "utf8");
}

/** 1. TXTFormat */
export function parseTxtBytes(content, relPath) {
  const text = decodeTextContent(content);
  return splitTextLines(text).map((line, index) =>
    createBaseItem({
      src: line,
      dst: "",
      row: index,
      file_type: "TXT",
      file_path: relPath,
    }),
  );
}

export function writeTxtItems(items, { translated_path, bilingual_path, rel_path, write_bilingual = false }) {
  const sorted = [...items].sort((a, b) => a.row - b.row);
  writeUtf8File(
    path.join(translated_path, rel_path),
    sorted.map((item) => readTranslationForGeneration(item) ?? item.src).join("\n"),
  );
  if (write_bilingual && bilingual_path) {
    const bilingual = sorted
      .map((item) => {
        const dst = readTranslationForGeneration(item) ?? item.src;
        return item.src === dst || dst === "" ? item.src : `${item.src}\n${dst}`;
      })
      .join("\n");
    writeUtf8File(path.join(bilingual_path, rel_path), bilingual);
  }
}

/** 2. Markdown MD_V2 Format (block-level non-overlapping ranges with exact before/after layout preservation) */
export function parseMarkdownDocument(rawText) {
  const text = String(rawText ?? "");
  if (text === "") {
    return [{ start_line: 0, before: "", after: "", src: "", rule_skipped: true }];
  }

  // Split text into lines with exact byte/char start & end offsets
  const lineEntries = [];
  const lineRe = /[^\r\n]*(?:\r\n|\r|\n|$)/gu;
  let lineNo = 0;
  let pos = 0;
  while (pos < text.length) {
    lineRe.lastIndex = pos;
    const m = lineRe.exec(text);
    const full = m?.[0] ?? "";
    if (full === "") break;
    const content = full.replace(/(?:\r\n|\r|\n)$/u, "");
    lineEntries.push({
      line: lineNo,
      start: pos,
      contentEnd: pos + content.length,
      end: pos + full.length,
      content,
    });
    pos += full.length;
    lineNo += 1;
  }

  const rawBlocks = [];
  let i = 0;

  // Frontmatter YAML / TOML at start of document
  if (lineEntries.length > 0 && (/^---\s*$/u.test(lineEntries[0].content) || /^\+\+\+\s*$/u.test(lineEntries[0].content))) {
    const marker = lineEntries[0].content.trim();
    let endIdx = -1;
    for (let j = 1; j < lineEntries.length; j += 1) {
      if (lineEntries[j].content.trim() === marker) {
        endIdx = j;
        break;
      }
    }
    if (endIdx > 0) {
      rawBlocks.push({
        start_line: 0,
        start_offset: lineEntries[0].start,
        end_offset: lineEntries[endIdx].contentEnd,
        rule_skipped: true,
      });
      i = endIdx + 1;
    }
  }

  while (i < lineEntries.length) {
    const entry = lineEntries[i];
    const trimmed = entry.content.trim();
    if (trimmed === "") {
      i += 1;
      continue;
    }

    // Fenced code block ``` or ~~~
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/u.exec(entry.content);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`, "u");
      let endIdx = lineEntries.length - 1;
      for (let j = i + 1; j < lineEntries.length; j += 1) {
        if (closeRe.test(lineEntries[j].content)) {
          endIdx = j;
          break;
        }
      }
      rawBlocks.push({
        start_line: entry.line,
        start_offset: entry.start,
        end_offset: lineEntries[endIdx].contentEnd,
        rule_skipped: true,
      });
      i = endIdx + 1;
      continue;
    }

    // Thematic break --- / *** / ___
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/u.test(entry.content)) {
      rawBlocks.push({
        start_line: entry.line,
        start_offset: entry.start,
        end_offset: entry.contentEnd,
        rule_skipped: true,
      });
      i += 1;
      continue;
    }

    // ATX Heading # ...
    if (/^\s*#{1,6}(?:\s+|$)/u.test(entry.content)) {
      const headingText = entry.content.replace(/^\s*#{1,6}\s*/u, "");
      rawBlocks.push({
        start_line: entry.line,
        start_offset: entry.start,
        end_offset: entry.contentEnd,
        rule_skipped: !hasLanguageBodyCharacter(headingText),
      });
      i += 1;
      continue;
    }

    // Reference link definition [id]: url
    if (/^\s*\[[^\]]+\]:\s+\S+/u.test(entry.content)) {
      rawBlocks.push({
        start_line: entry.line,
        start_offset: entry.start,
        end_offset: entry.contentEnd,
        rule_skipped: true,
      });
      i += 1;
      continue;
    }

    // Pure HTML comment or standalone HTML tag block
    if (/^\s*<!--[\s\S]*-->\s*$/u.test(entry.content)) {
      rawBlocks.push({
        start_line: entry.line,
        start_offset: entry.start,
        end_offset: entry.contentEnd,
        rule_skipped: true,
      });
      i += 1;
      continue;
    }

    // List item or blockquote line(s) or paragraph block (collect contiguous paragraph lines)
    const isListItem = /^\s*(?:[-*+]|\d+[.)])\s+/u.test(entry.content);
    const isQuote = /^\s*>/u.test(entry.content);
    let endIdx = i;
    if (!isListItem && !isQuote) {
      while (endIdx + 1 < lineEntries.length) {
        const nextLine = lineEntries[endIdx + 1].content;
        if (
          nextLine.trim() === "" ||
          /^\s*(?:`{3,}|~{3,}|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/u.test(nextLine) ||
          /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/u.test(nextLine)
        ) {
          break;
        }
        endIdx += 1;
      }
    }

    const slice = text.slice(entry.start, lineEntries[endIdx].contentEnd);
    rawBlocks.push({
      start_line: entry.line,
      start_offset: entry.start,
      end_offset: lineEntries[endIdx].contentEnd,
      rule_skipped: !hasLanguageBodyCharacter(slice),
    });
    i = endIdx + 1;
  }

  if (rawBlocks.length === 0) {
    return [{ start_line: 0, before: text, after: "", src: "", rule_skipped: true }];
  }

  const units = [];
  let cursor = 0;
  for (const b of rawBlocks) {
    units.push({
      start_line: b.start_line,
      before: text.slice(cursor, b.start_offset),
      after: "",
      src: text.slice(b.start_offset, b.end_offset),
      rule_skipped: b.rule_skipped,
    });
    cursor = b.end_offset;
  }
  units[units.length - 1].after = text.slice(cursor);
  return units;
}

export function parseMdBytes(content, relPath) {
  const text = decodeTextContent(content);
  return parseMarkdownDocument(text).map((unit) =>
    createBaseItem({
      src: unit.src,
      dst: "",
      row: unit.start_line,
      file_type: "MD_V2",
      file_path: relPath,
      status: unit.rule_skipped ? "RULE_SKIPPED" : "NONE",
      extra_field: {
        markdown: {
          before: unit.before,
          after: unit.after,
        },
      },
    }),
  );
}

export function writeMdItems(items, { translated_path, bilingual_path, rel_path, write_bilingual = false }) {
  const sorted = [...items].sort((a, b) => a.row - b.row || (a.id ?? 0) - (b.id ?? 0));
  const mono = sorted
    .map((item) => {
      const md = item.extra_field?.markdown ?? {};
      const before = typeof md.before === "string" ? md.before : "";
      const after = typeof md.after === "string" ? md.after : "";
      return before + (readTranslationForGeneration(item) ?? item.src) + after;
    })
    .join("");
  writeUtf8File(path.join(translated_path, rel_path), mono);

  if (write_bilingual && bilingual_path) {
    const bi = sorted
      .map((item) => {
        const md = item.extra_field?.markdown ?? {};
        const before = typeof md.before === "string" ? md.before : "";
        const after = typeof md.after === "string" ? md.after : "";
        const dst = readTranslationForGeneration(item) ?? item.src;
        const body = item.src === dst || dst === "" ? item.src : `${item.src}\n\n${dst}`;
        return before + body + after;
      })
      .join("");
    writeUtf8File(path.join(bilingual_path, rel_path), bi);
  }
}

/** 3. JSON: KVJSON & MESSAGEJSON */
export function parseJsonBytes(content, relPath) {
  const text = decodeTextContent(content);
  const data = JSON.parse(text);
  if (Array.isArray(data)) {
    const messages = data.filter((e) => e && typeof e === "object" && !Array.isArray(e) && typeof e.message === "string");
    return messages.map((record, row) =>
      createBaseItem({
        src: record.message,
        name_src:
          typeof record.name === "string"
            ? record.name
            : Array.isArray(record.names)
              ? (record.names.find((v) => typeof v === "string") ?? null)
              : null,
        row,
        file_type: "MESSAGEJSON",
        file_path: relPath,
      }),
    );
  }
  if (data && typeof data === "object") {
    const items = [];
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "string") continue;
      items.push(
        createBaseItem({
          src: key,
          dst: value,
          row: items.length,
          file_type: "KVJSON",
          file_path: relPath,
          status: key === "" ? "RULE_SKIPPED" : value !== "" && value !== key ? "PROCESSED" : "NONE",
        }),
      );
    }
    return items;
  }
  return [];
}

export function writeKvJsonItems(items, originalBytes, { translated_path, rel_path }) {
  const data = JSON.parse(decodeTextContent(originalBytes));
  for (const item of items) {
    const sourceVal = Object.hasOwn(data, item.src) ? data[item.src] : "";
    data[item.src] = readTranslationForGeneration(item) ?? (sourceVal !== "" ? sourceVal : item.src);
  }
  writeUtf8File(path.join(translated_path, rel_path), JSON.stringify(data, null, 4));
}

export function writeMessageRecordsInPlace(messages, items, allowNamesArray = false) {
  const written = new Set();
  for (const item of items) {
    const record = messages[item.row];
    if (!record || written.has(item.row) || record.message !== item.src) {
      throw new Error(`Message record mismatch at row ${item.row}`);
    }
    written.add(item.row);
    record.message = readTranslationForGeneration(item) ?? item.src;
    if (!item.name_dst) continue;
    if (!allowNamesArray || typeof record.name === "string" || !Array.isArray(record.names)) {
      record.name = item.name_dst;
    } else {
      const slot = record.names.findIndex((v) => typeof v === "string");
      if (slot < 0) record.names.unshift(item.name_dst);
      else record.names[slot] = item.name_dst;
    }
  }
}

export function writeMessageJsonItems(items, originalBytes, { translated_path, rel_path }) {
  const data = JSON.parse(decodeTextContent(originalBytes));
  const messages = data.filter((e) => e && typeof e === "object" && !Array.isArray(e) && typeof e.message === "string");
  writeMessageRecordsInPlace(messages, items, true);
  writeUtf8File(path.join(translated_path, rel_path), JSON.stringify(data, null, 4));
}

/** 4. Generic (.generic / .media ZIP container with items.json) */
export function parseGenericBytes(content, relPath, fileType = "GENERIC") {
  const entries = readZipEntries(content);
  const member = entries.get(GENERIC_ITEMS_MEMBER);
  if (!member) throw new Error(`Missing ${GENERIC_ITEMS_MEMBER} in ${relPath}`);
  const records = JSON.parse(member.data.toString("utf8"));
  if (!Array.isArray(records)) throw new Error(`Invalid ${GENERIC_ITEMS_MEMBER} array in ${relPath}`);
  return records.map((rec, row) => {
    if (!rec || typeof rec !== "object" || typeof rec.message !== "string") {
      throw new Error(`Invalid generic item at index ${row}`);
    }
    return createBaseItem({
      src: rec.message,
      name_src: typeof rec.name === "string" ? rec.name : null,
      row,
      file_type: fileType,
      file_path: relPath,
    });
  });
}

export function renderGenericWritebackJson(originalBytes, items, relPath) {
  const entries = readZipEntries(originalBytes);
  const member = entries.get(GENERIC_ITEMS_MEMBER);
  if (!member) throw new Error(`Missing ${GENERIC_ITEMS_MEMBER} in ${relPath}`);
  const records = JSON.parse(member.data.toString("utf8"));
  writeMessageRecordsInPlace(records, items, false);
  return JSON.stringify(records, null, 4);
}

/** 5. Subtitle Formats (SRT / VTT) */
export function parseSrtBytes(content, relPath, fileType = "SRT") {
  const text = decodeTextContent(content).replace(/\r\n|\r/gu, "\n");
  const blocks = text.split(/\n{2,}/u);
  const items = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;
    const header = lines.slice(0, timeIdx + 1).join("\n");
    const body = lines.slice(timeIdx + 1).join("\n");
    items.push(
      createBaseItem({
        src: body,
        row: items.length,
        file_type: fileType,
        file_path: relPath,
        extra_field: { subtitle_header: header },
      }),
    );
  }
  return items;
}

export function writeSrtItems(items, { translated_path, bilingual_path, rel_path, write_bilingual = false, isVtt = false }) {
  const sorted = [...items].sort((a, b) => a.row - b.row);
  const prefix = isVtt ? "WEBVTT\n\n" : "";
  const mono =
    prefix +
    sorted
      .map((item, idx) => {
        const header = item.extra_field?.subtitle_header ?? `${idx + 1}`;
        const dst = readTranslationForGeneration(item) ?? item.src;
        return `${header}\n${dst}`;
      })
      .join("\n\n") +
    "\n";
  writeUtf8File(path.join(translated_path, rel_path), mono);

  if (write_bilingual && bilingual_path) {
    const bi =
      prefix +
      sorted
        .map((item, idx) => {
          const header = item.extra_field?.subtitle_header ?? `${idx + 1}`;
          const dst = readTranslationForGeneration(item) ?? item.src;
          const body = item.src === dst || dst === "" ? item.src : `${item.src}\n${dst}`;
          return `${header}\n${body}`;
        })
        .join("\n\n") +
      "\n";
    writeUtf8File(path.join(bilingual_path, rel_path), bi);
  }
}
