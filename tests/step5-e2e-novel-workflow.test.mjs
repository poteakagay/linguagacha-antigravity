import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readZipEntries, writeZipBuffer } from "../plugins/linguagacha/runtime/core/zip.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "plugins", "linguagacha");
const MCP_CONFIG = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "mcp_config.json"), "utf8"));

function buildSampleLightNovelEpub() {
  const coverPngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  const entries = [
    {
      path: "mimetype",
      data: Buffer.from("application/epub+zip", "utf8"),
      store: true,
    },
    {
      path: "META-INF/container.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
        "utf8",
      ),
    },
    {
      path: "OEBPS/style.css",
      data: Buffer.from(
        `html { writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; }\np { line-height: 1.8; }`,
        "utf8",
      ),
    },
    {
      path: "OEBPS/cover.png",
      data: coverPngBytes,
    },
    {
      path: "OEBPS/toc.ncx",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2.0">
  <navMap>
    <navPoint id="nav1" playOrder="1">
      <navLabel><text>第一章 星霊の目覚め</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
        "utf8",
      ),
    },
    {
      path: "OEBPS/nav.xhtml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body>
  <nav epub:type="toc">
    <ol><li><a href="ch1.xhtml">第一章 星霊の目覚め</a></li></ol>
  </nav>
</body>
</html>`,
        "utf8",
      ),
    },
    {
      path: "OEBPS/ch1.xhtml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" class="vrtl">
<head>
  <title>第一章 星霊の目覚め</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>第一章 星霊の目覚め</h1>
  <p>「セレスティア、<ruby>星霊剣<rt>アストラル・ブレイド</rt></ruby>を抜け！」</p>
  <p>【STATUS:100】魔力充填が完了した。</p>
  <p>月光が静かな森を照らしていた。</p>
  <p>夜空を見上げて、<br/>少女は静かに誓った。</p>
  <p>「セレスティア、<ruby>星霊剣<rt>アストラル・ブレイド</rt></ruby>を抜け！」</p>
</body>
</html>`,
        "utf8",
      ),
    },
    {
      path: "OEBPS/content.opf",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:12345678-1234-1234-1234-1234567890ab</dc:identifier>
    <dc:title>星霊騎士譚</dc:title>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover" href="cover.png" media-type="image/png"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx" page-progression-direction="rtl">
    <itemref idref="ch1"/>
  </spine>
</package>`,
        "utf8",
      ),
    },
  ];

  return { epubBytes: writeZipBuffer(entries), coverPngBytes };
}

test("Step 5 E2E: Full closed-loop novel translation workflow over live MCP server (EPUB + TXT -> Glossary -> 6 Warnings Check & Fix -> Monolingual & Bilingual Export)", async () => {
  const tmpNovelDir = fs.mkdtempSync(path.join(os.tmpdir(), "lg_step5_e2e_"));
  const { epubBytes, coverPngBytes } = buildSampleLightNovelEpub();

  const epubInputPath = path.join(tmpNovelDir, "vol1.epub");
  const txtInputPath = path.join(tmpNovelDir, "bonus.txt");
  fs.writeFileSync(epubInputPath, epubBytes);
  fs.writeFileSync(
    txtInputPath,
    [
      "セレスティアは微笑んで言った。\n「また明日ね！」",
      "風が優しく吹いた。",
      "風が優しく吹いた。",
    ].join("\n\n"),
    "utf8",
  );

  // Launch MCP server using exact command/args/cwd from plugins/linguagacha/mcp_config.json
  const srvCfg = MCP_CONFIG.mcpServers.linguagacha;
  const cmd = srvCfg.command === "node" ? process.execPath : srvCfg.command;
  const child = spawn(cmd, srvCfg.args, {
    cwd: PLUGIN_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;
  const callTool = async (name, args = {}) => {
    const id = nextId++;
    const msg = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout calling ${name}`)), 20000);
      pending.set(id, (res) => {
        clearTimeout(t);
        resolve(res);
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }) + "\n",
      );
    });
    assert.ok(!msg.error, `RPC error on ${name}: ${JSON.stringify(msg.error)}`);
    assert.ok(!msg.result.isError, `Tool error on ${name}: ${msg.result.content?.[0]?.text}`);
    return JSON.parse(msg.result.content[0].text);
  };

  try {
    // Initialize MCP session
    await new Promise((resolve) => {
      pending.set(9999, resolve);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9999,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } },
        }) + "\n",
      );
    });

    // 1. Open novel directory
    const openSummary = await callTool("workspace_open", {
      project_dir: tmpNovelDir,
      source_language: "JA",
      target_language: "ZH",
      name: "星灵骑士谭",
    });
    assert.equal(openSummary.name, "星灵骑士谭");

    // 2. Read skills (epub, glossary, proofreading)
    const glossarySkill = await callTool("read_skill", { name: "glossary" });
    assert.ok(glossarySkill.content.includes("术语"));

    // 3. Inspect & Import both vol1.epub and bonus.txt
    const inspectRun = await callTool("workspace_run", {
      script: `
        import { writeFile } from "node:fs/promises";
        import { inspectSources } from "@lg/project";

        const res = await inspectSources([${JSON.stringify(epubInputPath)}, ${JSON.stringify(txtInputPath)}]);
        const lines = [
          JSON.stringify({ source_path: ${JSON.stringify(epubInputPath)} }),
          JSON.stringify({ source_path: ${JSON.stringify(txtInputPath)} }),
        ].join("\\n") + "\\n";
        await writeFile(ws.contract.changes.files.creates.path, lines, "utf8");
        console.log(JSON.stringify(res));
      `,
    });
    assert.equal(inspectRun.exitCode, 0);
    assert.equal(inspectRun.stdout.content.length, 2);

    const importReceipt = await callTool("workspace_apply");
    assert.equal(importReceipt.status, "applied");
    assert.equal(importReceipt.applied.files.created.length, 2);

    // 4. Verify EPUB unpacked in sources/vol1.epub/ and run upstream glossary match-literals.mjs
    const scanRun = await callTool("workspace_run", {
      script: `
        import { readFile, stat, writeFile } from "node:fs/promises";
        import { matchLiterals } from ${JSON.stringify(new URL("scripts/match-literals.mjs", glossarySkill.base_url).href)};

        const opfStat = await stat("sources/vol1.epub/OEBPS/content.opf");
        const rawItems = (await readFile(ws.contract.datasets.items.path, "utf8"))
          .trim().split("\\n").map((l) => JSON.parse(l));

        // Verify <ruby>星霊剣<rt>アストラル・ブレイド</rt></ruby> was cleanly stripped to plain base text 星霊剣
        const hasCleanRuby = rawItems.some((it) => it.src.includes("星霊剣を抜け"));
        const duplicatedCount = rawItems.filter((it) => it.status === "DUPLICATED").length;

        const hits = await matchLiterals(rawItems, {
          patterns: [{ key: "heroine", text: "セレスティア", case_sensitive: false }],
        });

        // Stage glossary + custom text_preserve rules
        await writeFile(
          ws.contract.changes.glossary.creates.path,
          [
            JSON.stringify({ src: "セレスティア", dst: "塞蕾丝蒂亚", info: "女主角", case_sensitive: false, sort: -1 }),
            JSON.stringify({ src: "星霊剣", dst: "星灵剑", info: "圣剑", case_sensitive: false, sort: -1 }),
          ].join("\\n") + "\\n",
          "utf8"
        );
        await writeFile(
          ws.contract.changes.text_preserve.creates.path,
          JSON.stringify({ src: "【STATUS:\\\\d+】", info: "状态栏标签", sort: -1 }) + "\\n",
          "utf8"
        );

        console.log(JSON.stringify({
          opfSize: opfStat.size,
          totalItems: rawItems.length,
          hasCleanRuby,
          duplicatedCount,
          heroineHits: hits.patterns[0].matched_item_count,
        }));
      `,
    });
    assert.equal(scanRun.exitCode, 0);
    assert.equal(scanRun.stdout.content.hasCleanRuby, true);
    assert.ok(scanRun.stdout.content.duplicatedCount >= 2);
    assert.ok(scanRun.stdout.content.heroineHits >= 2);

    const rulesReceipt = await callTool("workspace_apply");
    assert.equal(rulesReceipt.status, "applied");
    assert.equal(rulesReceipt.applied.quality.glossary.created, 2);
    assert.equal(rulesReceipt.applied.quality.text_preserve.created, 1);

    // 5. Submit deliberate flawed translations first to verify ALL 6 warning types trigger!
    await callTool("workspace_run", {
      script: `
        import { readFile, writeFile } from "node:fs/promises";
        const items = (await readFile(ws.contract.datasets.items.path, "utf8"))
          .trim().split("\\n").map((l) => JSON.parse(l));

        const updates = [];
        for (const it of items) {
          if (it.status !== "NONE") continue;
          if (it.src.includes("第一章 星霊の目覚め")) {
            // 1. SIMILARITY (exact copy of source Kanji/text -> high similarity / untranslated)
            updates.push({ item_id: it.item_id, fp: it.fp, dst: it.src });
          } else if (it.src.includes("星霊剣を抜け")) {
            // 2. GLOSSARY ("赛蕾丝" instead of "塞蕾丝蒂亚") + 3. PUNCTUATION_MISMATCH (missing closing 」)
            updates.push({ item_id: it.item_id, fp: it.fp, dst: "「赛蕾丝，拔出星灵剑！" });
          } else if (it.src.includes("【STATUS:100】")) {
            // 4. TEXT_PRESERVE (mutated 【STATUS:100】 -> 【STATUS:999】)
            updates.push({ item_id: it.item_id, fp: it.fp, dst: "【STATUS:999】魔力充能完毕。" });
          } else if (it.src.includes("月光が静かな森")) {
            // 5. FOREIGN_CHAR_RESIDUE (leftover Japanese kana かな in Chinese translation)
            updates.push({ item_id: it.item_id, fp: it.fp, dst: "月光静かな照耀着森林。" });
          } else if (it.src.includes("夜空を見上げて")) {
            // 6. LINE_COUNT_MISMATCH (source <br/> has 2 lines, translation collapsed to 1 line)
            updates.push({ item_id: it.item_id, fp: it.fp, dst: "仰望夜空，少女静静地立下誓言。" });
          } else if (it.src.includes("セレスティアは微笑んで言った")) {
            updates.push({ item_id: it.item_id, fp: it.fp, dst: "塞蕾丝蒂亚微笑着说道：" });
          } else if (it.src.includes("また明日ね")) {
            updates.push({ item_id: it.item_id, fp: it.fp, dst: "「明天见啦！」" });
          } else if (it.src.includes("風が優しく吹いた")) {
            updates.push({ item_id: it.item_id, fp: it.fp, dst: "微风温柔地拂过。" });
          }
        }
        await writeFile(
          ws.contract.changes.items.updates.path,
          updates.map((u) => JSON.stringify(u)).join("\\n") + "\\n",
          "utf8"
        );
      `,
    });
    assert.equal((await callTool("workspace_apply")).status, "applied");

    // Inspect warnings.jsonl and confirm ALL 6 warning codes were detected!
    const warnCheckRun = await callTool("workspace_run", {
      script: `
        import { readFile } from "node:fs/promises";
        import { queryItemContexts } from "@lg/project/item-contexts";

        const items = (await readFile(ws.contract.datasets.items.path, "utf8"))
          .trim().split("\\n").map((l) => JSON.parse(l));
        const warnings = (await readFile(ws.contract.datasets.warnings.path, "utf8"))
          .trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l));

        const codes = [...new Set(warnings.flatMap((w) => w.warnings.map((x) => x.code)))].sort();
        const ctxRes = await queryItemContexts(items, warnings.map((w) => w.item_id));
        console.log(JSON.stringify({ warningItemCount: warnings.length, codes, contextCount: ctxRes.contexts.length }));
      `,
    });
    assert.equal(warnCheckRun.exitCode, 0);
    assert.deepEqual(
      warnCheckRun.stdout.content.codes,
      [
        "FOREIGN_CHAR_RESIDUE",
        "GLOSSARY",
        "LINE_COUNT_MISMATCH",
        "PUNCTUATION_MISMATCH",
        "SIMILARITY",
        "TEXT_PRESERVE",
      ],
    );
    assert.equal(warnCheckRun.stdout.content.contextCount, warnCheckRun.stdout.content.warningItemCount);

    // 6. Proofread & repair all flawed items, commit, and verify 0 remaining warnings!
    await callTool("workspace_run", {
      script: `
        import { readFile, writeFile } from "node:fs/promises";
        const items = (await readFile(ws.contract.datasets.items.path, "utf8"))
          .trim().split("\\n").map((l) => JSON.parse(l));

        const fixes = [];
        for (const it of items) {
          if (it.status === "DUPLICATED") continue;
          if (it.src === "星霊騎士譚") {
            fixes.push({ item_id: it.item_id, fp: it.fp, dst: "星灵骑士谭" });
          } else if (it.src === "目次") {
            fixes.push({ item_id: it.item_id, fp: it.fp, dst: "目录" });
          } else if (it.src.includes("第一章 星霊の目覚め")) {
            fixes.push({ item_id: it.item_id, fp: it.fp, dst: "第一章 星灵的觉醒" });
          } else if (it.src.includes("星霊剣を抜け")) {
            fixes.push({ item_id: it.item_id, fp: it.fp, dst: "「塞蕾丝蒂亚，拔出星灵剑！」" });
          } else if (it.src.includes("【STATUS:100】")) {
            fixes.push({ item_id: it.item_id, fp: it.fp, dst: "【STATUS:100】魔力充能已全部完成。" });
          } else if (it.src.includes("月光が静かな森")) {
            fixes.push({ item_id: it.item_id, fp: it.fp, dst: "月光静静地照耀着森林。" });
          } else if (it.src.includes("夜空を見上げて")) {
            fixes.push({ item_id: it.item_id, fp: it.fp, dst: "仰望夜空，\\n少女静静地立下誓言。" });
          }
        }
        await writeFile(
          ws.contract.changes.items.updates.path,
          fixes.map((u) => JSON.stringify(u)).join("\\n") + "\\n",
          "utf8"
        );
      `,
    });
    assert.equal((await callTool("workspace_apply")).status, "applied");

    // 7. Verify 0 warnings and export BOTH monolingual and bilingual EPUB + TXT!
    const exportRun = await callTool("workspace_run", {
      script: `
        import { cp, readFile } from "node:fs/promises";
        import { generateFiles, getOutputPaths } from "@lg/project";

        const meta = JSON.parse(await readFile(ws.contract.datasets.project_meta.path, "utf8"));
        const outPaths = await getOutputPaths();
        const gen = await generateFiles(meta.files.map((f) => f.file_path));

        await cp(gen.output_path, outPaths.translated_path, { recursive: true });
        await cp(gen.bilingual_output_path, outPaths.bilingual_path, { recursive: true });

        console.log(JSON.stringify({
          warningsRemaining: meta.counts.items_with_warnings,
          translatedDir: outPaths.translated_path,
          bilingualDir: outPaths.bilingual_path,
          excluded: gen.excluded_files,
        }));
      `,
    });
    assert.equal(exportRun.exitCode, 0);
    const expInfo = exportRun.stdout.content;
    assert.equal(expInfo.warningsRemaining, 0);
    assert.deepEqual(expInfo.excluded, []);

    // 8. Inspect exported Monolingual & Bilingual EPUB + TXT on disk!
    const monoEpubBytes = fs.readFileSync(path.join(expInfo.translatedDir, "vol1.epub"));
    const biEpubBytes = fs.readFileSync(path.join(expInfo.bilingualDir, "vol1.epub"));
    const monoTxt = fs.readFileSync(path.join(expInfo.translatedDir, "bonus.txt"), "utf8");
    const biTxt = fs.readFileSync(path.join(expInfo.bilingualDir, "bonus.txt"), "utf8");

    // Check uncompressed mimetype header at bytes 30..58 in exported EPUB
    assert.equal(monoEpubBytes.subarray(30, 38).toString("utf8"), "mimetype");
    assert.equal(monoEpubBytes.readUInt16LE(8), 0); // Stored (method 0, uncompressed!)

    const monoEntries = readZipEntries(monoEpubBytes);
    const monoCh1 = monoEntries.get("OEBPS/ch1.xhtml").data.toString("utf8");
    const monoCss = monoEntries.get("OEBPS/style.css").data.toString("utf8");
    const monoCover = monoEntries.get("OEBPS/cover.png").data;

    assert.ok(monoCh1.includes("「塞蕾丝蒂亚，拔出星灵剑！」"));
    assert.ok(!monoCh1.includes("アストラル・ブレイド"), "Monolingual EPUB should strip ruby furigana");
    assert.ok(!monoCss.includes("vertical-rl"), "Vertical-rl CSS should be converted to horizontal");
    assert.deepEqual(monoCover, coverPngBytes, "Cover PNG must be preserved byte-for-byte");

    // Verify duplicated line at end of ch1.xhtml also got translated!
    const occurrencesInMono = monoCh1.split("「塞蕾丝蒂亚，拔出星灵剑！」").length - 1;
    assert.equal(occurrencesInMono, 2, "Both original and DUPLICATED dialogue lines must be translated");

    // Verify Bilingual EPUB contains both original Japanese (with ruby!) and Chinese translation
    const biEntries = readZipEntries(biEpubBytes);
    const biCh1 = biEntries.get("OEBPS/ch1.xhtml").data.toString("utf8");
    assert.ok(biCh1.includes("アストラル・ブレイド"), "Bilingual EPUB preserves original <ruby> furigana");
    assert.ok(biCh1.includes("「塞蕾丝蒂亚，拔出星灵剑！」"), "Bilingual EPUB includes Chinese translation");

    // Verify Monolingual & Bilingual TXT (including DUPLICATED line hydration!)
    assert.ok(monoTxt.replace(/\r\n/g, "\n").includes("塞蕾丝蒂亚微笑着说道：\n「明天见啦！」"));
    assert.equal(monoTxt.split("微风温柔地拂过。").length - 1, 2);
    assert.ok(biTxt.includes("風が優しく吹いた。"));
    assert.ok(biTxt.includes("微风温柔地拂过。"));
  } finally {
    child.kill();
    fs.rmSync(tmpNovelDir, { recursive: true, force: true });
  }
});
