import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..");

export function resolveApiConfig(projectDir) {
  // 1. Environment variables take highest priority (handy for tests & CI)
  if (process.env.LG_API_BASE_URL && process.env.LG_API_MODEL) {
    return normalizeConfig({
      api_format: process.env.LG_API_FORMAT || "openai",
      base_url: process.env.LG_API_BASE_URL,
      api_key: process.env.LG_API_KEY || "EMPTY",
      model: process.env.LG_API_MODEL,
      concurrency: Number(process.env.LG_API_CONCURRENCY || 4),
      batch_size: Number(process.env.LG_API_BATCH_SIZE || 20),
      timeout_seconds: Number(process.env.LG_API_TIMEOUT_SECONDS || 120),
      temperature: process.env.LG_API_TEMPERATURE !== undefined ? Number(process.env.LG_API_TEMPERATURE) : undefined,
    });
  }

  // 2. Candidate config files: project dir -> plugin root -> user home
  const candidates = [
    projectDir ? path.join(projectDir, "api_config.json") : null,
    path.join(PLUGIN_ROOT, "api_config.json"),
    path.join(PLUGIN_ROOT, "runtime", "api_config.json"),
    path.join(os.homedir(), ".gemini", "config", "linguagacha_api.json"),
  ].filter(Boolean);

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return normalizeConfig(raw, file);
    }
  }

  return null;
}

function normalizeConfig(raw, sourcePath = "env") {
  const profile = raw.profiles && raw.active_profile ? raw.profiles[raw.active_profile] : raw;
  if (!profile || !profile.base_url || !profile.model) {
    throw new Error(`API 配置文件缺少 base_url 或 model 字段: ${sourcePath}`);
  }
  const apiKey = String(profile.api_key ?? "").trim();
  if (
    apiKey === "" ||
    apiKey.startsWith("YOUR_") ||
    apiKey === "sk-xxxx" ||
    apiKey === "请填入你的API密钥"
  ) {
    throw new Error(`API 配置文件尚未填入真实 api_key: ${sourcePath}`);
  }
  return {
    source_path: sourcePath,
    api_format: String(profile.api_format ?? "openai").toLowerCase(),
    base_url: String(profile.base_url).replace(/\/+$/u, ""),
    api_key: apiKey,
    model: String(profile.model),
    concurrency: Math.max(1, Math.min(32, Math.trunc(Number(profile.concurrency ?? 4)))),
    batch_size: Math.max(1, Math.min(100, Math.trunc(Number(profile.batch_size ?? 20)))),
    max_retries: Math.max(0, Math.min(5, Math.trunc(Number(profile.max_retries ?? 2)))),
    timeout_ms: Math.max(5000, Math.trunc(Number(profile.timeout_seconds ?? 120) * 1000)),
    temperature: typeof profile.temperature === "number" ? profile.temperature : undefined,
    prompt_enhancement_enable: Boolean(profile.prompt_enhancement_enable ?? false),
  };
}

export async function sendChatRequest(config, messages, { signal } = {}) {
  const format = config.api_format;
  const timeoutSignal = AbortSignal.timeout(config.timeout_ms);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  if (format === "gemini" || format === "google") {
    return sendGeminiRequest(config, messages, combinedSignal);
  }
  if (format === "anthropic" || format === "claude") {
    return sendAnthropicRequest(config, messages, combinedSignal);
  }
  return sendOpenAICompatibleRequest(config, messages, combinedSignal);
}

async function sendOpenAICompatibleRequest(config, messages, signal) {
  const url = config.base_url.endsWith("/chat/completions")
    ? config.base_url
    : `${config.base_url}/chat/completions`;

  const body = {
    model: config.model,
    messages: messages.map((m) => ({
      role: m.role,
      content: normalizeOpenAIContent(m.content),
    })),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from OpenAI-compatible API: ${text.slice(0, 400)}`);
  }

  const json = JSON.parse(text);
  const choice = json.choices?.[0]?.message ?? {};
  const contentText = typeof choice.content === "string" ? choice.content : "";
  const reasoningText =
    typeof choice.reasoning_content === "string"
      ? choice.reasoning_content
      : typeof choice.reasoning === "string"
        ? choice.reasoning
        : "";

  const usage = json.usage ?? {};
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  const reasoningTokens = Number(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
  );
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);

  return {
    text: contentText,
    thinking: reasoningText,
    usage: {
      input_tokens: inputTokens,
      reasoning_tokens: reasoningTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  };
}

function normalizeOpenAIContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${part.mime_type};base64,${part.data}` },
      };
    }
    return { type: "text", text: JSON.stringify(part) };
  });
}

async function sendAnthropicRequest(config, messages, signal) {
  const url = config.base_url.endsWith("/messages")
    ? config.base_url
    : `${config.base_url}/messages`;

  const systemParts = messages.filter((m) => m.role === "system").map((m) => String(m.content));
  const userMsgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

  const body = {
    model: config.model,
    max_tokens: 8192,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: userMsgs,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.api_key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Anthropic API: ${text.slice(0, 400)}`);
  }

  const json = JSON.parse(text);
  const blocks = Array.isArray(json.content) ? json.content : [];
  const outText = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const thinkingText = blocks
    .filter((b) => b.type === "thinking")
    .map((b) => b.thinking)
    .join("");
  const inTok = Number(json.usage?.input_tokens ?? 0);
  const outTok = Number(json.usage?.output_tokens ?? 0);

  return {
    text: outText,
    thinking: thinkingText,
    usage: {
      input_tokens: inTok,
      reasoning_tokens: 0,
      output_tokens: outTok,
      total_tokens: inTok + outTok,
    },
  };
}

async function sendGeminiRequest(config, messages, signal) {
  const base = config.base_url.includes("/models/")
    ? config.base_url
    : `${config.base_url}/models/${encodeURIComponent(config.model)}:generateContent`;
  const sep = base.includes("?") ? "&" : "?";
  const url = `${base}${sep}key=${encodeURIComponent(config.api_key)}`;

  const systemParts = messages.filter((m) => m.role === "system").map((m) => ({ text: String(m.content) }));
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts:
        typeof m.content === "string"
          ? [{ text: m.content }]
          : m.content.map((p) =>
              p.type === "text"
                ? { text: p.text }
                : { inlineData: { mimeType: p.mime_type, data: p.data } },
            ),
    }));

  const body = {
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
    ...(config.temperature !== undefined
      ? { generationConfig: { temperature: config.temperature } }
      : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Gemini API: ${text.slice(0, 400)}`);
  }

  const json = JSON.parse(text);
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const outText = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const thoughtText = parts
    .filter((p) => p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  const meta = json.usageMetadata ?? {};
  const inTok = Number(meta.promptTokenCount ?? 0);
  const outTok = Number(meta.candidatesTokenCount ?? 0);
  const rTok = Number(meta.thoughtsTokenCount ?? 0);
  const totTok = Number(meta.totalTokenCount ?? inTok + outTok + rTok);

  return {
    text: outText,
    thinking: thoughtText,
    usage: {
      input_tokens: inTok,
      reasoning_tokens: rTok,
      output_tokens: outTok,
      total_tokens: totTok,
    },
  };
}
