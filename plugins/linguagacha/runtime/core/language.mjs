const WRITING_SYSTEM_CODES = ["HAN", "KANA", "HANGUL", "LATIN", "CYRILLIC", "ARABIC", "THAI"];

export const ALL_LANGUAGE_CODE = "ALL";
export const SOURCE_LANGUAGE_CODES = [
  "ZH", "EN", "JA", "KO", "RU", "AR", "DE", "FR", "PL", "ES", "IT", "PT", "HU", "TR", "TH", "ID", "VI",
];
export const TARGET_LANGUAGE_CODES = [
  "ZH", "ZH-HANT", "EN", "JA", "KO", "RU", "AR", "DE", "FR", "PL", "ES", "IT", "PT", "HU", "TR", "TH", "ID", "VI",
];

const LETTER_CHARACTER_PATTERN = /\p{L}/u;
const MARK_CHARACTER_PATTERN = /\p{M}/u;
const COMMON_OR_INHERITED_SCRIPT_PATTERN = /(?:\p{Script=Common}|\p{Script=Inherited})/u;
const HAN_SCRIPT_PATTERN = /\p{Script_Extensions=Han}/u;
const HIRAGANA_SCRIPT_PATTERN = /\p{Script_Extensions=Hiragana}/u;
const KATAKANA_SCRIPT_PATTERN = /\p{Script_Extensions=Katakana}/u;
const HANGUL_SCRIPT_PATTERN = /\p{Script_Extensions=Hangul}/u;
const LATIN_SCRIPT_PATTERN = /\p{Script_Extensions=Latin}/u;
const CYRILLIC_SCRIPT_PATTERN = /\p{Script_Extensions=Cyrillic}/u;
const ARABIC_SCRIPT_PATTERN = /\p{Script_Extensions=Arabic}/u;
const THAI_SCRIPT_PATTERN = /\p{Script_Extensions=Thai}/u;

const KANA_AUXILIARY_CHARACTERS = new Set([
  "\u3099", "\u309A", "゛", "゜", "ー", "〱", "〲", "〳", "〴", "〵", "ｰ", "ﾞ", "ﾟ",
]);
const ARABIC_AUXILIARY_CHARACTERS = new Set(["ـ"]);

function matchesScriptLetter(character, scriptPattern, excludedCharacters) {
  return (
    LETTER_CHARACTER_PATTERN.test(character) &&
    scriptPattern.test(character) &&
    !(excludedCharacters?.has(character) ?? false)
  );
}

const WRITING_SYSTEM_DEFINITIONS = Object.freeze({
  HAN: {
    matches_body_character: (c) => matchesScriptLetter(c, HAN_SCRIPT_PATTERN),
    matches_auxiliary_character: () => false,
  },
  KANA: {
    matches_body_character: (c) =>
      matchesScriptLetter(c, HIRAGANA_SCRIPT_PATTERN, KANA_AUXILIARY_CHARACTERS) ||
      matchesScriptLetter(c, KATAKANA_SCRIPT_PATTERN, KANA_AUXILIARY_CHARACTERS),
    matches_auxiliary_character: (c) => KANA_AUXILIARY_CHARACTERS.has(c),
  },
  HANGUL: {
    matches_body_character: (c) => matchesScriptLetter(c, HANGUL_SCRIPT_PATTERN),
    matches_auxiliary_character: (c) => MARK_CHARACTER_PATTERN.test(c) && HANGUL_SCRIPT_PATTERN.test(c),
  },
  LATIN: {
    matches_body_character: (c) => matchesScriptLetter(c, LATIN_SCRIPT_PATTERN),
    matches_auxiliary_character: () => false,
  },
  CYRILLIC: {
    matches_body_character: (c) => matchesScriptLetter(c, CYRILLIC_SCRIPT_PATTERN),
    matches_auxiliary_character: () => false,
  },
  ARABIC: {
    matches_body_character: (c) => matchesScriptLetter(c, ARABIC_SCRIPT_PATTERN, ARABIC_AUXILIARY_CHARACTERS),
    matches_auxiliary_character: (c) =>
      ARABIC_AUXILIARY_CHARACTERS.has(c) || (MARK_CHARACTER_PATTERN.test(c) && ARABIC_SCRIPT_PATTERN.test(c)),
  },
  THAI: {
    matches_body_character: (c) => matchesScriptLetter(c, THAI_SCRIPT_PATTERN),
    matches_auxiliary_character: (c) => MARK_CHARACTER_PATTERN.test(c) && THAI_SCRIPT_PATTERN.test(c),
  },
});

const LANGUAGE_WRITING_SYSTEMS = {
  ALL: [],
  ZH: ["HAN"],
  "ZH-HANT": ["HAN"],
  EN: ["LATIN"],
  JA: ["HAN", "KANA"],
  KO: ["HAN", "HANGUL"],
  RU: ["CYRILLIC"],
  AR: ["ARABIC"],
  DE: ["LATIN"],
  FR: ["LATIN"],
  PL: ["LATIN"],
  ES: ["LATIN"],
  IT: ["LATIN"],
  PT: ["LATIN"],
  HU: ["LATIN"],
  TR: ["LATIN"],
  TH: ["THAI"],
  ID: ["LATIN"],
  VI: ["LATIN"],
};

function matchingWritingSystems(character, matcher) {
  return WRITING_SYSTEM_CODES.filter((code) => WRITING_SYSTEM_DEFINITIONS[code][matcher](character));
}

function classifyWritingSystemsForTarget(matchedSystems, targetSystems) {
  if (matchedSystems.some((code) => targetSystems.includes(code))) return "allowed";
  return matchedSystems.every((code) => code === "LATIN") ? "latin-residue" : "other-residue";
}

export function normalizeLanguageCode(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized in LANGUAGE_WRITING_SYSTEMS ? normalized : null;
}

export function hasLanguageBodyCharacter(text) {
  return [...String(text ?? "")].some((character) => {
    if (matchingWritingSystems(character, "matches_body_character").length > 0) return true;
    return LETTER_CHARACTER_PATTERN.test(character) && !COMMON_OR_INHERITED_SCRIPT_PATTERN.test(character);
  });
}

export function hasLanguageCharacter(text, languageCode) {
  const norm = normalizeLanguageCode(languageCode) ?? "ALL";
  if (norm === ALL_LANGUAGE_CODE) return true;
  const systems = LANGUAGE_WRITING_SYSTEMS[norm];
  return [...String(text ?? "")].some((character) =>
    matchingWritingSystems(character, "matches_body_character").some((code) => systems.includes(code)),
  );
}

export function classifyTargetLanguageGrapheme(grapheme, languageCode) {
  const norm = normalizeLanguageCode(languageCode) ?? "ZH";
  const writingSystems = LANGUAGE_WRITING_SYSTEMS[norm];
  let classification = "neutral";

  for (const character of grapheme) {
    const bodySystems = matchingWritingSystems(character, "matches_body_character");
    const matchedSystems =
      bodySystems.length > 0 ? bodySystems : matchingWritingSystems(character, "matches_auxiliary_character");
    if (matchedSystems.length > 0) {
      const charClass = classifyWritingSystemsForTarget(matchedSystems, writingSystems);
      if (charClass === "other-residue") return charClass;
      if (charClass === "latin-residue" || classification === "neutral") {
        classification = charClass;
      }
      continue;
    }
    if (LETTER_CHARACTER_PATTERN.test(character) && !COMMON_OR_INHERITED_SCRIPT_PATTERN.test(character)) {
      return "other-residue";
    }
  }
  return classification;
}

export function checkSimilarityByJaccard(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]).size;
  if (union === 0) return 0;
  let intersection = 0;
  for (const char of leftSet) {
    if (rightSet.has(char)) intersection += 1;
  }
  return intersection / union;
}

const TEXT_BOM_ENCODINGS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
];

function stripBom(text) {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** 探测字节流编码（BOM -> UTF-8 严格 -> Shift_JIS / GB18030 / Big5 / EUC-KR / Windows-1252 评分探测） */
export function detectEncoding(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const candidate of TEXT_BOM_ENCODINGS) {
    if (u8.length >= candidate.bytes.length && candidate.bytes.every((b, i) => u8[i] === b)) {
      return candidate.encoding;
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(u8);
    return "utf-8";
  } catch {
    // fallback heuristic across CJK & Western legacy encodings supported by ICU TextDecoder
  }
  const candidates = ["shift_jis", "gb18030", "big5", "euc-jp", "euc-kr", "windows-1252"];
  let bestEncoding = "utf-8";
  let bestScore = -Infinity;
  for (const enc of candidates) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(u8);
      let score = 0;
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) score -= 20;
        else if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af))
          score += 3;
        else if (cp >= 0x20 && cp <= 0x7e) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestEncoding = enc;
      }
    } catch {
      continue;
    }
  }
  return bestEncoding;
}

export function decodeTextContent(content, options) {
  const u8 = content instanceof Uint8Array ? content : new Uint8Array(content);
  for (const candidate of TEXT_BOM_ENCODINGS) {
    if (u8.length >= candidate.bytes.length && candidate.bytes.every((b, i) => u8[i] === b)) {
      return stripBom(new TextDecoder(candidate.encoding, { fatal: false }).decode(u8));
    }
  }
  const declared = options?.declaredEncoding?.trim();
  if (declared) {
    try {
      return stripBom(new TextDecoder(declared, { fatal: true }).decode(u8));
    } catch {
      // fall through
    }
  }
  try {
    return stripBom(new TextDecoder("utf-8", { fatal: true }).decode(u8));
  } catch {
    const detected = detectEncoding(u8);
    return stripBom(new TextDecoder(detected, { fatal: false }).decode(u8));
  }
}
