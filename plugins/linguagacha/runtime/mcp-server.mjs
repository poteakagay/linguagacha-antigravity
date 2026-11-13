import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  executeBatchItemTranslation,
  executeBatchLlmRequest,
} from "./batch/batch-translator.mjs";
import { ITEM_STATUSES } from "./workspace/contract.mjs";
import { ProjectStore } from "./workspace/project-store.mjs";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  runWorkspaceScript,
} from "./workspace/runner.mjs";

register("./sdk/loader-hooks.mjs", import.meta.url);

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const BUILTIN_SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

let activeStore = null;

function requireActiveStore() {
  if (!activeStore) {
    const fallbackDir = process.env.LG_DEFAULT_PROJECT_DIR || process.cwd();
    activeStore = new ProjectStore(fallbackDir);
  }
  return activeStore;
}

function isInsideDir(root, target) {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function executeReadSkill({ name, path: subPath }) {
  if (typeof name !== "string" || name.trim() === "" || /[\\/]/u.test(name) || name.includes("..")) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  const cleanName = name.trim();
  const userSkillRoot = activeStore?.userSkillDir;
  const candidateRoots = [
    userSkillRoot ? path.join(userSkillRoot, cleanName) : null,
    path.join(BUILTIN_SKILLS_DIR, cleanName),
  ].filter(Boolean);

  const skillDir = candidateRoots.find(
    (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
  );
  if (!skillDir) {
    throw new Error(`Skill not found: ${cleanName}`);
  }

  const relFile = subPath && String(subPath).trim() !== "" ? String(subPath).trim() : "SKILL.md";
  const resolvedFile = path.resolve(skillDir, relFile);
  if (!isInsideDir(skillDir, resolvedFile) || !fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
    throw new Error(`Skill file not found: ${cleanName}/${relFile}`);
  }

  const content = fs.readFileSync(resolvedFile, "utf8");
  const baseUrl = pathToFileURL(skillDir + path.sep).href;
  return {
    name: cleanName,
    path: path.relative(skillDir, resolvedFile).replace(/\\/gu, "/"),
    content,
    base_url: baseUrl,
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "workspace_open",
    description: [
      "打开、创建或切换当前翻译工程目录，并同步源语言、目标语言与重复过滤设置。",
      "首次处理用户指定文件夹或小说文件时先调用本工具（传入小说所在文件夹的绝对路径 `project_dir`），随后即可使用 `workspace_run`、`workspace_apply`、`batch_item_translation`。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        project_dir: {
          type: "string",
          description: "翻译工程所在的本机文件夹绝对路径（例如放有小说 EPUB/TXT 的目录）",
        },
        source_language: {
          type: "string",
          description: "源语言代码（如 JA、EN、KO、RU、ZH、ALL），缺省为 JA",
        },
        target_language: {
          type: "string",
          description: "目标语言代码（如 ZH、ZH-HANT、EN、JA），缺省为 ZH",
        },
        duplicate_filter_enabled: {
          type: "boolean",
          description: "是否启用同文件重复原文自动去重联动（默认 true）",
        },
        name: {
          type: "string",
          description: "可选工程显示名称，用于生成导出目录名",
        },
        reset: {
          type: "boolean",
          description: "是否清空该目录下已有的 .lg_project 工程进度重新开始（默认 false，谨慎使用）",
        },
      },
      required: ["project_dir"],
      additionalProperties: false,
    },
  },
  {
    name: "read_skill",
    description: [
      "读取内置或用户技能文档（SKILL.md）及技能目录内的参考文件，返回 `content` 与带尾斜杠的 `base_url`。",
      "在 `workspace_run` 中可通过 `await import(new URL('scripts/xxx.mjs', base_url).href)` 直接调用技能自带的 `.mjs` 脚本。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名称，如 agent-charter、project-operation、translation、glossary、epub、proofreading 等",
        },
        path: {
          type: "string",
          description: "技能目录内相对路径，省略时默认读取 SKILL.md",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_run",
    description: [
      "在工程工作区运行完整 JavaScript ESM 脚本（支持顶层 await），读取工程数据快照、调用 `@lg/*` SDK 处理文件并准备 `changes/` 变更清单。执行前自动刷新过期的工程快照。",
      "- 当前工作目录（`cwd`）为工作区根目录，全局注入 `ws`（含 `ws.contract`、`ws.userSkillDirectory`、`ws.fontsDirectory`、`ws.setDoing`、`ws.emitImage`）。",
      "- 内置模块：`@lg/project`（`inspectSources`、`getOutputPaths`、`generateFiles`）、`@lg/project/item-contexts`（`queryItemContexts`）、`@lg/utils/literal-matcher`、`jszip`、`chardet`、`iconv-lite`。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "要执行的完整 JavaScript ESM 源码，可使用顶层 await，全局 ws 无需导入",
        },
        timeout_seconds: {
          type: "integer",
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_SECONDS,
          description: `执行时限秒数，省略时为 ${DEFAULT_TIMEOUT_SECONDS}`,
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "workspace_apply",
    description: [
      "把工作区 `changes/` 中的全部变更清单作为一个批次原子提交到工程：",
      "- 内容批次：条目（items）、提示词（prompts）、质量规则（glossary / text_preserve / pre_replacement / post_replacement）和工程知识（knowledge）。",
      "- 文件批次：`changes/files/`（creates / updates / deletes），不能与其他变更混提。",
      "返回回执 `{ status: 'applied' | 'partial' | 'rejected' | 'unchanged', applied, rejected, destroyed, revisions }`。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "batch_item_translation",
    description: [
      "调用外部配置的 LLM API 并发批量翻译当前工程的 `items`，自动注入术语表、前后文与控制符保护，翻译结果直接提交到工程并自动维护同文去重状态。",
      "至少提供 `item_ids` 或 `item_statuses` 之一。若用户未配置外部 `api_config.json`，可改用 `workspace_run` + `workspace_apply` 在当前对话内直接精翻提交。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        item_ids: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          description: "目标条目的 item_id 列表",
        },
        item_statuses: {
          type: "array",
          items: { type: "string", enum: [...ITEM_STATUSES] },
          description: "目标条目的状态筛选列表（如 ['NONE']）",
        },
        thinking_downgrade: {
          type: "boolean",
          description: "默认 true，降低模型思考等级",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "batch_llm_request",
    description: [
      "并发执行工作区清单中的独立 LLM 请求（`{\"format\":\"messages\",\"requests\":[{\"id\":\"001\",\"input_file\":\"inputs/001.json\"}]}`），结果保存到工作区并返回 `result_file` 索引路径。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        model_usage: {
          type: "string",
          enum: ["agent", "media"],
          description: "模型用途标识",
        },
        request_file: {
          type: "string",
          description: "请求清单 JSON 文件的工作区相对路径或本机绝对路径",
        },
        thinking_downgrade: {
          type: "boolean",
          description: "默认 true",
        },
      },
      required: ["model_usage", "request_file"],
      additionalProperties: false,
    },
  },
];

async function handleToolCall(name, args = {}) {
  switch (name) {
    case "workspace_open": {
      if (typeof args.project_dir !== "string" || args.project_dir.trim() === "") {
        throw new Error("workspace_open requires a non-empty project_dir string.");
      }
      activeStore = new ProjectStore(args.project_dir, {
        sourceLanguage: args.source_language,
        targetLanguage: args.target_language,
        duplicateFilterEnabled: args.duplicate_filter_enabled,
        name: args.name,
        reset: Boolean(args.reset),
      });
      activeStore.ensureSnapshot();
      return {
        content: [{ type: "text", text: JSON.stringify(activeStore.getSummary(), null, 2) }],
      };
    }

    case "read_skill": {
      const res = executeReadSkill(args);
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    case "workspace_run": {
      const store = requireActiveStore();
      const { execution, emittedImages } = await runWorkspaceScript({
        store,
        script: args.script,
        timeoutSeconds: args.timeout_seconds,
      });
      const content = [{ type: "text", text: JSON.stringify(execution, null, 2) }];
      for (const img of emittedImages) {
        content.push({
          type: "image",
          mimeType: img.mimeType,
          data: img.data,
        });
      }
      return {
        content,
        ...(execution.exitCode !== 0 ? { isError: true } : {}),
      };
    }

    case "workspace_apply": {
      const store = requireActiveStore();
      const receipt = store.applyWorkspace();
      return {
        content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }],
      };
    }

    case "batch_item_translation": {
      const store = requireActiveStore();
      const res = await executeBatchItemTranslation({
        store,
        itemIds: args.item_ids,
        itemStatuses: args.item_statuses,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    case "batch_llm_request": {
      const store = requireActiveStore();
      const res = await executeBatchLlmRequest({
        store,
        requestFile: args.request_file,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

let framingMode = "newline";

function sendJsonRpc(payload) {
  const json = JSON.stringify(payload);
  if (framingMode === "content-length") {
    const byteLen = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function dispatchJsonRpcMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  // Notifications have no id
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === "initialize") {
      const clientProto = params?.protocolVersion;
      const supportedVersions = ["2025-03-26", "2024-11-05"];
      const negotiated = supportedVersions.includes(clientProto) ? clientProto : "2024-11-05";
      sendJsonRpc({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "linguagacha",
            version: "0.141.2",
          },
        },
      });
      return;
    }

    if (method === "ping") {
      sendJsonRpc({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      sendJsonRpc({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOL_DEFINITIONS,
        },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        sendJsonRpc({ jsonrpc: "2.0", id, result });
      } catch (toolErr) {
        sendJsonRpc({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: toolErr instanceof Error ? toolErr.message : String(toolErr),
              },
            ],
          },
        });
      }
      return;
    }

    if (method === "resources/list") {
      sendJsonRpc({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    }

    if (method === "prompts/list") {
      sendJsonRpc({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    }

    sendJsonRpc({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  } catch (err) {
    sendJsonRpc({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

// Dual-framing Stdio reader: supports MCP standard newline-delimited JSON-RPC AND Content-Length headers
let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  drainInputBuffer();
});

function drainInputBuffer() {
  while (inputBuffer.length > 0) {
    // Skip leading CR/LF whitespace between frames
    let trimIdx = 0;
    while (trimIdx < inputBuffer.length && (inputBuffer[trimIdx] === 0x0d || inputBuffer[trimIdx] === 0x0a)) {
      trimIdx += 1;
    }
    if (trimIdx > 0) {
      inputBuffer = inputBuffer.subarray(trimIdx);
    }
    if (inputBuffer.length === 0) break;

    const headAscii = inputBuffer.subarray(0, Math.min(32, inputBuffer.length)).toString("ascii");
    if (/^Content-Length:/iu.test(headAscii)) {
      framingMode = "content-length";
      const headerEnd = inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const headerStr = inputBuffer.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/iu.exec(headerStr);
      if (!m) {
        inputBuffer = inputBuffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyLen = Number(m[1]);
      const frameEnd = headerEnd + 4 + bodyLen;
      if (inputBuffer.length < frameEnd) break;
      const bodyStr = inputBuffer.subarray(headerEnd + 4, frameEnd).toString("utf8");
      inputBuffer = inputBuffer.subarray(frameEnd);
      try {
        const parsed = JSON.parse(bodyStr);
        void dispatchJsonRpcMessage(parsed);
      } catch {}
    } else {
      const nlIdx = inputBuffer.indexOf(0x0a);
      if (nlIdx < 0) break;
      const lineStr = inputBuffer.subarray(0, nlIdx).toString("utf8").trim();
      inputBuffer = inputBuffer.subarray(nlIdx + 1);
      if (lineStr === "") continue;
      try {
        const parsed = JSON.parse(lineStr);
        void dispatchJsonRpcMessage(parsed);
      } catch {}
    }
  }
}
