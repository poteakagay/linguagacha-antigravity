import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  applyTextReplacements,
  buildTextPreserveRule,
  compileTextReplacements,
  prepareTranslationSource,
  projectTextResourceReferences,
  resolveTextRuleType,
  restoreTextResourceReferences,
  transformProjectedTextResourceReferences,
} from "../core/text-rules.mjs";
import { compileLiteralPatterns } from "../sdk/literal-matcher.mjs";
import { resolveApiConfig, sendChatRequest } from "./llm-client.mjs";
import {
  PromptBuilder,
  decodeSakuraResponse,
  decodeTranslationResponse,
} from "./prompt-builder.mjs";

const MISSING_CONFIG_HELP = [
  "未检测到外部批量 API 配置（api_config.json）。本工具仅在用户明确选择外部 API 且配置可用时使用。",
  "请按以下规则继续执行：",
  "1. 【反重力原生模型模式（默认）】不超过 200 条（或有不写入工程、额外提示词定制要求）时，由主代理直接通过 workspace_run + workspace_apply 处理；其余超过 200 条的情况，必须按 AGENTS.md 调用 invoke_subagent（TypeName: \"self\"）拆分为独立任务包（仅在各自独立的 work/ 子目录交付结果，禁止写共享 changes/ 与共享种子账本、禁止调 workspace_apply），回收后由主代理统一核对并调用 workspace_apply 提交。",
  "2. 【外部 API 并发模式】仅当用户明确要求使用外部 API 时，引导用户将插件目录下的 runtime/api_config.example.json 复制为工程目录下的 api_config.json（或 plugins/linguagacha/api_config.json），填入密钥后重试。",
].join("\n");

function matchActivatedGlossary(glossaryEntries, chunkTexts) {
  if (!glossaryEntries || glossaryEntries.length === 0) return [];
  const matcher = compileLiteralPatterns(
    glossaryEntries.map((entry, idx) => ({
      key: idx,
      text: entry.src ?? "",
      case_sensitive: Boolean(entry.case_sensitive),
    })),
  );
  const hitIndices = new Set();
  for (const text of chunkTexts) {
    if (!text) continue;
    matcher.scanKeys(text, (idx) => hitIndices.add(idx));
  }
  return glossaryEntries.filter((_, idx) => hitIndices.has(idx));
}

async function runConcurrentPool(tasks, concurrency, workerFn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor++;
      await workerFn(tasks[idx], idx);
    }
  });
  await Promise.all(workers);
}

export async function executeBatchItemTranslation({
  store,
  itemIds,
  itemStatuses,
  signal,
}) {
  if ((!itemIds || itemIds.length === 0) && (!itemStatuses || itemStatuses.length === 0)) {
    throw new Error("batch_item_translation requires at least one of item_ids or item_statuses.");
  }

  const config = resolveApiConfig(store.projectDir);
  if (!config) {
    throw new Error(MISSING_CONFIG_HELP);
  }

  const startTime = Date.now();
  const idSet = itemIds ? new Set(itemIds) : null;
  const statusSet = itemStatuses ? new Set(itemStatuses) : null;

  const fileOrder = new Map(store.state.files.map((f, i) => [f.file_path, i]));
  const orderedAllItems = [...store.state.items].sort(
    (a, b) =>
      (fileOrder.get(a.file_path) ?? 0) - (fileOrder.get(b.file_path) ?? 0) ||
      a.row_number - b.row_number ||
      a.item_id - b.item_id,
  );

  const targetItems = orderedAllItems.filter((it) => {
    if (idSet && !idSet.has(it.item_id)) return false;
    if (statusSet && !statusSet.has(it.status)) return false;
    return true;
  });

  if (targetItems.length === 0) {
    return {
      status: "done",
      items: { total: 0, succeeded: 0, failed: 0, unfinished: 0 },
      usage: {
        elapsed_seconds: 0,
        input_tokens: 0,
        reasoning_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  // Group target items by file into chunks of config.batch_size
  const itemIndexMap = new Map(orderedAllItems.map((it, idx) => [it.item_id, idx]));
  const chunks = [];
  let currentChunk = [];
  let currentFile = null;

  for (const item of targetItems) {
    if (currentFile !== null && item.file_path !== currentFile && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
    currentFile = item.file_path;
    currentChunk.push(item);
    if (currentChunk.length >= config.batch_size) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  const preReplacements =
    store.state.quality.pre_replacement.length > 0
      ? compileTextReplacements(store.state.quality.pre_replacement)
      : null;
  const postReplacements =
    store.state.quality.post_replacement.length > 0
      ? compileTextReplacements(store.state.quality.post_replacement)
      : null;
  const preserveMode = store.state.quality.text_preserve.length > 0 ? "custom" : "smart";
  const preserveEntries = store.state.quality.text_preserve;
  const preserveRuleCache = new Map();

  const getPreserveRule = (item) => {
    const textType = resolveTextRuleType(item);
    let rule = preserveRuleCache.get(textType);
    if (!rule) {
      rule = buildTextPreserveRule({ mode: preserveMode, text_type: textType, entries: preserveEntries });
      preserveRuleCache.set(textType, rule);
    }
    return { textType, rule };
  };

  let succeeded = 0;
  let failed = 0;
  const usageAcc = {
    input_tokens: 0,
    reasoning_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  const addUsage = (u) => {
    if (!u) return;
    usageAcc.input_tokens += u.input_tokens ?? 0;
    usageAcc.reasoning_tokens += u.reasoning_tokens ?? 0;
    usageAcc.output_tokens += u.output_tokens ?? 0;
    usageAcc.total_tokens += u.total_tokens ?? 0;
  };

  const translateSubChunk = async (subItems, attempt = 0) => {
    if (signal?.aborted) return [];

    // Neighbor context (+/- 3 lines in same file)
    const firstGlobalIdx = itemIndexMap.get(subItems[0].item_id) ?? 0;
    const lastGlobalIdx = itemIndexMap.get(subItems[subItems.length - 1].item_id) ?? 0;
    const filePath = subItems[0].file_path;

    const precedings = [];
    for (let i = firstGlobalIdx - 1; i >= 0 && precedings.length < 3; i -= 1) {
      const cand = orderedAllItems[i];
      if (cand.file_path !== filePath) break;
      if ((cand.src ?? "").trim() !== "") precedings.unshift({ src: cand.src });
    }
    const followings = [];
    for (let i = lastGlobalIdx + 1; i < orderedAllItems.length && followings.length < 3; i += 1) {
      const cand = orderedAllItems[i];
      if (cand.file_path !== filePath) break;
      if ((cand.src ?? "").trim() !== "") followings.push({ src: cand.src });
    }

    // Prepare pre-replacement + resource token protection + control character samples
    const hasActor = subItems.some((it) => typeof it.name_src === "string" && it.name_src.trim() !== "");
    const mode = hasActor && config.api_format !== "sakurallm" ? "actor_text" : "text";
    const samples = [];
    const preparedByReqId = new Map();
    const requestItems = [];

    subItems.forEach((it, idx) => {
      const { textType, rule } = getPreserveRule(it);
      const prep = prepareTranslationSource({
        src: it.src ?? "",
        name_src: it.name_src ?? null,
        text_type: textType,
        preserve_rule: rule,
        pre_replacements: preReplacements,
        start_ordinal: 0,
      });
      samples.push(...prep.samples);
      preparedByReqId.set(idx, { item: it, prep });
      requestItems.push({
        request_id: idx,
        text_src: prep.prepared_lines.map((l) => l.prepared_text).join("\n"),
        actor_src: prep.name ? prep.name.text : (it.name_src ?? null),
      });
    });

    const activatedGlossary = matchActivatedGlossary(
      store.state.quality.glossary,
      subItems.flatMap((it) => [it.src ?? "", it.name_src ?? ""]),
    );

    const builder = new PromptBuilder({
      sourceLanguage: store.state.source_language,
      targetLanguage: store.state.target_language,
      customPrompt: store.state.prompts.translation,
      promptEnhancementEnable: config.prompt_enhancement_enable,
      activatedGlossaryEntries: activatedGlossary,
    });

    const built =
      config.api_format === "sakurallm"
        ? builder.generatePromptSakura(requestItems.map((r) => r.text_src).join("\n"))
        : builder.generatePrompt({ items: requestItems, mode, samples, precedings, followings });

    try {
      const llmRes = await sendChatRequest(config, built.messages, { signal });
      addUsage(llmRes.usage);

      const decoded =
        config.api_format === "sakurallm"
          ? decodeSakuraResponse(llmRes.text, requestItems)
          : decodeTranslationResponse(llmRes.text, mode);

      const decodedById = new Map(decoded.map((d) => [d.request_id, d]));
      const patches = [];
      const missingItems = [];

      for (let idx = 0; idx < subItems.length; idx += 1) {
        const hit = decodedById.get(idx);
        const { item, prep } = preparedByReqId.get(idx);
        if (!hit || typeof hit.text_dst !== "string") {
          missingItems.push(item);
          continue;
        }

        // Restore resource tokens and apply post-replacement
        let finalDst = restoreTextResourceReferences(hit.text_dst, prep.body.mappings);
        if (postReplacements) {
          const proj = projectTextResourceReferences(finalDst);
          finalDst = restoreTextResourceReferences(
            transformProjectedTextResourceReferences(proj.text, proj.mappings, (seg) =>
              applyTextReplacements(seg, postReplacements),
            ),
            proj.mappings,
          );
        }

        let finalNameDst = item.name_dst;
        if (mode === "actor_text" && item.name_src) {
          const rawActor = hit.actor_dst ?? item.name_src;
          finalNameDst = prep.name
            ? restoreTextResourceReferences(rawActor, prep.name.mappings)
            : rawActor;
          if (postReplacements && finalNameDst) {
            finalNameDst = applyTextReplacements(finalNameDst, postReplacements);
          }
        }

        patches.push({
          item_id: item.item_id,
          dst: finalDst,
          ...(finalNameDst !== undefined ? { name_dst: finalNameDst } : {}),
          status: "PROCESSED",
        });
      }

      if (patches.length > 0) {
        store.commitBatchTranslations(patches);
        succeeded += patches.length;
      }

      if (missingItems.length > 0) {
        if (attempt < config.max_retries) {
          // Split in half on retry when chunk > 1 for self-healing alignment
          if (missingItems.length > 1) {
            const mid = Math.ceil(missingItems.length / 2);
            await translateSubChunk(missingItems.slice(0, mid), attempt + 1);
            await translateSubChunk(missingItems.slice(mid), attempt + 1);
          } else {
            await translateSubChunk(missingItems, attempt + 1);
          }
        } else {
          failed += missingItems.length;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (attempt < config.max_retries) {
        await translateSubChunk(subItems, attempt + 1);
      } else {
        failed += subItems.length;
      }
    }
  };

  await runConcurrentPool(chunks, config.concurrency, async (chunk) => {
    await translateSubChunk(chunk, 0);
  });

  const elapsedSeconds = Number(((Date.now() - startTime) / 1000).toFixed(2));
  const unfinished = Math.max(0, targetItems.length - succeeded - failed);

  return {
    status: signal?.aborted ? "stopped" : "done",
    ...(signal?.aborted ? { stop_source: "parent" } : {}),
    items: {
      total: targetItems.length,
      succeeded,
      failed,
      unfinished,
    },
    usage: {
      elapsed_seconds: elapsedSeconds,
      ...usageAcc,
    },
  };
}

export async function executeBatchLlmRequest({ store, requestFile, signal }) {
  const config = resolveApiConfig(store.projectDir);
  if (!config) {
    throw new Error(MISSING_CONFIG_HELP);
  }

  const manifestPath = path.isAbsolute(requestFile)
    ? path.resolve(requestFile)
    : path.resolve(store.workspacePath, requestFile);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Request manifest file does not exist: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== "messages" || !Array.isArray(manifest.requests) || manifest.requests.length === 0) {
    throw new Error('Invalid manifest format: expected {"format":"messages","requests":[...]}.');
  }

  const manifestDir = path.dirname(manifestPath);
  const runId = `batch_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const outDir = path.join(store.workspacePath, "work", runId);
  const resultsSubDir = path.join(outDir, "results");
  fs.mkdirSync(resultsSubDir, { recursive: true });

  const startTime = Date.now();
  let succeeded = 0;
  let failed = 0;
  const usageAcc = {
    input_tokens: 0,
    reasoning_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  const resultEntries = [];

  await runConcurrentPool(manifest.requests, config.concurrency, async (reqItem) => {
    if (signal?.aborted) return;
    const reqId = String(reqItem.id);
    const inputPath = path.isAbsolute(reqItem.input_file)
      ? path.resolve(reqItem.input_file)
      : path.resolve(manifestDir, reqItem.input_file);

    const outRel = `results/${encodeURIComponent(reqId)}.json`;
    const outFull = path.join(outDir, outRel);

    try {
      const inputJson = JSON.parse(fs.readFileSync(inputPath, "utf8"));
      if (!Array.isArray(inputJson.messages) || inputJson.messages.length === 0) {
        throw new Error("Input file must contain non-empty messages array.");
      }
      const res = await sendChatRequest(config, inputJson.messages, { signal });
      usageAcc.input_tokens += res.usage.input_tokens;
      usageAcc.reasoning_tokens += res.usage.reasoning_tokens;
      usageAcc.output_tokens += res.usage.output_tokens;
      usageAcc.total_tokens += res.usage.total_tokens;

      fs.writeFileSync(
        outFull,
        JSON.stringify(
          {
            id: reqId,
            status: "succeeded",
            response: { text: res.text, thinking: res.thinking },
            usage: res.usage,
          },
          null,
          2,
        ),
        "utf8",
      );
      resultEntries.push({ id: reqId, status: "succeeded", output_file: outRel });
      succeeded += 1;
    } catch (err) {
      if (signal?.aborted) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      fs.writeFileSync(
        outFull,
        JSON.stringify({ id: reqId, status: "failed", error: errMsg }, null, 2),
        "utf8",
      );
      resultEntries.push({ id: reqId, status: "failed", output_file: outRel, error: errMsg });
      failed += 1;
    }
  });

  const indexFile = path.join(outDir, "index.json");
  fs.writeFileSync(
    indexFile,
    JSON.stringify({ run_id: runId, results: resultEntries }, null, 2),
    "utf8",
  );

  const total = manifest.requests.length;
  const unfinished = Math.max(0, total - succeeded - failed);
  const elapsedSeconds = Number(((Date.now() - startTime) / 1000).toFixed(2));

  return {
    run_id: runId,
    status: signal?.aborted ? "stopped" : "done",
    total,
    succeeded,
    failed,
    unfinished,
    usage: {
      elapsed_seconds: elapsedSeconds,
      ...usageAcc,
      usage_complete: failed === 0 && unfinished === 0,
    },
    result_file: indexFile.replace(/\\/gu, "/"),
  };
}
