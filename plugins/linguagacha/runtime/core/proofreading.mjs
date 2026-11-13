import { compileLiteralPatterns } from "../sdk/literal-matcher.mjs";
import {
  classifyTargetLanguageGrapheme,
  checkSimilarityByJaccard,
  normalizeLanguageCode,
} from "./language.mjs";
import {
  buildTextPreserveRule,
  compileTextReplacements,
  prepareTranslationSource,
  projectTextResourceReferences,
  restoreTextResourceReferences,
  resolveTextRuleType,
  splitTextLines,
} from "./text-rules.mjs";

export const PROOFREADING_WARNING_CODES = [
  "FOREIGN_CHAR_RESIDUE",
  "SIMILARITY",
  "LINE_COUNT_MISMATCH",
  "GLOSSARY",
  "TEXT_PRESERVE",
  "PUNCTUATION_MISMATCH",
];

const PROOFREADING_SKIPPED_STATUSES = new Set([
  "NONE",
  "RULE_SKIPPED",
  "LANGUAGE_SKIPPED",
  "EXCLUDED",
  "DUPLICATED",
]);

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SHORT_ASCII_UPPERCASE_LATIN_PATTERN = /^[A-Z]{2,4}$/;
const TRANSLATION_SIMILARITY_THRESHOLD = 0.8;

const PUNCTUATION_GROUPS = {
  QUOTE: '“”„‟「」『』«»"＂',
  ROUND_OPEN: "(（",
  ROUND_CLOSE: ")）",
  SQUARE_OPEN: "[［【",
  SQUARE_CLOSE: "]］】",
  BRACE_OPEN: "{｛",
  BRACE_CLOSE: "}｝",
  TITLE_OPEN: "《",
  TITLE_CLOSE: "》",
};

const PUNCTUATION_GROUP_BY_CHAR = new Map(
  Object.entries(PUNCTUATION_GROUPS).flatMap(([group, chars]) =>
    Array.from(chars, (c) => [c, group]),
  ),
);

function collectPunctuationStructure(text) {
  const structure = [];
  for (const ch of text) {
    const g = PUNCTUATION_GROUP_BY_CHAR.get(ch);
    if (g !== undefined) structure.push(g);
  }
  return structure;
}

export function hasPunctuationStructureMismatch({ src, dst }) {
  const s = collectPunctuationStructure(src);
  const d = collectPunctuationStructure(dst);
  return s.length !== d.length || s.some((g, i) => g !== d[i]);
}

export function collectForeignResidueFragments({ text, targetLanguage }) {
  const fragments = [];
  let currentFragment = "";
  let currentGraphemeCount = 0;
  let currentHasOtherResidue = false;

  const flush = () => {
    const isExemptLatin =
      !currentHasOtherResidue &&
      (currentGraphemeCount === 1 || SHORT_ASCII_UPPERCASE_LATIN_PATTERN.test(currentFragment));
    if (currentFragment !== "" && !isExemptLatin) {
      fragments.push(currentFragment);
    }
    currentFragment = "";
    currentGraphemeCount = 0;
    currentHasOtherResidue = false;
  };

  for (const { segment } of GRAPHEME_SEGMENTER.segment(String(text ?? ""))) {
    const cls = classifyTargetLanguageGrapheme(segment, targetLanguage);
    if (cls === "latin-residue" || cls === "other-residue") {
      currentFragment += segment;
      currentGraphemeCount += 1;
      currentHasOtherResidue ||= cls === "other-residue";
      continue;
    }
    flush();
  }
  flush();
  return [...new Set(fragments)];
}

export function hasTranslationSimilarityIssue({
  src,
  dst,
  sourceLanguage,
  targetLanguage,
  has_foreign_residue,
}) {
  const left = String(src ?? "").trim();
  const right = String(dst ?? "").trim();
  if (left === "" || right === "") return false;
  const similar =
    left.includes(right) ||
    right.includes(left) ||
    checkSimilarityByJaccard(left, right) > TRANSLATION_SIMILARITY_THRESHOLD;
  if (!similar) return false;

  const tgt = normalizeLanguageCode(targetLanguage);
  const srcLang = normalizeLanguageCode(sourceLanguage);
  if (tgt !== "ZH" && tgt !== "ZH-HANT") return true;
  if (srcLang !== "JA" && srcLang !== "KO") return true;
  return Boolean(has_foreign_residue);
}

export function compileGlossary(entries) {
  const matchable = (entries ?? [])
    .map((e, idx) => ({
      entry_id: String(e.id ?? e.entry_id ?? `g_${idx + 1}`),
      src: String(e.src ?? ""),
      dst: String(e.dst ?? ""),
      info: String(e.info ?? ""),
      case_sensitive: Boolean(e.case_sensitive),
    }))
    .filter((e) => e.src.trim() !== "");

  // Deduplicate identical keys if any
  const unique = [];
  const seenIds = new Set();
  for (const entry of matchable) {
    if (seenIds.has(entry.entry_id)) continue;
    seenIds.add(entry.entry_id);
    unique.push(entry);
  }

  return {
    entries: unique,
    source_matcher: compileLiteralPatterns(
      unique.map((e) => ({ key: e.entry_id, text: e.src, case_sensitive: e.case_sensitive })),
    ),
    target_matcher: compileLiteralPatterns(
      unique.flatMap((e) =>
        e.dst.trim() === "" ? [] : [{ key: e.entry_id, text: e.dst, case_sensitive: e.case_sensitive }],
      ),
    ),
  };
}

export function matchGlossarySource(compiled, item) {
  const parts = [
    { field: "src", text: String(item.src ?? "") },
    ...(item.name_src ? [{ field: "name_src", text: String(item.name_src) }] : []),
  ];
  const fieldsByEntryId = new Map();
  for (const part of parts) {
    const source_field = part.field;
    const target_field = part.field === "src" ? "dst" : "name_dst";
    compiled.source_matcher.scanKeys(part.text, (entry_id) => {
      const fields = fieldsByEntryId.get(entry_id) ?? [];
      fields.push({ source_field, target_field });
      fieldsByEntryId.set(entry_id, fields);
    });
  }
  return compiled.entries.flatMap((entry) => {
    const fields = fieldsByEntryId.get(entry.entry_id);
    return fields === undefined ? [] : [{ entry, fields }];
  });
}

export function evaluateGlossaryApplications(compiled, sourceMatches, item) {
  const dstParts = [
    { field: "dst", text: String(item.dst ?? "") },
    ...(item.name_dst ? [{ field: "name_dst", text: String(item.name_dst) }] : []),
  ];
  const matchedIdsByField = new Map();
  for (const part of dstParts) {
    const ids = new Set();
    compiled.target_matcher.scanKeys(part.text, (key) => ids.add(key));
    matchedIdsByField.set(part.field, ids);
  }
  return sourceMatches.flatMap(({ entry, fields }) => {
    if (entry.dst.trim() === "") return [];
    return [
      {
        entry_id: entry.entry_id,
        src: entry.src,
        dst: entry.dst,
        case_sensitive: entry.case_sensitive,
        fields: fields.map(({ source_field, target_field }) => ({
          source_field,
          target_field,
          applied: matchedIdsByField.get(target_field)?.has(entry.entry_id) ?? false,
        })),
      },
    ];
  });
}

function readProofreadingAnalysis(analysis, mappings) {
  return {
    segments: analysis.segments.map((v) => restoreTextResourceReferences(v, mappings)),
    unpreserved_text: analysis.unpreserved_text,
  };
}

function collectNonBlankSegmentsByLine(lines) {
  return lines.flatMap((line, line_index) =>
    line.segments.filter((v) => v.trim() !== "").map((value) => ({ line_index, value })),
  );
}

function comparePreservedSegments(pair) {
  const source = collectNonBlankSegmentsByLine(pair.source_analysis);
  const translation = collectNonBlankSegmentsByLine(pair.translation_analysis);
  const source_fragments = new Set();
  const translation_fragments = new Set();
  for (let i = 0; i < Math.max(source.length, translation.length); i += 1) {
    const left = source[i];
    const right = translation[i];
    if (left?.line_index === right?.line_index && left?.value === right?.value) continue;
    if (left !== undefined) source_fragments.add(left.value);
    if (right !== undefined) translation_fragments.add(right.value);
  }
  return source_fragments.size === 0 && translation_fragments.size === 0
    ? null
    : {
        code: "TEXT_PRESERVE",
        target_field: pair.target_field,
        source_fragments: [...source_fragments],
        translation_fragments: [...translation_fragments],
      };
}

function evaluateTextPair(pair, { source_language, target_language }) {
  const warnings = [];
  const naturalSrc = pair.source_analysis.map((l) => l.unpreserved_text).join("\n");
  const naturalDst = pair.translation_analysis.map((l) => l.unpreserved_text).join("\n");
  const fragments = collectForeignResidueFragments({ text: naturalDst, targetLanguage: target_language });
  if (fragments.length > 0) {
    warnings.push({ code: "FOREIGN_CHAR_RESIDUE", target_field: pair.target_field, fragments });
  }
  const preserveWarning = comparePreservedSegments(pair);
  if (preserveWarning !== null) warnings.push(preserveWarning);
  if (hasPunctuationStructureMismatch({ src: naturalSrc, dst: naturalDst })) {
    warnings.push({ code: "PUNCTUATION_MISMATCH", target_field: pair.target_field });
  }
  if (
    pair.target_field === "dst" &&
    hasTranslationSimilarityIssue({
      src: naturalSrc,
      dst: naturalDst,
      sourceLanguage: source_language,
      targetLanguage: target_language,
      has_foreign_residue: fragments.length > 0,
    })
  ) {
    warnings.push({ code: "SIMILARITY", target_field: "dst" });
  }
  return warnings;
}

export function buildProofreadingContext(quality) {
  const glossaryEnabled = quality?.glossary?.enabled !== false;
  const preEnabled = quality?.pre_replacement?.enabled === true;
  const preEntries = quality?.pre_replacement?.entries ?? [];
  return {
    glossary: compileGlossary(glossaryEnabled ? (quality?.glossary?.entries ?? []) : []),
    pre_replacements: preEnabled && preEntries.length > 0 ? compileTextReplacements(preEntries) : null,
    text_preserve_mode: quality?.text_preserve?.mode ?? "smart",
    text_preserve_entries: quality?.text_preserve?.entries ?? [],
    rule_cache: new Map(),
  };
}

export function evaluateProofreadingItem(item, context, { source_language = "JA", target_language = "ZH" } = {}) {
  const dst = String(item.dst ?? "");
  const nameDst = String(item.name_dst ?? "");
  if (PROOFREADING_SKIPPED_STATUSES.has(item.status) || (dst === "" && nameDst === "")) {
    return { warnings: [], glossary_applications: [] };
  }

  const text_type = resolveTextRuleType(item);
  const cacheKey = `${text_type}:${context.text_preserve_mode}`;
  let sampleRule = context.rule_cache.get(cacheKey);
  if (!sampleRule) {
    sampleRule = buildTextPreserveRule({
      mode: context.text_preserve_mode,
      text_type,
      entries: context.text_preserve_entries,
    });
    context.rule_cache.set(cacheKey, sampleRule);
  }

  const prepared = prepareTranslationSource({
    src: item.src,
    name_src: item.name_src || null,
    text_type,
    preserve_rule: sampleRule,
    pre_replacements: context.pre_replacements,
    start_ordinal: 0,
  });

  const warnings = [];
  if (dst !== "") {
    const translation = projectTextResourceReferences(dst);
    const source_analysis = prepared.prepared_lines.some((l) => /[\r\n]/u.test(l.prepared_text))
      ? splitTextLines(prepared.prepared_lines.map((l) => l.prepared_text).join("\n")).map((l) =>
          sampleRule.analyze(l),
        )
      : prepared.prepared_lines.map((l) => l.preserve_analysis);

    warnings.push(
      ...evaluateTextPair(
        {
          target_field: "dst",
          source_analysis: source_analysis.map((a) => readProofreadingAnalysis(a, prepared.body.mappings)),
          translation_analysis: splitTextLines(translation.text).map((l) =>
            readProofreadingAnalysis(sampleRule.analyze(l), translation.mappings),
          ),
        },
        { source_language, target_language },
      ),
    );
    if (splitTextLines(item.src).length !== splitTextLines(dst).length) {
      warnings.push({ code: "LINE_COUNT_MISMATCH", target_field: "dst" });
    }
  }

  if (nameDst !== "") {
    const translation = projectTextResourceReferences(nameDst);
    warnings.push(
      ...evaluateTextPair(
        {
          target_field: "name_dst",
          source_analysis: [
            readProofreadingAnalysis(sampleRule.analyze(prepared.name?.text ?? ""), prepared.name?.mappings ?? []),
          ],
          translation_analysis: [
            readProofreadingAnalysis(sampleRule.analyze(translation.text), translation.mappings),
          ],
        },
        { source_language, target_language },
      ),
    );
  }

  const glossary_applications = evaluateGlossaryApplications(
    context.glossary,
    matchGlossarySource(context.glossary, item),
    item,
  );

  for (const target_field of ["dst", "name_dst"]) {
    if (
      glossary_applications.some((app) =>
        app.fields.some((f) => f.target_field === target_field && !f.applied),
      )
    ) {
      warnings.push({ code: "GLOSSARY", target_field });
    }
  }

  warnings.sort(
    (a, b) => PROOFREADING_WARNING_CODES.indexOf(a.code) - PROOFREADING_WARNING_CODES.indexOf(b.code),
  );
  return { warnings, glossary_applications };
}
