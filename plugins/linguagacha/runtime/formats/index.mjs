import fs from "node:fs";
import path from "node:path";
import { EPUBFormat } from "./epub-format.mjs";
import {
  GENERIC_ITEMS_MEMBER,
  parseGenericBytes,
  parseJsonBytes,
  parseMdBytes,
  parseSrtBytes,
  parseTxtBytes,
  renderGenericWritebackJson,
  writeKvJsonItems,
  writeMdItems,
  writeMessageJsonItems,
  writeSrtItems,
  writeTxtItems,
} from "./text-formats.mjs";

export const SUPPORTED_FILE_EXTENSIONS = new Map([
  [".epub", "EPUB"],
  [".txt", "TXT"],
  [".md", "MD_V2"],
  [".markdown", "MD_V2"],
  [".json", "JSON"],
  [".generic", "GENERIC"],
  [".srt", "SRT"],
  [".vtt", "VTT"],
]);

const UNSUPPORTED_BINARY_EXTENSIONS = new Map([
  [".pdf", "PDF 原生 C++ MuPDF 引擎未在当前小说插件中实装"],
  [".xlsx", "Excel 二进制表格处理器未在当前小说插件中实装，可转为 JSON 或 .generic 处理"],
  [".pck", "Godot 游戏解封包器未在当前小说插件中实装"],
  [".wolf", "WolfRPG 加密封包器未在当前小说插件中实装"],
  [".rpa", "Ren'Py 归档封包器未在当前小说插件中实装"],
]);

function walkDirectoryFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === ".lg_workspace" || entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...walkDirectoryFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** 复现原版 inspectSources(source_paths) 接口 */
export function inspectSourcesOnDisk(sourcePaths, workspaceRoot = process.cwd()) {
  return sourcePaths.map((rawSourcePath) => {
    const resolved = path.isAbsolute(rawSourcePath)
      ? path.resolve(rawSourcePath)
      : path.resolve(workspaceRoot, rawSourcePath);

    if (!fs.existsSync(resolved)) {
      return {
        source_path: rawSourcePath,
        files: [],
        godot_packs: [],
        failures: [{ path: rawSourcePath, message: `来源路径不存在: ${resolved}` }],
      };
    }

    const stat = fs.statSync(resolved);
    const candidateFiles = stat.isDirectory() ? walkDirectoryFiles(resolved) : [resolved];
    const files = [];
    const failures = [];

    for (const f of candidateFiles) {
      const ext = path.extname(f).toLowerCase();
      if (SUPPORTED_FILE_EXTENSIONS.has(ext)) {
        files.push({ path: f.replace(/\\/gu, "/"), kind: "file" });
      } else if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext) && !stat.isDirectory()) {
        failures.push({ path: f.replace(/\\/gu, "/"), message: UNSUPPORTED_BINARY_EXTENSIONS.get(ext) });
      }
    }

    return {
      source_path: rawSourcePath,
      files,
      godot_packs: [],
      failures,
    };
  });
}

/** 解析单个原稿文件返回 Item[] 与实际 file_type */
export function parseAssetBytes(content, relPath, { targetLanguage = "ZH" } = {}) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".epub") {
    const epub = new EPUBFormat({ target_language: targetLanguage });
    const items = epub.readFromBytes(content, relPath);
    return { file_type: "EPUB", items, is_container: true };
  }
  if (ext === ".txt") {
    return { file_type: "TXT", items: parseTxtBytes(content, relPath), is_container: false };
  }
  if (ext === ".md" || ext === ".markdown") {
    return { file_type: "MD_V2", items: parseMdBytes(content, relPath), is_container: false };
  }
  if (ext === ".json") {
    const items = parseJsonBytes(content, relPath);
    const fileType = items[0]?.file_type ?? "KVJSON";
    return { file_type: fileType, items, is_container: false };
  }
  if (ext === ".generic") {
    return { file_type: "GENERIC", items: parseGenericBytes(content, relPath, "GENERIC"), is_container: true };
  }
  if (ext === ".srt") {
    return { file_type: "SRT", items: parseSrtBytes(content, relPath, "SRT"), is_container: false };
  }
  if (ext === ".vtt") {
    return { file_type: "VTT", items: parseSrtBytes(content, relPath, "VTT"), is_container: false };
  }
  throw new Error(`Unsupported file extension: ${ext} (${relPath})`);
}

/** 生成前把同文件 DUPLICATED 条目同步为同文 PROCESSED 条目的译文与译名 */
export function hydrateDuplicatedItemsForGeneration(items) {
  const processedByKey = new Map();
  for (const item of items) {
    if (item.status === "PROCESSED") {
      const key = JSON.stringify([item.file_path, item.src ?? "", item.name_src ?? ""]);
      if (!processedByKey.has(key)) processedByKey.set(key, item);
    }
  }
  return items.map((item) => {
    if (item.status !== "DUPLICATED") return { ...item };
    const key = JSON.stringify([item.file_path, item.src ?? "", item.name_src ?? ""]);
    const donor = processedByKey.get(key);
    if (!donor) return { ...item };
    return {
      ...item,
      dst: donor.dst,
      name_dst: donor.name_dst ?? item.name_dst,
      status: "PROCESSED",
    };
  });
}

/** 导出全部已支持格式的单语与按需双语成果，复现 generateFiles(bilingual_files) */
export function generateProjectFiles({
  files,
  items,
  readOriginalAssetBytes,
  translatedPath,
  bilingualPath,
  writebackInputPath,
  bilingualFiles = [],
  targetLanguage = "ZH",
}) {
  const hydratedItems = hydrateDuplicatedItemsForGeneration(items);
  const itemsByFile = new Map();
  for (const item of hydratedItems) {
    const list = itemsByFile.get(item.file_path) ?? [];
    list.push(item);
    itemsByFile.set(item.file_path, list);
  }

  const bilingualSet = new Set(bilingualFiles);
  const excludedFiles = [];
  const writebackFiles = [];
  const epubFormat = new EPUBFormat({ target_language: targetLanguage });

  fs.mkdirSync(translatedPath, { recursive: true });

  for (const fileMeta of files) {
    const relPath = fileMeta.file_path;
    const fileType = fileMeta.file_type;
    const fileItems = itemsByFile.get(relPath) ?? [];
    const wantBilingual = bilingualSet.has(relPath);

    if (fileType === "EPUB") {
      const orig = readOriginalAssetBytes(relPath);
      if (!orig) {
        excludedFiles.push(relPath);
        continue;
      }
      epubFormat.writeToPaths(fileItems, orig, {
        translated_path: translatedPath,
        bilingual_path: bilingualPath,
        rel_path: relPath,
        write_bilingual: wantBilingual,
      });
    } else if (fileType === "TXT") {
      writeTxtItems(fileItems, {
        translated_path: translatedPath,
        bilingual_path: bilingualPath,
        rel_path: relPath,
        write_bilingual: wantBilingual,
      });
    } else if (fileType === "MD_V2") {
      writeMdItems(fileItems, {
        translated_path: translatedPath,
        bilingual_path: bilingualPath,
        rel_path: relPath,
        write_bilingual: wantBilingual,
      });
    } else if (fileType === "KVJSON") {
      const orig = readOriginalAssetBytes(relPath);
      if (!orig) {
        excludedFiles.push(relPath);
        continue;
      }
      writeKvJsonItems(fileItems, orig, { translated_path: translatedPath, rel_path: relPath });
    } else if (fileType === "MESSAGEJSON") {
      const orig = readOriginalAssetBytes(relPath);
      if (!orig) {
        excludedFiles.push(relPath);
        continue;
      }
      writeMessageJsonItems(fileItems, orig, { translated_path: translatedPath, rel_path: relPath });
    } else if (fileType === "GENERIC") {
      const orig = readOriginalAssetBytes(relPath);
      if (!orig || !writebackInputPath) {
        excludedFiles.push(relPath);
        continue;
      }
      const rendered = renderGenericWritebackJson(orig, fileItems, relPath);
      const outJsonPath = path.join(writebackInputPath, relPath, GENERIC_ITEMS_MEMBER);
      fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
      fs.writeFileSync(outJsonPath, rendered, "utf8");
      writebackFiles.push(relPath);
    } else if (fileType === "SRT" || fileType === "VTT") {
      writeSrtItems(fileItems, {
        translated_path: translatedPath,
        bilingual_path: bilingualPath,
        rel_path: relPath,
        write_bilingual: wantBilingual,
        isVtt: fileType === "VTT",
      });
    } else {
      excludedFiles.push(relPath);
    }
  }

  return {
    accepted: true,
    output_path: translatedPath.replace(/\\/gu, "/"),
    bilingual_output_path: bilingualPath.replace(/\\/gu, "/"),
    excluded_files: excludedFiles,
    ...(writebackFiles.length > 0 && writebackInputPath
      ? {
          writeback: {
            input_path: writebackInputPath.replace(/\\/gu, "/"),
            files: writebackFiles,
          },
        }
      : {}),
    pdf_files: [],
  };
}
