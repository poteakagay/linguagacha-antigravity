import fs from "node:fs";
import path from "node:path";
import { compileLiteralPatterns } from "../sdk/literal-matcher.mjs";
import { hasLanguageBodyCharacter, hasLanguageCharacter } from "./language.mjs";

const PRESETS_ROOT = path.resolve(import.meta.dirname, "..", "..", "presets");

function loadPreservePreset(name) {
  const p = path.join(PRESETS_ROOT, "text_preserve", "preset", `${name}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
}

const BASE_PRESERVE_ENTRIES = loadPreservePreset("base");
const SMART_PRESERVE_BY_TYPE = {
  NONE: [],
  MD: [],
  KAG: loadPreservePreset("kag"),
  RENPY: loadPreservePreset("renpy"),
  RPGMAKER: loadPreservePreset("rpgmaker"),
  WOLF: loadPreservePreset("wolf"),
  GODOT: loadPreservePreset("godot"),
};

export const RESOURCE_EXTENSIONS = [
  "mp3","wav","ogg","mid","flac","opus","m4a","aac",
  "png","jpg","jpeg","gif","psd","webp","heif","heic","bmp","svg","ico","avif",
  "avi","mp4","webm","mkv","mov",
  "ttf","otf","woff","woff2",
  "txt","json","sav","mps","xml","yaml","yml","csv","bin",
  "md","pdf","html","htm","xhtml","xhtm","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","rtf","epub",
  "7z","gz","rar","zip","tar",
];

const DATA_URI_BASE64_PATTERN =
  /\bdata:[a-z][a-z\d.+-]*\/[a-z\d.+-]+(?:;[a-z\d!#$&^_.+-]+(?:=[a-z\d!#$&^_.+%-]*)?)*;base64,[a-z\d+/=_-]+/giu;
const URI_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`，。；：！？、（）【】「」『』]+/giu;
const RESOURCE_PATH_PATTERN = new RegExp(
  String.raw`[\p{L}\p{M}\p{N}_@%+~.-]+(?:[\\/][\p{L}\p{M}\p{N}_@%+~.-]+)*\.(?:${RESOURCE_EXTENSIONS.join(
    "|",
  )})(?![\p{L}\p{M}\p{N}_-])(?:[?#][^\s<>"'\x60，。；：！？、（）【】「」『』]+)?`,
  "giu",
);

const SIMPLE_TRAILING_PUNCTUATION = new Set([
  ".", ",", ";", ":", "!", "?", "。", "，", "；", "：", "！", "？", "、",
]);
const CLOSING_TO_OPENING = new Map([
  [")", "("], ["]", "["], ["}", "{"], ["）", "（"], ["】", "【"], ["」", "「"], ["』", "『"],
]);

function countCharacter(text, character) {
  return text.split(character).length - 1;
}

function trimReferenceEnd(text, start, initialEnd) {
  let end = initialEnd;
  while (end > start) {
    const last = text[end - 1] ?? "";
    if (SIMPLE_TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const opening = CLOSING_TO_OPENING.get(last);
    if (opening === undefined) break;
    const value = text.slice(start, end);
    if (countCharacter(value, last) <= countCharacter(value, opening)) break;
    end -= 1;
  }
  return end;
}

function collectPatternCandidates(text, pattern, priority) {
  const re = new RegExp(pattern.source, pattern.flags);
  const candidates = [];
  for (const match of text.matchAll(re)) {
    const rawValue = match[0] ?? "";
    const start = match.index ?? -1;
    if (start < 0 || rawValue === "") continue;
    const end = trimReferenceEnd(text, start, start + rawValue.length);
    candidates.push({ start, end, value: text.slice(start, end), priority });
  }
  return candidates;
}

export function collectTextResourceReferences(text) {
  const str = String(text ?? "");
  const candidates = [
    ...collectPatternCandidates(str, DATA_URI_BASE64_PATTERN, 0),
    ...collectPatternCandidates(str, URI_PATTERN, 1),
    ...collectPatternCandidates(str, RESOURCE_PATH_PATTERN, 2),
  ].sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);

  const references = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor || candidate.end <= candidate.start) continue;
    references.push({ start: candidate.start, end: candidate.end, value: candidate.value });
    cursor = candidate.end;
  }
  return references;
}

function replaceReferenceRanges(text, references, replacement) {
  let result = "";
  let cursor = 0;
  for (const ref of references) {
    result += text.slice(cursor, ref.start) + replacement(ref);
    cursor = ref.end;
  }
  return result + text.slice(cursor);
}

export function removeTextResourceReferences(text, references) {
  const str = String(text ?? "");
  return replaceReferenceRanges(str, references ?? collectTextResourceReferences(str), () => "");
}

function escapeRegexp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildMappingTokenPattern(mappings) {
  const tokens = [...new Set(mappings.map((m) => m.token))];
  if (tokens.length === 0) return null;
  return new RegExp(
    `(?:${tokens.sort((a, b) => b.length - a.length).map(escapeRegexp).join("|")})(?!\\d)`,
    "gu",
  );
}

export function projectTextResourceReferences(text, startOrdinal = 0) {
  const str = String(text ?? "");
  const references = collectTextResourceReferences(str);
  const mappings = [];
  let nextOrdinal = Math.max(0, Math.trunc(startOrdinal));
  const projected = replaceReferenceRanges(str, references, (ref) => {
    let token = `lg-uri/${nextOrdinal}`;
    while (str.includes(token)) {
      nextOrdinal += 1;
      token = `lg-uri/${nextOrdinal}`;
    }
    nextOrdinal += 1;
    mappings.push({ token, value: ref.value });
    return token;
  });
  return { text: projected, mappings, next_ordinal: nextOrdinal };
}

export function restoreTextResourceReferences(text, mappings) {
  const pattern = buildMappingTokenPattern(mappings);
  if (pattern === null) return text;
  const byToken = new Map(mappings.map((m) => [m.token, m.value]));
  return text.replace(pattern, (token) => byToken.get(token) ?? token);
}

export function transformProjectedTextResourceReferences(text, mappings, transform) {
  const pattern = buildMappingTokenPattern(mappings);
  if (pattern === null) return transform(text);
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0] ?? "";
    const index = match.index ?? -1;
    if (token === "" || index < cursor) continue;
    result += transform(text.slice(cursor, index)) + token;
    cursor = index + token.length;
  }
  return result + transform(text.slice(cursor));
}

export function splitTextLines(text) {
  return String(text ?? "").replace(/\r\n|\r/gu, "\n").split("\n");
}

export function normalizeTextPreserveMode(value, fallback = "off") {
  const norm = String(value?.value ?? value ?? "").trim().toLowerCase();
  return norm === "off" || norm === "smart" || norm === "custom" ? norm : fallback;
}

export class TextPreserveRule {
  constructor(entries) {
    this.patterns = entries
      .filter((e) => typeof e?.src === "string" && e.src.trim() !== "")
      .map(({ src }) => new RegExp(src, "giu"));
  }

  analyze(text) {
    const str = String(text ?? "");
    const matches = this.#collectSampleMatches(str);
    return {
      text: str,
      segments: matches.map((m) => m.value),
      unpreserved_text: this.#replaceMatches(str, matches, (val) => val.replace(/[^\r\n]/gu, " ")),
    };
  }

  collect(text) {
    return this.#collectSampleMatches(String(text ?? "")).map((m) => m.value);
  }

  replace(text, replacement) {
    const str = String(text ?? "");
    return this.#replaceMatches(str, this.#collectSampleMatches(str), replacement);
  }

  #collectSampleMatches(text) {
    const candidates = [];
    this.patterns.forEach((pattern, definition_index) => {
      for (const match of text.matchAll(pattern)) {
        const value = match[0];
        if (value === "") continue;
        candidates.push({ value, index: match.index, definition_index });
      }
    });
    candidates.sort((a, b) => (a.index !== b.index ? a.index - b.index : a.definition_index - b.definition_index));
    const result = [];
    let cursor = 0;
    for (const candidate of candidates) {
      if (candidate.index < cursor) continue;
      result.push(candidate);
      cursor = candidate.index + candidate.value.length;
    }
    return result;
  }

  #replaceMatches(text, matches, replacement) {
    let result = "";
    let cursor = 0;
    matches.forEach((match, index) => {
      result += text.slice(cursor, match.index);
      result += typeof replacement === "string" ? replacement : replacement(match.value, index);
      cursor = match.index + match.value.length;
    });
    return result + text.slice(cursor);
  }
}

export function resolveTextRuleType(item, fileContext) {
  const ft = fileContext?.file_type ?? item?.file_type ?? "NONE";
  switch (ft) {
    case "RPGMAKER_MV_MZ":
    case "RPGMAKER_RGSS":
      return "RPGMAKER";
    case "WOLFRPG":
    case "WOLFXLSX":
      return "WOLF";
    case "GODOT":
      return "GODOT";
    case "RENPY_RPY":
    case "RENPY":
      return "RENPY";
    case "MESSAGEJSON":
      return "KAG";
    case "MD_V2":
      return "MD";
    default:
      return "NONE";
  }
}

export function buildTextPreserveRule({ mode = "smart", text_type = "NONE", entries = [] }) {
  const normMode = normalizeTextPreserveMode(mode, "smart");
  let extra = [];
  if (normMode === "custom") extra = entries;
  else if (normMode === "smart") {
    const key = String(text_type).toUpperCase();
    extra = SMART_PRESERVE_BY_TYPE[key] ?? [];
  }
  return new TextPreserveRule([...BASE_PRESERVE_ENTRIES, ...extra]);
}

function buildBackslashReplacement(replacementText, replaceArgs) {
  const groups = replaceArgs.at(-1);
  const hasNamedGroups = typeof groups === "object" && groups !== null;
  const captures = replaceArgs.slice(1, hasNamedGroups ? -3 : -2);
  return replacementText.replace(
    /\\g<([^>]+)>|\\([1-9][0-9]?)|\\([nrt])|\\\\/gu,
    (match, named, index, escapedChar) => {
      if (match === "\\\\") return "\\";
      if (escapedChar === "n") return "\n";
      if (escapedChar === "r") return "\r";
      if (escapedChar === "t") return "\t";
      if (typeof named === "string" && named !== "") {
        const num = Number.parseInt(named, 10);
        if (Number.isFinite(num)) return String(captures[num - 1] ?? "");
        if (hasNamedGroups && named in groups) return String(groups[named] ?? "");
        return "";
      }
      const captureIndex = Number.parseInt(String(index), 10);
      return String(captures[captureIndex - 1] ?? "");
    },
  );
}

export function compileTextReplacements(entries) {
  return entries.map((entry) => {
    const src = String(entry.src ?? "");
    if (src === "") throw new TypeError("Replacement rule src must not be empty.");
    const dst = String(entry.dst ?? "");
    const caseSensitive = Boolean(entry.case_sensitive);
    if (entry.regex) {
      return {
        kind: "regex",
        regexp: new RegExp(src, `g${caseSensitive ? "" : "i"}u`),
        dst,
      };
    }
    return {
      kind: "literal",
      matcher: compileLiteralPatterns([{ key: "pattern", text: src, case_sensitive: caseSensitive }]),
      dst,
    };
  });
}

export function applyTextReplacements(text, compiled) {
  if (!compiled || compiled.length === 0) return text;
  let result = String(text ?? "");
  for (const rule of compiled) {
    if (rule.kind === "literal") {
      const ranges = (rule.matcher.match(result)[0]?.ranges ?? []).toSorted(
        (a, b) => a.start - b.start || a.end - b.end,
      );
      let next = "";
      let offset = 0;
      for (const range of ranges) {
        if (range.start < offset) continue;
        next += result.slice(offset, range.start) + rule.dst;
        offset = range.end;
      }
      result = next + result.slice(offset);
    } else {
      const re = new RegExp(rule.regexp.source, rule.regexp.flags);
      result = result.replace(re, (...args) => buildBackslashReplacement(rule.dst, args));
    }
  }
  return result;
}

export function prepareTranslationSource({
  src,
  name_src = null,
  text_type = "NONE",
  preserve_rule,
  pre_replacements = null,
  start_ordinal = 0,
}) {
  const name = name_src === null || name_src === "" ? null : projectTextResourceReferences(name_src, start_ordinal);
  const body = projectTextResourceReferences(
    String(src ?? "").replace(/\r\n|\r/gu, "\n"),
    name?.next_ordinal ?? start_ordinal,
  );
  const prepared_lines = body.text.split("\n").map((raw_text) => {
    if (raw_text.trim() === "") {
      return { state: "preserved", prepared_text: raw_text, preserve_analysis: preserve_rule.analyze(raw_text) };
    }
    const leading_whitespace = raw_text.match(/^\s*/u)?.[0] ?? "";
    const trailing_whitespace = raw_text.match(/\s*$/u)?.[0] ?? "";
    const core = raw_text.slice(leading_whitespace.length, raw_text.length - trailing_whitespace.length);
    const trimmedAnalysis = preserve_rule.analyze(core);
    if (trimmedAnalysis.unpreserved_text.trim() === "") {
      return {
        state: "preserved",
        prepared_text: raw_text,
        preserve_analysis: trimmedAnalysis.text === raw_text ? trimmedAnalysis : preserve_rule.analyze(raw_text),
      };
    }
    const replaced =
      pre_replacements === null
        ? core
        : transformProjectedTextResourceReferences(core, body.mappings, (val) =>
            applyTextReplacements(val, pre_replacements),
          );
    const prepared_text = `${leading_whitespace}${replaced}${trailing_whitespace}`;
    const preserve_analysis =
      prepared_text === trimmedAnalysis.text ? trimmedAnalysis : preserve_rule.analyze(prepared_text);
    return {
      state: "translatable",
      restoration_text: core,
      prepared_text,
      preserve_analysis,
      leading_whitespace,
      trailing_whitespace,
    };
  });

  const samples = name === null ? [] : preserve_rule.collect(name.text);
  for (const line of prepared_lines) {
    samples.push(...line.preserve_analysis.segments);
    if (String(text_type).toUpperCase() === "MD" && line.state === "translatable") {
      samples.push("Markdown Code");
    }
  }
  return {
    body,
    name,
    prepared_lines,
    samples: [...new Set(samples.filter((v) => v.trim() !== ""))],
  };
}

const RULE_PREFILTER_PREFIXES = ["mapdata/", "se/", "bgs/", "0=", "bgm/", "ficon/"];
const RULE_PREFILTER_PATTERNS = [/^EV\d+$/iu, /^DejaVu Sans$/iu, /^Opendyslexic$/iu, /^\{#file_time\}/iu];

function shouldSkipRulePrefilterLine(rawLine) {
  const line = rawLine.trim();
  if (line === "") return true;
  const lower = line.toLowerCase();
  return (
    !hasLanguageBodyCharacter(removeTextResourceReferences(line)) ||
    RULE_PREFILTER_PREFIXES.some((p) => lower.startsWith(p)) ||
    RULE_PREFILTER_PATTERNS.some((re) => re.test(lower))
  );
}

/** 导入条目时的规则预过滤、源语言预过滤与同文件同文去重状态计算 */
export function applyImportPrefiltersAndDuplicates(items, { sourceLanguage = "JA", deduplicate = true } = {}) {
  const seenByFile = new Map();
  for (const item of items) {
    if (item.status && item.status !== "NONE") continue;
    if (item.skip_internal_filter) continue;

    const srcLines = String(item.src ?? "").split(/\r\n|\r|\n/gu);
    const hasNameCandidate =
      typeof item.name_src === "string" &&
      item.name_src.trim() !== "" &&
      hasLanguageBodyCharacter(removeTextResourceReferences(item.name_src));
    const hasSrcCandidate = !srcLines.every(shouldSkipRulePrefilterLine);

    if (!hasSrcCandidate && !hasNameCandidate) {
      item.status = "RULE_SKIPPED";
      continue;
    }

    const checkText = `${item.src ?? ""}\n${item.name_src ?? ""}`;
    if (!hasLanguageCharacter(checkText, sourceLanguage)) {
      item.status = "LANGUAGE_SKIPPED";
      continue;
    }

    if (deduplicate) {
      let fileSet = seenByFile.get(item.file_path);
      if (!fileSet) {
        fileSet = new Set();
        seenByFile.set(item.file_path, fileSet);
      }
      const dupKey = JSON.stringify([item.src ?? "", item.name_src ?? ""]);
      if (fileSet.has(dupKey)) {
        item.status = "DUPLICATED";
      } else {
        fileSet.add(dupKey);
      }
    }
  }
  return items;
}
