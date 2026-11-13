import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BOOTSTRAP_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "..", "sdk", "bootstrap.mjs"),
).href;

const INLINE_OUTPUT_MAX_BYTES = 32 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 3600;

function readProcessOutput(workspacePath, relPath) {
  const fullPath = path.join(workspacePath, relPath);
  if (!fs.existsSync(fullPath)) {
    return { path: relPath, bytes: 0, content: "" };
  }
  const bytes = fs.statSync(fullPath).size;
  if (bytes > INLINE_OUTPUT_MAX_BYTES) {
    return { path: relPath, bytes, message: "输出超长，请按需读取记录文件。" };
  }
  const text = fs.readFileSync(fullPath, "utf8");
  let content = text;
  if (text.trim() !== "") {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        content = parsed;
      }
    } catch {
      // Keep plain text output
    }
  }
  return { path: relPath, bytes, content };
}

export async function runWorkspaceScript({
  store,
  script,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
}) {
  if (typeof script !== "string" || script.trim() === "") {
    throw new Error("workspace_run requires a non-empty JavaScript ESM script string.");
  }

  const clampedSeconds = Math.min(
    MAX_TIMEOUT_SECONDS,
    Math.max(MIN_TIMEOUT_SECONDS, Math.trunc(timeoutSeconds || DEFAULT_TIMEOUT_SECONDS)),
  );
  const timeoutMs = clampedSeconds * 1000;

  store.ensureSnapshot();

  const workspacePath = store.workspacePath;
  const runId = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const scriptRelPath = `.run/${runId}.mjs`;
  const stdoutRelPath = `.run/${runId}.stdout.log`;
  const stderrRelPath = `.run/${runId}.stderr.log`;

  const scriptFullPath = path.join(workspacePath, scriptRelPath);
  const stdoutFullPath = path.join(workspacePath, stdoutRelPath);
  const stderrFullPath = path.join(workspacePath, stderrRelPath);

  fs.mkdirSync(path.dirname(scriptFullPath), { recursive: true });
  fs.writeFileSync(scriptFullPath, script, "utf8");
  fs.writeFileSync(stdoutFullPath, "", "utf8");
  fs.writeFileSync(stderrFullPath, "", "utf8");

  const stdoutFd = fs.openSync(stdoutFullPath, "a");
  const stderrFd = fs.openSync(stderrFullPath, "a");

  const emittedImages = [];
  const fontsDir = path.join(store.storageDir, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });

  const childEnv = { ...process.env, LG_WORKSPACE_ENTRY: "1" };
  delete childEnv.NODE_OPTIONS;

  let timedOut = false;
  try {
    const procResult = await new Promise((resolve, reject) => {
      const child = fork(scriptFullPath, [], {
        execPath: process.execPath,
        execArgv: [
          "--preserve-symlinks",
          "--preserve-symlinks-main",
          "--import",
          BOOTSTRAP_URL,
        ],
        cwd: workspacePath,
        env: childEnv,
        windowsHide: true,
        stdio: ["ignore", stdoutFd, stderrFd, "ipc"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const sendReply = (id, result) => {
        if (child.connected) {
          child.send({ type: "response", id, result });
        }
      };

      child.on("message", async (msg) => {
        if (!msg || msg.type !== "request") return;
        const { id, request } = msg;
        try {
          let value = null;
          if (request.kind === "inspect_sources") {
            value = store.inspectSources(request.source_paths);
          } else if (request.kind === "get_output_paths") {
            value = store.getOutputPaths(request.directory);
          } else if (request.kind === "generate_files") {
            value = store.generateFiles(request.bilingual_files ?? []);
          } else if (request.kind === "doing") {
            value = null;
          } else if (request.kind === "emit_image") {
            const imgPath = path.resolve(workspacePath, String(request.path ?? ""));
            if (!fs.existsSync(imgPath) || !fs.statSync(imgPath).isFile()) {
              throw new Error(`emitImage target does not exist: ${request.path}`);
            }
            const ext = path.extname(imgPath).toLowerCase();
            const mimeMap = {
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".gif": "image/gif",
              ".webp": "image/webp",
              ".svg": "image/svg+xml",
            };
            const mimeType = mimeMap[ext];
            if (!mimeType) throw new Error(`Unsupported image extension: ${ext}`);
            emittedImages.push({
              path: String(request.path),
              mimeType,
              data: fs.readFileSync(imgPath).toString("base64"),
            });
            value = null;
          } else {
            throw new Error(`Unsupported workspace host request: ${request.kind}`);
          }
          sendReply(id, { ok: true, value });
        } catch (err) {
          sendReply(id, {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.once("close", (exitCode, exitSignal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal: exitSignal ?? null });
      });

      child.send({
        type: "start",
        userSkillDirectory: store.userSkillDir,
        fontsDirectory: fontsDir,
      });
    });

    const execution = {
      scriptPath: scriptRelPath,
      exitCode: procResult.exitCode,
      signal: procResult.signal,
      ...(timedOut ? { timedOut: true } : {}),
      stdout: readProcessOutput(workspacePath, stdoutRelPath),
      stderr: readProcessOutput(workspacePath, stderrRelPath),
      ...(emittedImages.length > 0
        ? { images: emittedImages.map((img) => ({ path: img.path, mimeType: img.mimeType })) }
        : {}),
    };

    return { execution, emittedImages };
  } finally {
    try {
      fs.closeSync(stdoutFd);
    } catch {}
    try {
      fs.closeSync(stderrFd);
    } catch {}
  }
}
