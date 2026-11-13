import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import posix from "node:path/posix";
import { readZipEntries, writeZipBuffer } from "../core/zip.mjs";
import {
  Element,
  Text,
  cloneNode,
  decodeHtmlEntities,
  isTag,
  isText,
  parseDomDocument,
  relinkChildren,
  serializeDomNode,
} from "../core/xml-dom.mjs";
import { splitTextLines } from "../core/text-rules.mjs";

export const ROW_MULTIPLIER = 1_000_000;
export const ROW_BASE_NAV = 8_000_000_000;
export const ROW_BASE_OPF_TITLE = 8_500_000_000;
export const ROW_BASE_NCX = 9_000_000_000;

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "li", "td", "th", "caption", "figcaption", "dt", "dd",
]);
const SKIP_SUBTREE_TAGS = new Set([
  "head", "script", "style", "code", "pre", "kbd", "samp", "var", "noscript", "rt",
]);
const TEXT_RUN_RESOURCE_TAGS = new Set(["svg", "math", "video", "audio", "iframe", "object"]);
const BLOCK_TRANSLATION_RUBY_CONTAINERS = new Set(["ruby", "rb"]);
const BLOCK_TRANSLATION_RUBY_ANNOTATIONS = new Set(["rt", "rp", "rtc"]);
const TEXT_RUN_BOUNDARY_TAGS = new Set([
  "br", "hr", "img", "body", "section", "article", "blockquote", "nav", "aside",
  "header", "footer", "address", "figure", "ol", "ul", "dl", "table", "thead", "tbody", "tfoot", "tr", "a",
]);
const HTML_DOCUMENT_EXTENSIONS = [".xhtml", ".html", ".htm", ".xhtm"];
const CSS_VERTICAL_WRITING_PATTERN = /[^;\s]*writing-mode\s*:\s*vertical-rl;*/giu;
const EPUB_READING_LAYOUT_TARGET_LANGUAGES = new Set(["JA", "ZH-HANT"]);

function isValidXmlTextCodePoint(cp) {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function createEpubItem(payload) {
  return {
    src: String(payload.src ?? ""),
    dst: String(payload.dst ?? ""),
    name_src: payload.name_src ?? null,
    name_dst: payload.name_dst ?? null,
    extra_field: payload.extra_field ?? "",
    tag: String(payload.tag ?? ""),
    row: Number(payload.row ?? 0),
    file_type: "EPUB",
    file_path: String(payload.file_path ?? ""),
    status: payload.status ?? "NONE",
    skip_internal_filter: Boolean(payload.skip_internal_filter),
  };
}

function readTranslationForGen(item) {
  return item.status === "PROCESSED" ? String(item.dst ?? "") : undefined;
}

export function distributeTextToSlots(text, slotCount) {
  const lines = splitTextLines(text);
  return Array.from({ length: Math.max(0, slotCount) }, (_, idx) =>
    idx === slotCount - 1 ? lines.slice(idx).join("\n") : (lines[idx] ?? ""),
  );
}

export class EpubAst {
  normalizeSlotText(text) {
    if (!text.includes("\r") && !text.includes("\n") && !text.includes("\t") && !text.includes("  ")) {
      return text;
    }
    return text.replace(/[\r\n\t]+/gu, " ").replace(/[ ]{2,}/gu, " ");
  }

  normalizeEpubPath(rawPath) {
    return String(rawPath).replace(/\\/gu, "/").normalize("NFC");
  }

  isHtmlDocumentPath(filePath) {
    const lower = String(filePath).toLowerCase();
    return HTML_DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  resolveHref(baseDir, href) {
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      // keep literal
    }
    const norm = this.normalizeEpubPath(decoded);
    return posix.normalize(posix.join(baseDir, norm)).replace(/^\.\//u, "");
  }

  localName(tagName) {
    const brace = tagName.lastIndexOf("}");
    const noNs = brace >= 0 ? tagName.slice(brace + 1) : tagName;
    const colon = noNs.lastIndexOf(":");
    return colon >= 0 ? noNs.slice(colon + 1) : noNs;
  }

  isBlockCandidate(elem) {
    return BLOCK_TAGS.has(this.localName(elem.name));
  }

  iterChildrenElements(elem) {
    return elem.children.filter((c) => isTag(c));
  }

  iterElemPathPairs(root) {
    const pairs = [];
    const rootPath = `/${this.localName(root.name)}[1]`;
    const stack = [[root, rootPath]];
    while (stack.length > 0) {
      const [parent, parentPath] = stack.pop();
      pairs.push([parent, parentPath]);
      const counter = new Map();
      const childEntries = [];
      for (const child of this.iterChildrenElements(parent)) {
        const name = this.localName(child.name);
        const index = (counter.get(name) ?? 0) + 1;
        counter.set(name, index);
        childEntries.push([child, `${parentPath}/${name}[${index}]`]);
      }
      for (const entry of childEntries.reverse()) stack.push(entry);
    }
    return pairs;
  }

  buildElemPathMap(root) {
    return new Map(this.iterElemPathPairs(root));
  }

  buildElemByPath(root) {
    return new Map(this.iterElemPathPairs(root).map(([elem, p]) => [p, elem]));
  }

  findByPath(root, elemPath) {
    const parts = String(elemPath).trim().split("/").filter(Boolean);
    const segs = parts.map((part) => {
      const m = /^([A-Za-z0-9:_-]+)\[(\d+)\]$/u.exec(part);
      if (!m) throw new Error(`Invalid EPUB element path: ${elemPath}`);
      return { name: m[1], pos: Number.parseInt(m[2], 10) };
    });
    if (segs.length === 0 || this.localName(root.name) !== segs[0].name) return null;
    let current = root;
    for (const seg of segs.slice(1)) {
      const candidates = this.iterChildrenElements(current).filter((c) => this.localName(c.name) === seg.name);
      if (seg.pos <= 0 || seg.pos > candidates.length) return null;
      current = candidates[seg.pos - 1];
    }
    return current;
  }

  sha1Hex(text) {
    return crypto.createHash("sha1").update(text, "utf8").digest("hex");
  }

  sha1HexWithNullSeparator(parts) {
    const hash = crypto.createHash("sha1");
    parts.forEach((p, idx) => {
      if (idx > 0) hash.update(Buffer.from([0]));
      hash.update(p, "utf8");
    });
    return hash.digest("hex");
  }

  decodeBytes(raw) {
    return Buffer.from(raw).toString("utf8").replace(/^\uFEFF/u, "");
  }

  sanitizeXmlText(text) {
    return [...String(text)].filter((c) => isValidXmlTextCodePoint(c.codePointAt(0) ?? 0)).join("");
  }

  firstRootElement(doc) {
    for (const child of doc.children) {
      if (isTag(child)) return child;
    }
    return null;
  }

  parseXmlDocument(text, recover = false) {
    const doc = parseDomDocument(text, { xmlMode: true, recover });
    const root = this.firstRootElement(doc);
    if (!root || (!recover && this.localName(root.name).toLowerCase() === "parsererror")) {
      throw new Error("EPUB XML parse failed");
    }
    return root;
  }

  parseHtmlDocument(text) {
    const doc = parseDomDocument(text, { xmlMode: false, recover: true });
    const root = this.firstRootElement(doc);
    if (!root) throw new Error("EPUB HTML parse failed");
    return root;
  }

  replaceOutsideCdata(text, replacer) {
    const cdataRe = /<!\[CDATA\[[\s\S]*?\]\]>/gu;
    const parts = [];
    let lastEnd = 0;
    for (const m of text.matchAll(cdataRe)) {
      const idx = m.index ?? 0;
      parts.push(replacer(text.slice(lastEnd, idx)));
      parts.push(m[0]);
      lastEnd = idx + m[0].length;
    }
    parts.push(replacer(text.slice(lastEnd)));
    return parts.join("");
  }

  normalizeHtmlNamedEntitiesForXml(text) {
    if (!text.includes("&")) return text;
    return this.replaceOutsideCdata(text, (seg) =>
      seg.replace(/&([A-Za-z][A-Za-z0-9._:-]*);/gu, (match, name) => {
        if (name === "amp" || name === "lt" || name === "gt" || name === "quot" || name === "apos") {
          return match;
        }
        const decoded = decodeHtmlEntities(match);
        return decoded === match
          ? `&amp;${name};`
          : [...decoded].map((c) => `&#${c.codePointAt(0) ?? 0};`).join("");
      }),
    );
  }

  parseXhtmlOrHtml(raw) {
    const text = this.decodeBytes(raw);
    try {
      return this.parseXmlDocument(text);
    } catch {
      // fallback to entity fix
    }
    try {
      return this.parseXmlDocument(this.normalizeHtmlNamedEntitiesForXml(text));
    } catch {
      // fallback to tolerant HTML
    }
    return this.parseHtmlDocument(text);
  }

  parseNcxXml(raw) {
    const text = this.decodeBytes(raw);
    try {
      return this.parseXmlDocument(text);
    } catch {
      const fixed = this.replaceOutsideCdata(text, (seg) =>
        seg.replace(/&(?!(?:[A-Za-z][A-Za-z0-9._:-]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)/gu, "&amp;"),
      );
      return this.parseXmlDocument(fixed, true);
    }
  }

  parseOpfXml(raw) {
    return this.parseXmlDocument(this.decodeBytes(raw), true);
  }

  flattenElements(root) {
    const result = [];
    const walk = (el) => {
      result.push(el);
      for (const child of this.iterChildrenElements(el)) walk(child);
    };
    walk(root);
    return result;
  }

  findDescendants(root, local) {
    return this.flattenElements(root).filter((el) => this.localName(el.name) === local);
  }

  isNavPage(root) {
    for (const nav of this.findDescendants(root, "nav")) {
      for (const [k, v] of Object.entries(nav.attribs)) {
        if ((k === "epub:type" || k.endsWith(":type") || k.endsWith("}type")) && (v === "toc" || v === "landmarks")) {
          return true;
        }
      }
    }
    return false;
  }

  readTextSlot(elem) {
    const parts = [];
    for (const child of elem.children) {
      if (isTag(child)) break;
      if (isText(child)) parts.push(child.data);
    }
    return parts.join("");
  }

  readTailSlot(elem) {
    const parent = elem.parent;
    if (!parent || !Array.isArray(parent.children)) return "";
    const idx = parent.children.indexOf(elem);
    if (idx < 0) return "";
    const parts = [];
    for (const sibling of parent.children.slice(idx + 1)) {
      if (isTag(sibling)) break;
      if (isText(sibling)) parts.push(sibling.data);
    }
    return parts.join("");
  }

  writeSlot(elem, slot, text) {
    const parent = slot === "text" ? elem : elem.parent;
    if (!parent || !Array.isArray(parent.children)) return;
    const children = parent.children;
    const startIdx = slot === "text" ? 0 : children.indexOf(elem) + 1;
    if (startIdx < 0) return;
    let endIdx = startIdx;
    while (endIdx < children.length && !isTag(children[endIdx])) endIdx += 1;
    const textNode = new Text(text);
    textNode.parent = parent;
    children.splice(startIdx, endIdx - startIdx, textNode);
    relinkChildren(parent);
  }

  writeTextSlot(elem, text) {
    this.writeSlot(elem, "text", text);
  }

  writeTailSlot(elem, text) {
    this.writeSlot(elem, "tail", text);
  }

  replaceElementChildren(elem, children) {
    elem.children = children;
    relinkChildren(elem);
  }

  hasRubyDescendant(elem) {
    return this.flattenElements(elem).some((n) => this.localName(n.name) === "ruby");
  }

  buildCanonicalNodesText(nodes) {
    const parts = [];
    const walk = (node) => {
      if (isText(node)) parts.push(node.data);
      else if (isTag(node) && !SKIP_SUBTREE_TAGS.has(this.localName(node.name))) {
        for (const c of node.children) walk(c);
      }
    };
    for (const n of nodes) walk(n);
    return this.normalizeSlotText(parts.join(""));
  }

  buildCanonicalBlockText(block) {
    return this.buildCanonicalNodesText([block]);
  }

  iterTranslatableTextSlots(root, block, pathMap) {
    const results = [];
    const getPath = (el) => pathMap?.get(el) ?? this.buildElemPathMap(root).get(el) ?? "";
    const walk = (el) => {
      if (SKIP_SUBTREE_TAGS.has(this.localName(el.name))) return;
      const t = this.readTextSlot(el);
      if (t !== "") results.push([{ slot: "text", path: getPath(el) }, t]);
      for (const child of this.iterChildrenElements(el)) {
        walk(child);
        const tail = this.readTailSlot(child);
        if (tail !== "") results.push([{ slot: "tail", path: getPath(child) }, tail]);
      }
    };
    walk(block);
    return results;
  }

  collectDocumentUnits(root, elem, pathMap, hasBlockDescendantMap) {
    if (SKIP_SUBTREE_TAGS.has(this.localName(elem.name))) return [];
    const units = [];
    const isBlock = this.isBlockCandidate(elem);
    const hasBlockDesc = hasBlockDescendantMap.get(elem) === true;
    const elemPath = pathMap.get(elem) ?? "";

    if (isBlock && !hasBlockDesc) {
      if (this.hasRubyDescendant(elem)) {
        const text = this.buildCanonicalBlockText(elem);
        if (text.trim() !== "") units.push({ mode: "block_text", block_path: elemPath, text });
        return units;
      }
      units.push({
        mode: "slot_per_line",
        block_path: elemPath,
        slots: this.iterTranslatableTextSlots(root, elem, pathMap),
      });
      return units;
    }

    let start = 0;
    const flush = (end) => {
      const text = this.buildCanonicalNodesText(elem.children.slice(start, end));
      if (text.trim() !== "") {
        units.push({ mode: "text_run", container_path: elemPath, start, end, text });
      }
    };

    for (const [idx, child] of elem.children.entries()) {
      if (!isTag(child)) continue;
      const name = this.localName(child.name);
      const boundary =
        this.isBlockCandidate(child) ||
        hasBlockDescendantMap.get(child) === true ||
        this.flattenElements(child).some((n) => {
          const tag = this.localName(n.name);
          return (
            TEXT_RUN_BOUNDARY_TAGS.has(tag) ||
            TEXT_RUN_RESOURCE_TAGS.has(tag) ||
            (SKIP_SUBTREE_TAGS.has(tag) && tag !== "rt") ||
            n.attribs.id !== undefined ||
            n.attribs.name !== undefined
          );
        });
      if (!boundary) continue;
      flush(idx);
      if (!TEXT_RUN_RESOURCE_TAGS.has(name)) {
        units.push(...this.collectDocumentUnits(root, child, pathMap, hasBlockDescendantMap));
      }
      start = idx + 1;
    }
    flush(elem.children.length);
    return units;
  }

  writeBlockTranslation(block, text) {
    let first = null;
    const walk = (element) => {
      const children = [];
      for (const node of element.children) {
        if (isText(node)) {
          if (first === null && node.data.trim() !== "") first = node;
          node.data = "";
        } else if (isTag(node)) {
          const tag = this.localName(node.name);
          if (BLOCK_TRANSLATION_RUBY_ANNOTATIONS.has(tag)) {
            const anchors = this.flattenElements(node).filter(
              (n) => n.attribs.id !== undefined || n.attribs.name !== undefined,
            );
            for (const a of anchors) children.push(new Element("span", { ...a.attribs }, []));
            continue;
          }
          if (!SKIP_SUBTREE_TAGS.has(tag) && !TEXT_RUN_RESOURCE_TAGS.has(tag)) walk(node);
          if (BLOCK_TRANSLATION_RUBY_CONTAINERS.has(tag)) {
            if (Object.keys(node.attribs).length === 0) {
              children.push(...node.children);
              continue;
            }
            node.name = "span";
          }
        }
        children.push(node);
      }
      this.replaceElementChildren(element, children);
    };
    walk(block);
    const safe = this.sanitizeXmlText(text);
    if (first !== null) first.data = safe;
    else this.replaceElementChildren(block, [new Text(safe), ...block.children]);
  }

  readFromBytes(content, relPath) {
    const entries = readZipEntries(content);
    const containerEntry = entries.get("META-INF/container.xml");
    if (!containerEntry) throw new Error("Missing META-INF/container.xml in EPUB");
    const containerRoot = this.parseXmlDocument(this.decodeBytes(containerEntry.data));
    let opfPath = null;
    for (const rf of this.findDescendants(containerRoot, "rootfile")) {
      const fp = rf.attribs["full-path"];
      if (typeof fp === "string" && fp !== "") {
        opfPath = this.normalizeEpubPath(fp);
        break;
      }
    }
    if (!opfPath) throw new Error("Missing rootfile in META-INF/container.xml");

    const opfEntry = entries.get(opfPath);
    if (!opfEntry) throw new Error(`Missing OPF file: ${opfPath}`);
    const opfRoot = this.parseOpfXml(opfEntry.data);
    const opfDir = posix.dirname(opfPath);

    const manifestItems = new Map();
    for (const manifest of this.findDescendants(opfRoot, "manifest")) {
      for (const item of this.iterChildrenElements(manifest)) {
        if (this.localName(item.name) !== "item") continue;
        const id = item.attribs.id;
        const href = item.attribs.href;
        if (id === undefined || href === undefined) continue;
        manifestItems.set(id, {
          path: this.resolveHref(opfDir, href),
          media_type: item.attribs["media-type"] ?? "",
          properties: item.attribs.properties ?? "",
        });
      }
    }

    let navPath = null;
    for (const item of manifestItems.values()) {
      if (new Set(item.properties.split(/\s+/u).filter(Boolean)).has("nav")) {
        navPath = item.path;
        break;
      }
    }

    let ncxPath = null;
    const spine = this.findDescendants(opfRoot, "spine")[0];
    const tocId = spine?.attribs.toc;
    if (tocId !== undefined && manifestItems.has(tocId)) {
      ncxPath = manifestItems.get(tocId).path;
    } else {
      for (const item of manifestItems.values()) {
        if (item.media_type.toLowerCase().endsWith("application/x-dtbncx+xml")) {
          ncxPath = item.path;
          break;
        }
      }
    }

    const spinePaths = [];
    if (spine) {
      for (const itemref of this.iterChildrenElements(spine)) {
        if (this.localName(itemref.name) !== "itemref") continue;
        const idref = itemref.attribs.idref;
        const mItem = idref === undefined ? undefined : manifestItems.get(idref);
        if (mItem && mItem.path !== "") spinePaths.push(mItem.path);
      }
    }

    const items = [];
    // OPF dc:title
    for (const metadata of this.findDescendants(opfRoot, "metadata")) {
      let foundTitle = false;
      for (const titleElem of this.iterChildrenElements(metadata)) {
        if (this.localName(titleElem.name) !== "title") continue;
        const titleText = this.normalizeSlotText(this.readTextSlot(titleElem));
        if (titleText.trim() === "") continue;
        const titlePath = this.buildElemPathMap(opfRoot).get(titleElem);
        if (titlePath) {
          items.push(
            createEpubItem({
              src: titleText,
              tag: opfPath,
              row: ROW_BASE_OPF_TITLE,
              file_path: relPath,
              extra_field: {
                epub: {
                  mode: "slot_per_line",
                  doc_path: opfPath,
                  block_path: titlePath,
                  parts: [{ slot: "text", path: titlePath }],
                  src_digest: this.sha1HexWithNullSeparator([titleText]),
                  is_opf_metadata: true,
                  metadata_tag: "dc:title",
                },
              },
            }),
          );
          foundTitle = true;
          break;
        }
      }
      if (foundTitle) break;
    }

    const processed = new Set();
    for (const [spineIndex, docPath] of spinePaths.entries()) {
      if (!this.isHtmlDocumentPath(docPath)) continue;
      const entry = entries.get(docPath);
      if (!entry) continue;
      items.push(...this.extractItemsFromDocument(docPath, entry.data, spineIndex, relPath, navPath === docPath));
      processed.add(docPath);
    }

    if (navPath && !processed.has(navPath) && this.isHtmlDocumentPath(navPath)) {
      const entry = entries.get(navPath);
      if (entry) {
        items.push(
          ...this.extractItemsFromDocument(
            navPath,
            entry.data,
            Math.floor(ROW_BASE_NAV / ROW_MULTIPLIER),
            relPath,
            true,
          ),
        );
      }
    }

    if (ncxPath) {
      const entry = entries.get(ncxPath);
      if (entry) {
        items.push(...this.extractItemsFromNcx(ncxPath, entry.data, relPath));
      }
    }

    return items;
  }

  extractItemsFromDocument(docPath, raw, spineIndex, relPath, isNav = false) {
    const root = this.parseXhtmlOrHtml(raw);
    const pathMap = this.buildElemPathMap(root);
    const hasBlockDescendantMap = new Map();
    for (const elem of [...pathMap.keys()].reverse()) {
      const hasChild = this.iterChildrenElements(elem).some(
        (c) => this.isBlockCandidate(c) || hasBlockDescendantMap.get(c) === true,
      );
      hasBlockDescendantMap.set(elem, hasChild);
    }

    const units = this.collectDocumentUnits(root, root, pathMap, hasBlockDescendantMap);
    const items = [];
    for (const unit of units) {
      const texts =
        unit.mode === "slot_per_line"
          ? unit.slots.map(([, t]) => this.normalizeSlotText(t))
          : [this.normalizeSlotText(unit.text)];
      const src = texts.join("\n");
      if (src.trim() === "") continue;
      const epub = {
        mode: unit.mode,
        doc_path: docPath,
        is_nav: isNav,
        src_digest:
          unit.mode === "slot_per_line"
            ? this.sha1HexWithNullSeparator(texts)
            : this.sha1Hex(src),
      };
      if (unit.mode === "text_run") {
        epub.container_path = unit.container_path;
        epub.start = unit.start;
        epub.end = unit.end;
      } else {
        epub.block_path = unit.block_path;
        if (unit.mode === "slot_per_line") {
          epub.parts = unit.slots.map(([ref]) => ({ slot: ref.slot, path: ref.path }));
        }
      }
      items.push(
        createEpubItem({
          src,
          tag: docPath,
          row: spineIndex * ROW_MULTIPLIER + items.length,
          file_path: relPath,
          extra_field: { epub },
        }),
      );
    }
    return items;
  }

  extractItemsFromNcx(ncxPath, raw, relPath) {
    const root = this.parseNcxXml(raw);
    const items = [];
    for (const [elem, elemPath] of this.iterElemPathPairs(root)) {
      if (this.localName(elem.name) !== "text") continue;
      const text = this.normalizeSlotText(this.readTextSlot(elem));
      if (text.trim() === "") continue;
      items.push(
        createEpubItem({
          src: text,
          tag: ncxPath,
          row: ROW_BASE_NCX + items.length,
          file_path: relPath,
          extra_field: {
            epub: {
              mode: "slot_per_line",
              doc_path: ncxPath,
              block_path: elemPath,
              parts: [{ slot: "text", path: elemPath }],
              src_digest: this.sha1Hex(text),
            },
          },
        }),
      );
    }
    return items;
  }
}

export class EpubWriter {
  constructor({ target_language = "ZH" } = {}) {
    this.ast = new EpubAst();
    this.preserveReadingLayout = EPUB_READING_LAYOUT_TARGET_LANGUAGES.has(
      String(target_language).trim().toUpperCase(),
    );
  }

  buildEpubBuffer(originalEpubBytes, items, bilingual = false) {
    const byDoc = new Map();
    for (const item of items.filter((i) => i.file_type === "EPUB")) {
      const epub = item.extra_field?.epub;
      if (!epub || typeof epub !== "object") continue;
      const docPath = String(epub.doc_path ?? item.tag ?? "");
      if (!docPath) continue;
      const bucket = byDoc.get(docPath) ?? [];
      bucket.push(item);
      byDoc.set(docPath, bucket);
    }
    for (const docItems of byDoc.values()) {
      docItems.sort((a, b) => a.row - b.row);
    }

    const sourceEntries = readZipEntries(originalEpubBytes);
    const outputZip = new Map();
    outputZip.set("mimetype", "application/epub+zip");

    let opfTitleSyncPair = null;
    for (const [name, entry] of sourceEntries) {
      if (entry.dir || !name.toLowerCase().endsWith(".opf")) continue;
      const pair = this.#writeOpfDoc(outputZip, name, entry.data, byDoc.get(name) ?? [], bilingual);
      opfTitleSyncPair ??= pair;
    }

    for (const [name, entry] of sourceEntries) {
      if (entry.dir || name === "mimetype" || name.toLowerCase().endsWith(".opf")) continue;
      const raw = entry.data;
      const lower = name.toLowerCase();
      const isHtml = this.ast.isHtmlDocumentPath(name);

      if (lower.endsWith(".css")) {
        outputZip.set(name, this.#sanitizeCss(this.ast.decodeBytes(raw)));
        continue;
      }
      if ((isHtml || lower.endsWith(".ncx")) && (byDoc.has(name) || (opfTitleSyncPair !== null && isHtml))) {
        this.#writeAstContentDoc(outputZip, name, raw, byDoc.get(name) ?? [], bilingual, opfTitleSyncPair);
        continue;
      }
      outputZip.set(name, raw);
    }

    return writeZipBuffer(outputZip, { compression: "STORE" });
  }

  writeEpubFile(originalEpubBytes, items, outPath, bilingual = false) {
    const buf = this.buildEpubBuffer(originalEpubBytes, items, bilingual);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return buf;
  }

  #readOutputText(item, requiresText) {
    const text = readTranslationForGen(item) ?? item.src;
    return requiresText && text.trim() === "" ? item.src : text;
  }

  #sanitizeOpf(text) {
    return this.preserveReadingLayout ? text : text.replace('page-progression-direction="rtl"', "");
  }

  #sanitizeCss(text) {
    return this.preserveReadingLayout ? text : text.replace(CSS_VERTICAL_WRITING_PATTERN, "");
  }

  #removeVerticalStyle(elem) {
    if (elem.attribs.class !== undefined) {
      const cleaned = elem.attribs.class.replace(/[hv]rtl|[hv]ltr/giu, "").trim();
      if (cleaned === "") delete elem.attribs.class;
      else elem.attribs.class = cleaned.split(/\s+/u).join(" ");
    }
    if (elem.attribs.style !== undefined) {
      const cleaned = elem.attribs.style.replace(CSS_VERTICAL_WRITING_PATTERN, "").trim();
      if (cleaned === "") delete elem.attribs.style;
      else elem.attribs.style = cleaned;
    }
  }

  #resolveDocSyntax(name, root) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".opf") || lower.endsWith(".ncx") || lower.endsWith(".xhtml") || lower.endsWith(".xhtm")) {
      return "xml";
    }
    if (root.attribs.xmlns === "http://www.w3.org/1999/xhtml") return "xml";
    if (root.name.includes(":") || (root.name.startsWith("{") && root.name.includes("}"))) return "xml";
    return "html";
  }

  #serializeDoc(name, root) {
    if (!this.preserveReadingLayout && this.ast.isHtmlDocumentPath(name)) {
      for (const el of this.ast.flattenElements(root)) this.#removeVerticalStyle(el);
    }
    const syntax = this.#resolveDocSyntax(name, root);
    const rendered = serializeDomNode(root, { xmlMode: syntax === "xml" });
    return syntax === "html" ? rendered : `<?xml version="1.0" encoding="utf-8"?>\n${rendered}`;
  }

  #writeOpfDoc(outputZip, name, raw, docItems, bilingual) {
    if (docItems.length === 0) {
      outputZip.set(name, this.#sanitizeOpf(this.ast.decodeBytes(raw)));
      return null;
    }
    try {
      const root = this.ast.parseOpfXml(raw);
      const [applied, title] = this.#applyItemsToTree(root, name, docItems, bilingual);
      const text = applied > 0 ? this.#serializeDoc(name, root) : this.ast.decodeBytes(raw);
      outputZip.set(name, this.#sanitizeOpf(text));
      return title;
    } catch {
      outputZip.set(name, this.#sanitizeOpf(this.ast.decodeBytes(raw)));
      return null;
    }
  }

  #writeAstContentDoc(outputZip, name, raw, docItems, bilingual, opfTitleSyncPair) {
    try {
      const root = name.toLowerCase().endsWith(".ncx")
        ? this.ast.parseNcxXml(raw)
        : this.ast.parseXhtmlOrHtml(raw);
      let changed = false;
      if (docItems.length > 0) {
        this.#applyItemsToTree(root, name, docItems, bilingual);
        changed = true;
      }
      if (opfTitleSyncPair !== null && this.ast.isHtmlDocumentPath(name)) {
        const [srcTitle, dstTitle] = opfTitleSyncPair;
        for (const head of this.ast.findDescendants(root, "head")) {
          for (const titleElem of this.ast.iterChildrenElements(head)) {
            if (this.ast.localName(titleElem.name) !== "title") continue;
            if (this.ast.normalizeSlotText(this.ast.readTextSlot(titleElem)) === srcTitle) {
              this.ast.writeTextSlot(titleElem, this.ast.sanitizeXmlText(dstTitle));
              changed = true;
            }
          }
        }
      }
      outputZip.set(name, changed ? this.#serializeDoc(name, root) : raw);
    } catch {
      outputZip.set(name, raw);
    }
  }

  #resolveTextRuns(elemByPath, items) {
    const runs = new Map();
    for (const item of items) {
      const epub = item.extra_field?.epub;
      if (epub?.mode !== "text_run") continue;
      const { container_path, start, end } = epub;
      if (!container_path || !Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;
      const container = elemByPath.get(container_path);
      if (!container || end > container.children.length) continue;
      const nodes = container.children.slice(start, end);
      if (this.ast.sha1Hex(this.ast.buildCanonicalNodesText(nodes)) !== epub.src_digest) continue;
      runs.set(item, { container, nodes });
    }
    return runs;
  }

  #applyTextRun(run, item, text, bilingual) {
    if (item.src === text) return;
    const { container, nodes } = run;
    const start = container.children.indexOf(nodes[0]);
    const replacements = [];
    if (bilingual) {
      const original = new Element("span", { style: "opacity:0.50;" }, []);
      this.ast.replaceElementChildren(original, nodes);
      replacements.push(original);
      if (text !== "") replacements.push(new Element("br", {}, []));
    }
    if (text !== "" || !bilingual) replacements.push(new Text(this.ast.sanitizeXmlText(text)));
    const children = [...container.children];
    children.splice(start, nodes.length, ...replacements);
    this.ast.replaceElementChildren(container, children);
  }

  #collectBilingualBlockRef(root, elemByPath, blockPath, blockRefs, insertedBlockPaths) {
    if (!blockPath || insertedBlockPaths.has(blockPath)) return;
    const blockElem = elemByPath.get(blockPath) ?? this.ast.findByPath(root, blockPath);
    if (!blockElem) return;
    blockRefs.push([blockElem, cloneNode(blockElem, true)]);
    insertedBlockPaths.add(blockPath);
  }

  #applyItemsToTree(root, docPath, items, bilingual) {
    let title = null;
    let applied = 0;
    const lower = docPath.toLowerCase();
    const isNcx = lower.endsWith(".ncx") || this.ast.localName(root.name) === "ncx";
    const isOpf = lower.endsWith(".opf") || this.ast.localName(root.name).toLowerCase() === "package";
    const isNavFlag = items.some((i) => i.extra_field?.epub?.is_nav === true);
    const allowBilingual = bilingual && !this.ast.isNavPage(root) && !isNavFlag && !isNcx && !isOpf;

    const elemByPath = this.ast.buildElemByPath(root);
    const textRuns = this.#resolveTextRuns(elemByPath, items);
    const blockRefs = [];
    const insertedBlockPaths = new Set();

    for (const item of items) {
      const epub = item.extra_field?.epub;
      if (!epub) continue;
      const mode = String(epub.mode ?? "");
      const itemDst = this.#readOutputText(item, isOpf || isNcx || isNavFlag);

      if (mode === "text_run") {
        const run = textRuns.get(item);
        if (run) {
          this.#applyTextRun(run, item, itemDst, allowBilingual);
          applied += 1;
        }
        continue;
      }

      if (mode === "block_text") {
        const blockPath = String(epub.block_path ?? "");
        const srcDigest = String(epub.src_digest ?? "");
        const blockElem = elemByPath.get(blockPath) ?? this.ast.findByPath(root, blockPath);
        if (blockElem && this.ast.sha1Hex(this.ast.buildCanonicalBlockText(blockElem)) === srcDigest) {
          if (item.src !== itemDst) {
            if (allowBilingual) {
              this.#collectBilingualBlockRef(root, elemByPath, blockPath, blockRefs, insertedBlockPaths);
            }
            this.ast.writeBlockTranslation(blockElem, itemDst);
          }
          applied += 1;
        }
        continue;
      }

      if (mode === "slot_per_line" && Array.isArray(epub.parts) && epub.parts.length > 0 && epub.src_digest) {
        const dstLines = distributeTextToSlots(itemDst, epub.parts.length);
        const currentTexts = [];
        const resolved = [];
        let ok = true;
        for (const part of epub.parts) {
          const slot = String(part?.slot ?? "");
          const elemPath = String(part?.path ?? "");
          if (slot !== "text" && slot !== "tail") {
            ok = false;
            break;
          }
          const elem = elemByPath.get(elemPath) ?? this.ast.findByPath(root, elemPath);
          if (!elem) {
            ok = false;
            break;
          }
          currentTexts.push(
            this.ast.normalizeSlotText(slot === "text" ? this.ast.readTextSlot(elem) : this.ast.readTailSlot(elem)),
          );
          resolved.push([slot, elem]);
        }
        if (!ok || this.ast.sha1HexWithNullSeparator(currentTexts) !== epub.src_digest) continue;

        if (allowBilingual && item.src !== itemDst) {
          this.#collectBilingualBlockRef(
            root,
            elemByPath,
            String(epub.block_path ?? ""),
            blockRefs,
            insertedBlockPaths,
          );
        }
        resolved.forEach(([slot, elem], idx) => {
          const safe = this.ast.sanitizeXmlText(dstLines[idx] ?? "");
          if (slot === "text") this.ast.writeTextSlot(elem, safe);
          else this.ast.writeTailSlot(elem, safe);
        });
        applied += 1;
        if (
          epub.is_opf_metadata === true &&
          epub.metadata_tag === "dc:title" &&
          item.status === "PROCESSED" &&
          itemDst !== item.src &&
          splitTextLines(item.src).length === 1 &&
          splitTextLines(itemDst).length === 1
        ) {
          title ??= [item.src, itemDst];
        }
      }
    }

    if (allowBilingual) {
      for (const [block, clone] of [...blockRefs].reverse()) {
        const parent = block.parent;
        if (!(parent instanceof Element)) continue;
        const style = String(clone.attribs.style ?? "").replace(/;+$/u, "");
        clone.attribs.style = `${style}${style === "" ? "" : ";"}opacity:0.50;`;
        const idx = parent.children.indexOf(block);
        if (idx < 0) continue;
        parent.children.splice(idx, 0, clone);
        relinkChildren(parent);
      }
    }
    return [applied, title];
  }
}

export class EPUBFormat {
  constructor(config = {}) {
    this.ast = new EpubAst();
    this.writer = new EpubWriter(config);
  }

  readFromBytes(content, relPath) {
    return this.ast.readFromBytes(content, relPath);
  }

  writeToPaths(items, originalBytes, { translated_path, bilingual_path, rel_path, write_bilingual = false }) {
    this.writer.writeEpubFile(originalBytes, items, path.join(translated_path, rel_path), false);
    if (write_bilingual && bilingual_path) {
      this.writer.writeEpubFile(originalBytes, items, path.join(bilingual_path, rel_path), true);
    }
  }
}
