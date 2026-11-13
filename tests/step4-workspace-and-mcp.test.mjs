import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  executeBatchItemTranslation,
  executeBatchLlmRequest,
} from "../plugins/linguagacha/runtime/batch/batch-translator.mjs";
import { ProjectStore } from "../plugins/linguagacha/runtime/workspace/project-store.mjs";
import { runWorkspaceScript } from "../plugins/linguagacha/runtime/workspace/runner.mjs";

const MCP_SERVER_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "plugins",
  "linguagacha",
  "runtime",
  "mcp-server.mjs",
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("Step 4.1: workspace_run + @lg/project + workspace_apply transactions (file batch, fp check, duplicate sync, inheritance)", async () => {
  const tmpRoot = makeTempDir("lg_step4_ws_");
  try {
    const sampleTxtPath = path.join(tmpRoot, "chapter1.txt");
    fs.writeFileSync(
      sampleTxtPath,
      [
        "「おはよう、アリス！」",
        "少女は静かに微笑んだ。",
        "「おはよう、アリス！」",
        "12345",
      ].join("\n"),
      "utf8",
    );

    const store = new ProjectStore(tmpRoot, {
      sourceLanguage: "JA",
      targetLanguage: "ZH",
      name: "アリス物語",
    });

    // 1. Run workspace script to inspect source and write changes/files/creates.jsonl
    const { execution: run1 } = await runWorkspaceScript({
      store,
      script: `
        import { readFile, writeFile } from "node:fs/promises";
        import { inspectSources } from "@lg/project";

        const refDoc = await readFile(ws.contract.changes.files.creates.reference, "utf8");
        if (!refDoc.includes("Change_files_creates")) throw new Error("Missing reference doc");

        const inspected = await inspectSources([${JSON.stringify(sampleTxtPath)}]);
        await writeFile(
          ws.contract.changes.files.creates.path,
          JSON.stringify({ source_path: ${JSON.stringify(sampleTxtPath)} }) + "\\n",
          "utf8"
        );
        console.log(JSON.stringify({ inspectedCount: inspected[0].files.length }));
      `,
    });

    assert.equal(run1.exitCode, 0, `run1 stderr: ${JSON.stringify(run1.stderr)}`);
    assert.deepEqual(run1.stdout.content, { inspectedCount: 1 });

    // 2. Apply file batch
    const fileReceipt = store.applyWorkspace();
    assert.equal(fileReceipt.status, "applied");
    assert.equal(fileReceipt.destroyed, true);
    assert.equal(fileReceipt.applied.files.created[0].files, 1);
    assert.equal(fileReceipt.applied.files.created[0].items, 4);

    // Check duplicate coordination & rule prefilter:
    // Line 1: NONE, Line 2: NONE, Line 3 (duplicate of Line 1): DUPLICATED, Line 4 ("12345"): RULE_SKIPPED
    const statuses = store.state.items.map((it) => it.status);
    assert.deepEqual(statuses, ["NONE", "NONE", "DUPLICATED", "RULE_SKIPPED"]);

    // 3. Content batch: add glossary + update item 1, plus an intentional bad fp row to test partial status
    const { execution: run2 } = await runWorkspaceScript({
      store,
      script: `
        import { readFile, writeFile } from "node:fs/promises";
        const raw = await readFile(ws.contract.datasets.items.path, "utf8");
        const items = raw.trim().split("\\n").map((l) => JSON.parse(l));

        await writeFile(
          ws.contract.changes.glossary.creates.path,
          JSON.stringify({ src: "アリス", dst: "爱丽丝", info: "女主角", case_sensitive: false, sort: -1 }) + "\\n",
          "utf8"
        );

        await writeFile(
          ws.contract.changes.items.updates.path,
          [
            JSON.stringify({ item_id: items[0].item_id, fp: items[0].fp, dst: "「早安，亚丽丝！」" }),
            JSON.stringify({ item_id: items[1].item_id, fp: "stale_bad_fp", dst: "少女静静地微笑了。" }),
          ].join("\\n") + "\\n",
          "utf8"
        );
      `,
    });
    assert.equal(run2.exitCode, 0);

    const contentReceipt = store.applyWorkspace();
    assert.equal(contentReceipt.status, "partial");
    assert.equal(contentReceipt.applied.quality.glossary.created, 1);
    assert.equal(contentReceipt.applied.items.updated, 1);
    assert.equal(contentReceipt.rejected.length, 1);
    assert.equal(contentReceipt.rejected[0].reason, "fp_mismatch");
    assert.equal(contentReceipt.destroyed, true);

    // 4. Next workspace_run rebuilds snapshot and computes GLOSSARY warning ("亚丽丝" != "爱丽丝")
    const { execution: run3 } = await runWorkspaceScript({
      store,
      script: `
        import { readFile } from "node:fs/promises";
        const warnRaw = await readFile(ws.contract.datasets.warnings.path, "utf8");
        const warnings = warnRaw.trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l));
        console.log(JSON.stringify(warnings));
      `,
    });
    assert.equal(run3.exitCode, 0);
    assert.equal(run3.stdout.content.length, 1);
    assert.equal(run3.stdout.content[0].item_id, 1);
    assert.ok(run3.stdout.content[0].warnings.some((w) => w.code === "GLOSSARY"));

    // 5. Test inheritance_mode: "inherit" with contested translations on a second file
    // First fix item 1 to "「早安，爱丽丝！」"
    await runWorkspaceScript({
      store,
      script: `
        import { readFile, writeFile } from "node:fs/promises";
        const items = (await readFile(ws.contract.datasets.items.path, "utf8")).trim().split("\\n").map((l) => JSON.parse(l));
        await writeFile(
          ws.contract.changes.items.updates.path,
          [
            JSON.stringify({ item_id: items[0].item_id, fp: items[0].fp, dst: "「早安，爱丽丝！」" }),
            JSON.stringify({ item_id: items[1].item_id, fp: items[1].fp, dst: "少女静静地微笑了。" }),
          ].join("\\n") + "\\n",
          "utf8"
        );
      `,
    });
    assert.equal(store.applyWorkspace().status, "applied");

    const ch2Path = path.join(tmpRoot, "chapter2.txt");
    fs.writeFileSync(ch2Path, "「おはよう、アリス！」\n新しい朝が来た。", "utf8");
    await runWorkspaceScript({
      store,
      script: `
        import { writeFile } from "node:fs/promises";
        await writeFile(
          ws.contract.changes.files.creates.path,
          JSON.stringify({ source_path: ${JSON.stringify(ch2Path)}, inheritance_mode: "inherit" }) + "\\n",
          "utf8"
        );
      `,
    });
    const inhReceipt = store.applyWorkspace();
    assert.equal(inhReceipt.status, "applied");
    assert.equal(inhReceipt.applied.files.created[0].inherited, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("Step 4.2: batch_item_translation & batch_llm_request with mock HTTP LLM server", async () => {
  const tmpRoot = makeTempDir("lg_step4_batch_");
  const capturedPrompts = [];

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    capturedPrompts.push(payload);

    const userMsg = payload.messages.find((m) => m.role === "user")?.content ?? "";
    const jsonlMatch = /```jsonline\n([\s\S]*?)\n```/u.exec(userMsg);

    let replyText = "OK from mock LLM";
    if (jsonlMatch) {
      const reqLines = jsonlMatch[1]
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const outLines = reqLines.map((r) =>
        JSON.stringify({
          id: r.id,
          ...(r.actor !== undefined ? { actor: r.actor ? `译_${r.actor}` : null } : {}),
          text: r.text
            .replaceAll("エルフ", "精灵")
            .replaceAll("魔法使い", "魔法师")
            .replaceAll("こんにちは", "你好"),
        }),
      );
      replyText = `<why>遵守术语表翻译</why>\n\`\`\`jsonline\n${outLines.join("\n")}\n\`\`\``;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: replyText, reasoning_content: "thinking..." } }],
        usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      }),
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    fs.writeFileSync(
      path.join(tmpRoot, "api_config.json"),
      JSON.stringify({
        api_format: "openai",
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: "sk-test-local-mock",
        model: "mock-translator-v1",
        concurrency: 2,
        batch_size: 2,
      }),
      "utf8",
    );

    const msgJsonPath = path.join(tmpRoot, "script.json");
    fs.writeFileSync(
      msgJsonPath,
      JSON.stringify([
        { name: "アリス", message: "こんにちは、\\c[2]エルフ\\c[0]の魔法使い！" },
        { name: "アリス", message: "こんにちは、\\c[2]エルフ\\c[0]の魔法使い！" },
      ]),
      "utf8",
    );

    const store = new ProjectStore(tmpRoot, { sourceLanguage: "JA", targetLanguage: "ZH" });
    await runWorkspaceScript({
      store,
      script: `
        import { writeFile } from "node:fs/promises";
        await writeFile(ws.contract.changes.files.creates.path, JSON.stringify({ source_path: ${JSON.stringify(msgJsonPath)} }) + "\\n");
      `,
    });
    store.applyWorkspace();

    // Add glossary + post_replacement
    await runWorkspaceScript({
      store,
      script: `
        import { writeFile } from "node:fs/promises";
        await writeFile(ws.contract.changes.glossary.creates.path, JSON.stringify({ src: "エルフ", dst: "精灵", info: "种族", case_sensitive: false, sort: -1 }) + "\\n");
        await writeFile(ws.contract.changes.post_replacement.creates.path, JSON.stringify({ src: "魔法师", dst: "魔导师", regex: false, case_sensitive: false, sort: -1 }) + "\\n");
      `,
    });
    store.applyWorkspace();

    const transResult = await executeBatchItemTranslation({
      store,
      itemStatuses: ["NONE"],
    });

    assert.equal(transResult.status, "done");
    assert.equal(transResult.items.total, 1); // Item 2 was DUPLICATED so only 1 LLM call needed!
    assert.equal(transResult.items.succeeded, 1);
    assert.equal(transResult.items.failed, 0);

    // Verify glossary & control character sample were injected into user prompt
    const sentUserPrompt = capturedPrompts[0].messages.find((m) => m.role === "user").content;
    assert.ok(sentUserPrompt.includes("エルフ -> 精灵 #种族"));
    assert.ok(sentUserPrompt.includes("\\c[2]"));

    // Verify post_replacement ("魔法师" -> "魔导师") applied cleanly while preserving \c[2]
    assert.equal(store.state.items[0].dst, "你好、\\c[2]精灵\\c[0]の魔导师！");
    assert.equal(store.state.items[0].name_dst, "译_アリス");

    // Also test batch_llm_request
    store.ensureSnapshot();
    const reqDir = path.join(store.workspacePath, "work", "reqs");
    fs.mkdirSync(reqDir, { recursive: true });
    fs.writeFileSync(
      path.join(reqDir, "001.json"),
      JSON.stringify({ messages: [{ role: "user", content: "Hello!" }] }),
      "utf8",
    );
    const manifestFile = path.join(reqDir, "manifest.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ format: "messages", requests: [{ id: "001", input_file: "001.json" }] }),
      "utf8",
    );

    const llmBatchRes = await executeBatchLlmRequest({
      store,
      requestFile: manifestFile,
    });
    assert.equal(llmBatchRes.status, "done");
    assert.equal(llmBatchRes.succeeded, 1);
    assert.ok(fs.existsSync(llmBatchRes.result_file));
  } finally {
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("Step 4.3: Stdio MCP server protocol handshake, tools/list, read_skill, workspace_open/run/apply", async () => {
  const tmpRoot = makeTempDir("lg_step4_mcp_");
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  const pendingResolvers = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingResolvers.has(msg.id)) {
        const resolve = pendingResolvers.get(msg.id);
        pendingResolvers.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let rpcId = 1;
  const callRpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = rpcId++;
      const timer = setTimeout(() => reject(new Error(`MCP RPC timeout on ${method}`)), 15000);
      pendingResolvers.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    // 1. Initialize
    const initRes = await callRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "step4-test", version: "1.0.0" },
    });
    assert.equal(initRes.result.serverInfo.name, "linguagacha");

    // 2. tools/list
    const listRes = await callRpc("tools/list");
    const toolNames = listRes.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      "workspace_open",
      "read_skill",
      "workspace_run",
      "workspace_apply",
      "batch_item_translation",
      "batch_llm_request",
    ]);

    // 3. read_skill ("glossary") and verify base_url works inside workspace_run!
    const skillRes = await callRpc("tools/call", {
      name: "read_skill",
      arguments: { name: "glossary" },
    });
    const skillPayload = JSON.parse(skillRes.result.content[0].text);
    assert.equal(skillPayload.name, "glossary");
    assert.ok(skillPayload.base_url.startsWith("file:///"));
    assert.ok(skillPayload.base_url.endsWith("/"));

    // 4. workspace_open
    const openRes = await callRpc("tools/call", {
      name: "workspace_open",
      arguments: {
        project_dir: tmpRoot,
        source_language: "JA",
        target_language: "ZH",
      },
    });
    const openPayload = JSON.parse(openRes.result.content[0].text);
    assert.equal(openPayload.source_language, "JA");

    // 5. workspace_run importing upstream glossary/scripts/literal-roots.mjs via skill base_url!
    const runRes = await callRpc("tools/call", {
      name: "workspace_run",
      arguments: {
        script: `
          const mod = await import(new URL("scripts/literal-roots.mjs", ${JSON.stringify(skillPayload.base_url)}).href);
          console.log(JSON.stringify({ exportedKeys: Object.keys(mod) }));
        `,
      },
    });
    assert.ok(!runRes.result.isError, `MCP workspace_run failed: ${runRes.result.content[0].text}`);
    const runPayload = JSON.parse(runRes.result.content[0].text);
    assert.equal(runPayload.exitCode, 0);
    assert.ok(Array.isArray(runPayload.stdout.content.exportedKeys));
  } finally {
    child.kill();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
