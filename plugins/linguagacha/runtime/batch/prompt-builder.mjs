import fs from "node:fs";
import path from "node:path";
import { normalizeLanguageCode } from "../core/language.mjs";
import { splitTextLines } from "../core/text-rules.mjs";

const PRESETS_ROOT = path.resolve(import.meta.dirname, "..", "..", "presets");

const LANGUAGE_NAMES_ZH = Object.freeze({
  ZH: "简体中文",
  "ZH-HANT": "繁体中文",
  EN: "英文",
  JA: "日文",
  KO: "韩文",
  RU: "俄文",
  AR: "阿拉伯文",
  DE: "德文",
  FR: "法文",
  PL: "波兰文",
  ES: "西班牙文",
  IT: "意大利文",
  PT: "葡萄牙文",
  HU: "匈牙利文",
  TR: "土耳其文",
  TH: "泰文",
  ID: "印尼文",
  VI: "越南文",
});

const PROMPT_BUILDER_TEXT = Object.freeze({
  zh: {
    source: "原文",
    control_character_samples: "控制字符示例（原样保留）：",
    glossary_header: "术语表（根据语境与术语说明采用）<术语原文> -> <术语译文> #<术语说明>:",
    input: "输入（逐条翻译，保留条内换行）：",
    preceding_context: "参考前文（仅供参考）：",
    following_context: "参考后文（仅供参考）：",
  },
});

export function buildTranslationOutputFormat(mode = "text") {
  if (mode === "actor_text") {
    return '```jsonline\n{"id":<ID>,"actor":"<姓名译文或null>","text":"<正文译文>"}\n```';
  }
  return '```jsonline\n{"id":<ID>,"text":"<译文文本>"}\n```';
}

export function formatGlossaryEntry(entry, separator = " -> ") {
  const base = `${entry.src}${separator}${entry.dst}`;
  const info = typeof entry.info === "string" ? entry.info.trim() : "";
  return info === "" ? base : `${base} #${info}`;
}

const templateCache = new Map();

function readPromptTemplate(fileName, lang = "zh") {
  const fullPath = path.join(PRESETS_ROOT, "translation_prompt", "template", lang, fileName);
  const cached = templateCache.get(fullPath);
  if (cached !== undefined) return cached;
  const text = fs.readFileSync(fullPath, "utf8").trim();
  templateCache.set(fullPath, text);
  return text;
}

export class PromptBuilder {
  constructor({
    sourceLanguage = "JA",
    targetLanguage = "ZH",
    customPrompt = null,
    promptEnhancementEnable = false,
    activatedGlossaryEntries = [],
  } = {}) {
    this.sourceLanguage = normalizeLanguageCode(sourceLanguage) ?? "JA";
    this.targetLanguage = normalizeLanguageCode(targetLanguage) ?? "ZH";
    this.customPrompt = typeof customPrompt === "string" && customPrompt.trim() !== "" ? customPrompt.trim() : null;
    this.promptEnhancementEnable = Boolean(promptEnhancementEnable);
    this.activatedGlossaryEntries = activatedGlossaryEntries;
  }

  buildMain(mode = "text") {
    const prefix = readPromptTemplate("prefix.txt", "zh");
    const base = this.customPrompt ?? readPromptTemplate("base.txt", "zh");
    const enhancement = this.promptEnhancementEnable ? readPromptTemplate("thinking.txt", "zh") : "";
    const suffix = readPromptTemplate("suffix.txt", "zh");

    const sections = [`${prefix}\n${base}`];
    if (enhancement !== "") sections.push(enhancement);
    sections.push(suffix);

    const srcName =
      this.sourceLanguage === "ALL"
        ? PROMPT_BUILDER_TEXT.zh.source
        : (LANGUAGE_NAMES_ZH[this.sourceLanguage] ?? PROMPT_BUILDER_TEXT.zh.source);
    const dstName = LANGUAGE_NAMES_ZH[this.targetLanguage] ?? "简体中文";

    return sections
      .join("\n\n")
      .replaceAll("{source_language}", srcName)
      .replaceAll("{target_language}", dstName)
      .replaceAll("{translation_output_format}", buildTranslationOutputFormat(mode));
  }

  generatePrompt({
    items,
    mode = "text",
    samples = [],
    precedings = [],
    followings = [],
  }) {
    const systemText = this.buildMain(mode);
    const sections = [];

    if (precedings.length > 0) {
      const lines = precedings.map((it) => String(it.src ?? "").trim().replaceAll("\n", "\\n"));
      sections.push(`${PROMPT_BUILDER_TEXT.zh.preceding_context}\n${lines.join("\n")}`);
    }
    if (followings.length > 0) {
      const lines = followings.map((it) => String(it.src ?? "").trim().replaceAll("\n", "\\n"));
      sections.push(`${PROMPT_BUILDER_TEXT.zh.following_context}\n${lines.join("\n")}`);
    }
    if (this.activatedGlossaryEntries.length > 0) {
      const gLines = this.activatedGlossaryEntries.map((e) => formatGlossaryEntry(e, " -> "));
      sections.push(`${PROMPT_BUILDER_TEXT.zh.glossary_header}\n${gLines.join("\n")}`);
    }
    const uniqueSamples = [...new Set(samples.map((s) => String(s).trim()).filter(Boolean))];
    if (uniqueSamples.length > 0) {
      sections.push(`${PROMPT_BUILDER_TEXT.zh.control_character_samples}\n${uniqueSamples.join(", ")}`);
    }

    const inputJsonl = items
      .map((item) =>
        JSON.stringify({
          id: item.request_id,
          ...(mode === "actor_text" ? { actor: item.actor_src ?? null } : {}),
          text: item.text_src,
        }),
      )
      .join("\n");

    sections.push(`${PROMPT_BUILDER_TEXT.zh.input}\n\`\`\`jsonline\n${inputJsonl}\n\`\`\``);

    return {
      messages: [
        { role: "system", content: systemText },
        { role: "user", content: sections.join("\n\n") },
      ],
    };
  }

  generatePromptSakura(srcText) {
    const glossaryLines = this.activatedGlossaryEntries.map((e) => formatGlossaryEntry(e, "->"));
    const userContent =
      glossaryLines.length > 0
        ? `根据以下术语表（可以为空）：\n${glossaryLines.join("\n")}\n将下面的日文文本根据对应关系和备注翻译成中文：\n${srcText}`
        : `将下面的日文文本翻译成中文：\n${srcText}`;

    return {
      messages: [
        {
          role: "system",
          content:
            "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。",
        },
        { role: "user", content: userContent },
      ],
    };
  }
}

const WHY_OPEN_RE = /^\s*<why>/i;
const WHY_CLOSE_RE = /<\/why>/i;

export function splitTranslationResponse(response) {
  let text = String(response ?? "");
  const analysis = [];
  let m;
  while ((m = WHY_OPEN_RE.exec(text)) !== null) {
    const rest = text.slice(m[0].length);
    const close = WHY_CLOSE_RE.exec(rest);
    if (!close) {
      analysis.push(rest.trim());
      text = "";
      break;
    }
    analysis.push(rest.slice(0, close.index).trim());
    text = rest.slice(close.index + close[0].length);
  }
  return {
    rule_analysis_text: analysis.filter(Boolean).join("\n"),
    translation_text: text,
  };
}

function tryRepairJsonObject(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Strip trailing comma if model emitted `{"id":0,"text":"..."},`
    const noTrailingComma = trimmed.replace(/,\s*$/u, "");
    try {
      const parsed = JSON.parse(noTrailingComma);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function parseRequestId(val) {
  if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0) return val;
  if (typeof val === "string" && /^\d+$/u.test(val)) {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function decodeTranslationResponse(rawResponse, mode = "text") {
  const { translation_text } = splitTranslationResponse(rawResponse);
  const decoded = [];

  for (const line of splitTextLines(translation_text)) {
    const s = line.trim();
    if (s === "" || s.startsWith("```")) continue;
    const obj = tryRepairJsonObject(s);
    if (!obj) continue;
    const reqId = parseRequestId(obj.id);
    if (reqId === null || typeof obj.text !== "string") continue;
    if (mode === "text") {
      decoded.push({ request_id: reqId, text_dst: obj.text, actor_dst: null });
    } else if (obj.actor === undefined || obj.actor === null || typeof obj.actor === "string") {
      const actorVal = typeof obj.actor === "string" && obj.actor.trim() !== "" ? obj.actor : null;
      decoded.push({ request_id: reqId, text_dst: obj.text, actor_dst: actorVal });
    }
  }

  if (decoded.length > 0) return decoded;
  const single = tryRepairJsonObject(translation_text);
  if (single) {
    const reqId = parseRequestId(single.id);
    if (reqId !== null && typeof single.text === "string") {
      return [
        {
          request_id: reqId,
          text_dst: single.text,
          actor_dst: typeof single.actor === "string" ? single.actor : null,
        },
      ];
    }
  }
  return [];
}

export function decodeSakuraResponse(response, requestItems) {
  if (requestItems.length === 1) {
    return response.trim() === ""
      ? []
      : [{ request_id: requestItems[0].request_id, text_dst: response, actor_dst: null }];
  }
  const lines = splitTextLines(response);
  const decoded = [];
  let offset = 0;
  for (const item of requestItems) {
    const end = offset + splitTextLines(item.text_src).length;
    const textDst = lines.slice(offset, end).join("\n");
    offset = end;
    if (textDst.trim() !== "") {
      decoded.push({ request_id: item.request_id, text_dst: textDst, actor_dst: null });
    }
  }
  return offset === lines.length ? decoded : [];
}
