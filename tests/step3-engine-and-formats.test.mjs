import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compileLiteralPatterns, normalizeLiteralText } from "@lg/utils/literal-matcher";
import { queryItemContexts } from "@lg/project/item-contexts";
import JSZip from "jszip";

import { buildProofreadingContext, evaluateProofreadingItem } from "../plugins/linguagacha/runtime/core/proofreading.mjs";
import { applyTextReplacements, compileTextReplacements } from "../plugins/linguagacha/runtime/core/text-rules.mjs";
import { readZipEntries, writeZipBuffer } from "../plugins/linguagacha/runtime/core/zip.mjs";
import { EPUBFormat } from "../plugins/linguagacha/runtime/formats/epub-format.mjs";
import { generateProjectFiles, parseAssetBytes } from "../plugins/linguagacha/runtime/formats/index.mjs";

const SKILLS_ROOT = path.resolve(import.meta.dirname, "..", "plugins", "linguagacha", "skills");

test("Step 3.1: @lg/utils/literal-matcher & original upstream glossary/text-preserve skill scripts run unchanged", async () => {
  assert.equal(normalizeLiteralText("ＡＢＣ", false), "abc");
  assert.equal(normalizeLiteralText("Straße", false), "strasse");

  const matcher = compileLiteralPatterns([
    { key: "hero", text: "アリス", case_sensitive: false },
    { key: "guild", text: "星詠みギルド", case_sensitive: false },
  ]);
  assert.equal(matcher.matches("少女アリスは星詠みギルドへ向かった。"), true);

  // Import original untouched upstream skill scripts!
  const { deriveCommonLiteralRoots } = await import(
    pathToFileURL(path.join(SKILLS_ROOT, "glossary/scripts/literal-roots.mjs")).href
  );
  const { matchLiterals } = await import(
    pathToFileURL(path.join(SKILLS_ROOT, "glossary/scripts/match-literals.mjs")).href
  );
  const { analyzeRelations } = await import(
    pathToFileURL(path.join(SKILLS_ROOT, "glossary/scripts/relations.mjs")).href
  );
  const { scanPatterns } = await import(
    pathToFileURL(path.join(SKILLS_ROOT, "text-preserve/scripts/scan-patterns.mjs")).href
  );

  const roots = deriveCommonLiteralRoots(["エリザベス王女", "エリザベス様"]);
  assert.ok(roots.candidates.some((c) => c.root === "エリザベス"));

  const sampleItems = [
    { item_id: 1, file_path: "ch1.txt", src: "エリザベス王女は微笑んだ。\\C[2]光\\C[0]", name_src: "エリザベス" },
    { item_id: 2, file_path: "ch1.txt", src: "「おはよう、相棒！」", name_src: "リナ" },
  ];

  const litRes = await matchLiterals(sampleItems, {
    patterns: [{ key: "p1", text: "エリザベス", case_sensitive: false }],
    max_matches_per_pattern: 5,
  });
  assert.equal(litRes.matched_item_count, 1);
  assert.equal(litRes.patterns[0].field_item_counts.src, 1);
  assert.equal(litRes.patterns[0].field_item_counts.name_src, 1);

  const relRes = analyzeRelations([
    { id: "g1", src: "エリザベス", case_sensitive: false },
    { id: "g2", src: "エリザベス王女", case_sensitive: false },
  ]);
  assert.ok(relRes.relations.some((r) => r.reason === "contains"));

  const preserveScan = await scanPatterns(sampleItems, {
    patterns: [{ key: "color", source: String.raw`\\C\[\d+\]` }],
    max_matches_per_pattern: 10,
  });
  assert.equal(preserveScan.patterns[0].match_count, 2);
});

test("Step 3.2: @lg/project/item-contexts returns +/-2 non-blank same-file neighbors", async () => {
  const items = [
    { item_id: 1, file_path: "a.txt", src: "一行目" },
    { item_id: 2, file_path: "a.txt", src: "" },
    { item_id: 3, file_path: "a.txt", src: "二行目" },
    { item_id: 4, file_path: "a.txt", src: "三行目（ターゲット）" },
    { item_id: 5, file_path: "a.txt", src: "四行目" },
    { item_id: 6, file_path: "b.txt", src: "別ファイル一行目" },
  ];
  const res = await queryItemContexts(items, [4, 99]);
  assert.deepEqual(res.contexts[0], { target_item_id: 4, item_ids: [1, 3, 4, 5] });
  assert.deepEqual(res.missing_item_ids, [99]);
});

test("Step 3.3: Pre/Post replacements & all 6 Proofreading Warning types evaluate accurately", () => {
  const postRules = compileTextReplacements([
    { src: '^"(.+)"$', dst: "「\\1」", regex: true, case_sensitive: false },
  ]);
  assert.equal(applyTextReplacements('"你好，搭档！"', postRules), "「你好，搭档！」");

  const ctx = buildProofreadingContext({
    glossary: {
      enabled: true,
      entries: [
        { id: "g1", src: "星詠み", dst: "咏星者", info: "职业称号", case_sensitive: false },
        { id: "g2", src: "アリス", dst: "爱丽丝", info: "女主角", case_sensitive: false },
      ],
    },
    text_preserve: { mode: "custom", entries: [{ src: String.raw`\\C\[\d+\]`, info: "颜色控制符" }] },
    pre_replacement: { enabled: false, entries: [] },
  });

  // 1. Clean item (note: 「...」 -> “...” is allowed in PUNCTUATION_GROUPS.QUOTE!)
  const cleanEval = evaluateProofreadingItem(
    {
      item_id: 1,
      src: "「\\C[2]星詠み\\C[0]の力を見せてあげる」",
      dst: "“让你见识一下\\C[2]咏星者\\C[0]的力量”",
      name_src: "アリス",
      name_dst: "爱丽丝",
      status: "PROCESSED",
      file_type: "TXT",
    },
    ctx,
    { source_language: "JA", target_language: "ZH" },
  );
  assert.deepEqual(cleanEval.warnings, []);

  // 2. Trigger all 6 warnings across targeted defects
  const multiWarnEval = evaluateProofreadingItem(
    {
      item_id: 2,
      src: "「\\C[2]星詠み\\C[0]なの？」\n二行目です",
      dst: "“\\C[9]占星师\\C[0]なの？", // kana residue + broken \C[9] + missing glossary 咏星者 + missing closing quote + 1 line vs 2 lines
      name_src: "アリス",
      name_dst: "亚莉丝", // glossary mismatch on name_dst
      status: "PROCESSED",
      file_type: "TXT",
    },
    ctx,
    { source_language: "JA", target_language: "ZH" },
  );
  const codes = new Set(multiWarnEval.warnings.map((w) => w.code));
  assert.ok(codes.has("FOREIGN_CHAR_RESIDUE"));
  assert.ok(codes.has("TEXT_PRESERVE"));
  assert.ok(codes.has("LINE_COUNT_MISMATCH"));
  assert.ok(codes.has("GLOSSARY"));
  assert.ok(codes.has("PUNCTUATION_MISMATCH"));

  // 3. SIMILARITY warning (untranslated Japanese sentence copied to dst)
  const simEval = evaluateProofreadingItem(
    {
      item_id: 3,
      src: "今日はとても良い天気ですね。",
      dst: "今日はとても良い天気ですね。",
      name_src: null,
      name_dst: null,
      status: "PROCESSED",
      file_type: "TXT",
    },
    ctx,
    { source_language: "JA", target_language: "ZH" },
  );
  assert.ok(simEval.warnings.some((w) => w.code === "SIMILARITY"));
});

test("Step 3.4: Japanese Light Novel EPUB (<ruby> furigana, spine, NCX/Nav, cover, vertical CSS) roundtrip & bilingual export", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lg-step3-epub-"));
  try {
    const fakeCoverPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    const sampleEpub = writeZipBuffer(
      [
        { name: "mimetype", data: "application/epub+zip", compression: "STORE" },
        {
          name: "META-INF/container.xml",
          data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
        },
        {
          name: "OEBPS/content.opf",
          data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>星詠みの少女</dc:title>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="cover" href="images/cover.png" media-type="image/png"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx" page-progression-direction="rtl">
    <itemref idref="ch1"/>
  </spine>
</package>`,
        },
        {
          name: "OEBPS/style.css",
          data: `body { font-family: serif; writing-mode: vertical-rl; line-height: 1.8; }`,
        },
        { name: "OEBPS/images/cover.png", data: fakeCoverPng },
        {
          name: "OEBPS/nav.xhtml",
          data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>星詠みの少女</title></head>
  <body>
    <nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">第一章 出会い</a></li></ol></nav>
  </body>
</html>`,
        },
        {
          name: "OEBPS/toc.ncx",
          data: `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章 出会い</text></navLabel>
      <content src="text/ch1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
        },
        {
          name: "OEBPS/text/ch1.xhtml",
          data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" class="vrtl">
  <head><title>星詠みの少女</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
  <body>
    <h1>第一章 出会い</h1>
    <p><img src="../images/cover.png" alt="cover"/></p>
    <p>彼女は<ruby>星詠<rt>ほしよ</rt>み</ruby>の巫女だった。</p>
    <p>「よろしくね、<em>相棒</em>！」</p>
  </body>
</html>`,
        },
      ],
      { compression: "DEFLATE" },
    );

    const epubFormat = new EPUBFormat({ target_language: "ZH" });
    const items = epubFormat.readFromBytes(sampleEpub, "novel.epub");

    // Check extracted texts (ruby <rt>ほしよ</rt> must NOT pollute src!)
    const srcs = items.map((i) => i.src);
    assert.ok(srcs.includes("星詠みの少女"), "OPF dc:title extracted");
    assert.ok(srcs.includes("彼女は星詠みの巫女だった。"), "Ruby block extracted cleanly without <rt>");
    assert.ok(srcs.includes("「よろしくね、\n相棒\n！」"), "Inline <em> slots extracted cleanly");

    // Translate all items
    const translationMap = new Map([
      ["星詠みの少女", "咏星少女"],
      ["第一章 出会い", "第一章 邂逅"],
      ["彼女は星詠みの巫女だった。", "她是身为咏星者的巫女。"],
      ["「よろしくね、\n相棒\n！」", "「请多指教啦，\n搭档\n！」"],
    ]);
    for (const item of items) {
      if (translationMap.has(item.src)) {
        item.dst = translationMap.get(item.src);
        item.status = "PROCESSED";
      }
    }

    const monoDir = path.join(tmpDir, "mono");
    const biDir = path.join(tmpDir, "bi");
    epubFormat.writeToPaths(items, sampleEpub, {
      translated_path: monoDir,
      bilingual_path: biDir,
      rel_path: "novel.epub",
      write_bilingual: true,
    });

    const monoBytes = fs.readFileSync(path.join(monoDir, "novel.epub"));
    const biBytes = fs.readFileSync(path.join(biDir, "novel.epub"));

    // Strictly verify uncompressed mimetype at exact OCF header offsets!
    assert.equal(monoBytes.subarray(30, 38).toString("ascii"), "mimetype");
    assert.equal(monoBytes.subarray(38, 58).toString("ascii"), "application/epub+zip");
    assert.equal(monoBytes.readUInt16LE(8), 0, "mimetype compression method must be STORE (0)");

    const monoZip = readZipEntries(monoBytes);
    assert.deepEqual(monoZip.get("OEBPS/images/cover.png").data, fakeCoverPng, "Cover image preserved byte-for-byte");

    const monoCh1 = monoZip.get("OEBPS/text/ch1.xhtml").data.toString("utf8");
    assert.ok(monoCh1.includes("她是身为咏星者的巫女。"));
    assert.ok(!monoCh1.includes("<rt>ほしよ</rt>"), "Monolingual output unwraps original ruby annotation");
    assert.ok(monoCh1.includes("<title>咏星少女</title>"), "XHTML head/title synced from OPF dc:title");
    assert.ok(!monoCh1.includes("vrtl"), "Vertical class removed for horizontal ZH target");

    const monoCss = monoZip.get("OEBPS/style.css").data.toString("utf8");
    assert.ok(!monoCss.includes("vertical-rl"), "Vertical CSS stripped for ZH");

    const monoOpf = monoZip.get("OEBPS/content.opf").data.toString("utf8");
    assert.ok(!monoOpf.includes('page-progression-direction="rtl"'), "RTL page progression stripped for ZH");

    // Verify Bilingual EPUB preserves original <ruby> in cloned opacity:0.50 block AND shows Chinese translation!
    const biZip = readZipEntries(biBytes);
    const biCh1 = biZip.get("OEBPS/text/ch1.xhtml").data.toString("utf8");
    assert.ok(biCh1.includes("opacity:0.50;"), "Bilingual original block has opacity:0.50");
    assert.ok(biCh1.includes("<ruby>星詠<rt>ほしよ</rt>み</ruby>"), "Bilingual cloned source keeps original <ruby>");
    assert.ok(biCh1.includes("她是身为咏星者的巫女。"), "Bilingual chapter has Chinese translation");

    // Verify JSZip shim can also open and re-save the EPUB (matching epub/SKILL.md snippet!)
    const jszipLoaded = await JSZip.loadAsync(monoBytes);
    const ch1ViaJsZip = await jszipLoaded.file("OEBPS/text/ch1.xhtml").async("string");
    assert.ok(ch1ViaJsZip.includes("请多指教啦，"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Step 3.5: TXT (with DUPLICATED hydration), Markdown (MD_V2), KVJSON, MESSAGEJSON, and .generic formats", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lg-step3-formats-"));
  try {
    // 1. Markdown with YAML frontmatter + code block
    const rawMd = Buffer.from(
      ["---", "title: Sample", "---", "", "# 第一話", "", "少女は空を見上げた。", "", "```js", "const x = 1;", "```", ""].join("\n"),
      "utf8",
    );
    const mdParsed = parseAssetBytes(rawMd, "story.md");
    assert.equal(mdParsed.file_type, "MD_V2");
    assert.equal(mdParsed.items[0].status, "RULE_SKIPPED", "YAML frontmatter skipped");
    assert.equal(mdParsed.items[3].status, "RULE_SKIPPED", "Fenced code block skipped");
    mdParsed.items[1].dst = "# 第一话";
    mdParsed.items[1].status = "PROCESSED";
    mdParsed.items[2].dst = "少女仰望天空。";
    mdParsed.items[2].status = "PROCESSED";

    // 2. MESSAGEJSON with character names
    const rawMsgJson = Buffer.from(
      JSON.stringify([
        { name: "アリス", message: "おはよう！" },
        { names: ["ボブ"], message: "いい朝だな。" },
      ]),
      "utf8",
    );
    const msgParsed = parseAssetBytes(rawMsgJson, "script.json");
    assert.equal(msgParsed.file_type, "MESSAGEJSON");
    msgParsed.items[0].dst = "早上好！";
    msgParsed.items[0].name_dst = "爱丽丝";
    msgParsed.items[0].status = "PROCESSED";
    msgParsed.items[1].dst = "真是个好早晨。";
    msgParsed.items[1].name_dst = "鲍勃";
    msgParsed.items[1].status = "PROCESSED";

    // 3. .generic container
    const rawGeneric = writeZipBuffer([
      {
        name: "items.json",
        data: JSON.stringify([{ name: "ナレーター", message: "物語が始まる。", custom_offset: 128 }]),
      },
    ]);
    const genParsed = parseAssetBytes(rawGeneric, "extra.generic");
    assert.equal(genParsed.file_type, "GENERIC");
    genParsed.items[0].dst = "故事开始了。";
    genParsed.items[0].name_dst = "旁白";
    genParsed.items[0].status = "PROCESSED";

    // 4. TXT with DUPLICATED line hydration
    const rawTxt = Buffer.from("同じセリフ\n別のセリフ\n同じセリフ", "utf8");
    const txtParsed = parseAssetBytes(rawTxt, "ch.txt");
    txtParsed.items[0].dst = "相同的台词";
    txtParsed.items[0].status = "PROCESSED";
    txtParsed.items[1].dst = "另一句台词";
    txtParsed.items[1].status = "PROCESSED";
    txtParsed.items[2].status = "DUPLICATED"; // should auto-hydrate from items[0]!

    const originals = new Map([
      ["story.md", rawMd],
      ["script.json", rawMsgJson],
      ["extra.generic", rawGeneric],
      ["ch.txt", rawTxt],
    ]);

    const outMono = path.join(tmpDir, "out_mono");
    const outBi = path.join(tmpDir, "out_bi");
    const outWb = path.join(tmpDir, "out_wb");

    const genRes = generateProjectFiles({
      files: [
        { file_path: "story.md", file_type: "MD_V2" },
        { file_path: "script.json", file_type: "MESSAGEJSON" },
        { file_path: "extra.generic", file_type: "GENERIC" },
        { file_path: "ch.txt", file_type: "TXT" },
      ],
      items: [...mdParsed.items, ...msgParsed.items, ...genParsed.items, ...txtParsed.items],
      readOriginalAssetBytes: (rel) => originals.get(rel) ?? null,
      translatedPath: outMono,
      bilingualPath: outBi,
      writebackInputPath: outWb,
      bilingualFiles: ["story.md", "ch.txt"],
      targetLanguage: "ZH",
    });

    assert.equal(genRes.accepted, true);
    assert.deepEqual(genRes.writeback.files, ["extra.generic"]);

    const monoMd = fs.readFileSync(path.join(outMono, "story.md"), "utf8");
    assert.ok(monoMd.includes("title: Sample") && monoMd.includes("# 第一话") && monoMd.includes("const x = 1;"));

    const biTxt = fs.readFileSync(path.join(outBi, "ch.txt"), "utf8");
    assert.equal(biTxt, "同じセリフ\n相同的台词\n別のセリフ\n另一句台词\n同じセリフ\n相同的台词");

    const monoMsg = JSON.parse(fs.readFileSync(path.join(outMono, "script.json"), "utf8"));
    assert.equal(monoMsg[0].name, "爱丽丝");
    assert.equal(monoMsg[0].message, "早上好！");
    assert.deepEqual(monoMsg[1].names, ["鲍勃"]);

    const wbGeneric = JSON.parse(fs.readFileSync(path.join(outWb, "extra.generic", "items.json"), "utf8"));
    assert.equal(wbGeneric[0].name, "旁白");
    assert.equal(wbGeneric[0].message, "故事开始了。");
    assert.equal(wbGeneric[0].custom_offset, 128, "Private fields preserved in .generic writeback");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
