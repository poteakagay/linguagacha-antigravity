import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  hasLanguageBodyCharacter,
  hasLanguageCharacter,
  normalizeLanguageCode,
} from "../core/language.mjs";
import { buildProofreadingContext, evaluateProofreadingItem } from "../core/proofreading.mjs";
import { removeTextResourceReferences } from "../core/text-rules.mjs";
import { readZipEntries } from "../core/zip.mjs";
import {
  generateProjectFiles,
  inspectSourcesOnDisk,
  parseAssetBytes,
} from "../formats/index.mjs";
import {
  AGENT_WORKSPACE_CHANGE_OPERATIONS,
  AGENT_WORKSPACE_CHANGE_PATHS,
  AGENT_WORKSPACE_CONTRACT,
  AGENT_WORKSPACE_PATHS,
  AGENT_WORKSPACE_QUALITY_ENTRY_PATHS,
  AGENT_WORKSPACE_REFERENCES,
  ALL_WORKSPACE_CHANGE_FILE_PATHS,
  ITEM_MANUAL_STATUSES,
  PROMPT_KINDS,
  QUALITY_BUSINESS_FIELDS,
  QUALITY_RULE_KINDS,
  insertBySort,
  itemFingerprint,
  knowledgeFingerprint,
  promptFingerprint,
  qualityFingerprint,
} from "./contract.mjs";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeJsonlFile(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(filePath, text === "" ? "" : text + "\n", "utf8");
}

function readChangeRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.trim() === "") return [];
  const lines = raw.replace(/\r\n|\r/gu, "\n").split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    if (lineText.trim() === "") continue;
    const line = i + 1;
    try {
      const parsed = JSON.parse(lineText);
      if (isPlainObject(parsed)) {
        rows.push({ line, value: parsed });
      } else {
        rows.push({ line, value: {}, error: "Each change line must contain a JSON object." });
      }
    } catch {
      rows.push({ line, value: {}, error: "Change line contains invalid JSON." });
    }
  }
  return rows;
}

const RULE_PREFILTER_PREFIXES = ["mapdata/", "se/", "bgs/", "0=", "bgm/", "ficon/"];
const RULE_PREFILTER_PATTERNS = [
  /^EV\d+$/iu,
  /^DejaVu Sans$/iu,
  /^Opendyslexic$/iu,
  /^\{#file_time\}/iu,
];

function shouldSkipLineByRule(rawLine) {
  const line = rawLine.trim();
  if (line === "") return true;
  const norm = line.toLowerCase();
  const stripped = removeTextResourceReferences(line);
  return (
    !hasLanguageBodyCharacter(stripped) ||
    RULE_PREFILTER_PREFIXES.some((p) => norm.startsWith(p)) ||
    RULE_PREFILTER_PATTERNS.some((re) => re.test(norm))
  );
}

function prefilterImportedItemStatus(item, sourceLanguage) {
  if (item.status && item.status !== "NONE") return item.status;
  const src = String(item.src ?? "");
  const nameSrc = typeof item.name_src === "string" ? item.name_src : "";
  const srcLines = src.replace(/\r\n|\r/gu, "\n").split("\n");
  const srcHasCandidate = !srcLines.every(shouldSkipLineByRule);
  const nameHasCandidate =
    nameSrc.trim() !== "" && hasLanguageBodyCharacter(removeTextResourceReferences(nameSrc));

  if (!srcHasCandidate && !nameHasCandidate) {
    return "RULE_SKIPPED";
  }

  if (sourceLanguage && sourceLanguage !== "ALL") {
    const matchesLang =
      (srcHasCandidate && hasLanguageCharacter(src, sourceLanguage)) ||
      (nameHasCandidate && hasLanguageCharacter(nameSrc, sourceLanguage));
    if (!matchesLang) {
      return "LANGUAGE_SKIPPED";
    }
  }
  return "NONE";
}

function duplicateGroupKey(item) {
  return JSON.stringify([item.file_path, item.src ?? "", item.name_src || null]);
}

export function coordinateDuplicateStatuses(items, enabled = true, affectedItemIds = null) {
  const affectedKeys =
    affectedItemIds === null
      ? null
      : new Set(items.filter((it) => affectedItemIds.has(it.item_id)).map(duplicateGroupKey));

  const groups = new Map();
  for (const item of items) {
    const key = duplicateGroupKey(item);
    if (affectedKeys !== null && !affectedKeys.has(key)) continue;
    let group = groups.get(key);
    if (!group) {
      group = { candidates: [], hasAnchor: false };
      groups.set(key, group);
    }
    if (item.status === "NONE" || item.status === "DUPLICATED") {
      group.candidates.push(item);
    } else if (item.status === "PROCESSED") {
      group.hasAnchor = true;
    }
  }

  const changedIds = new Set();
  for (const group of groups.values()) {
    group.candidates.sort((a, b) => a.item_id - b.item_id);
    group.candidates.forEach((item, idx) => {
      const targetStatus = !enabled || (!group.hasAnchor && idx === 0) ? "NONE" : "DUPLICATED";
      if (item.status !== targetStatus) {
        item.status = targetStatus;
        changedIds.add(item.item_id);
      }
    });
  }
  return changedIds;
}

function createInitialState({ name, sourceLanguage = "JA", targetLanguage = "ZH" }) {
  return {
    version: 1,
    name: name || "novel_project",
    source_language: normalizeLanguageCode(sourceLanguage) ?? "JA",
    target_language: normalizeLanguageCode(targetLanguage) ?? "ZH",
    duplicate_filter_enabled: true,
    knowledge: "# 工程知识\n\n",
    prompts: {
      translation: null,
      analysis: null,
    },
    files: [],
    items: [],
    pages: [],
    quality: {
      glossary: [],
      pre_replacement: [],
      post_replacement: [],
      text_preserve: [],
    },
    revisions: {
      files: 0,
      items: 0,
      quality: 0,
      prompts: 0,
      knowledge: 0,
      pages: 0,
    },
    next_item_id: 1,
    next_entry_seq: 1,
  };
}

function isInsidePath(root, target) {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function sanitizeRelAssetPath(relPath) {
  return relPath.replace(/\\/gu, "/").replace(/^\/+/u, "");
}

function deduplicateAssetPath(desiredPath, takenLowerSet) {
  const clean = sanitizeRelAssetPath(desiredPath);
  if (!takenLowerSet.has(clean.toLowerCase())) {
    takenLowerSet.add(clean.toLowerCase());
    return clean;
  }
  const ext = path.posix.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let counter = 2;
  while (true) {
    const candidate = `${stem}_${counter}${ext}`;
    if (!takenLowerSet.has(candidate.toLowerCase())) {
      takenLowerSet.add(candidate.toLowerCase());
      return candidate;
    }
    counter += 1;
  }
}

export class ProjectStore {
  constructor(projectDir, options = {}) {
    this.open({ projectDir, ...options });
  }

  open({
    projectDir,
    sourceLanguage,
    targetLanguage,
    duplicateFilterEnabled,
    reset = false,
    name,
  }) {
    const resolvedProjectDir = path.resolve(projectDir);
    this.projectDir = resolvedProjectDir;
    this.storageDir = path.join(resolvedProjectDir, ".lg_project");
    this.originalsDir = path.join(this.storageDir, "originals");
    this.stateFilePath = path.join(this.storageDir, "state.json");
    this.workspacePath = path.join(resolvedProjectDir, ".lg_workspace");
    this.userSkillDir =
      optionsFromEnvSkillDir() ?? path.join(this.storageDir, "user_skills");

    fs.mkdirSync(this.originalsDir, { recursive: true });
    fs.mkdirSync(this.workspacePath, { recursive: true });
    fs.mkdirSync(this.userSkillDir, { recursive: true });

    if (reset) {
      fs.rmSync(this.originalsDir, { recursive: true, force: true });
      fs.rmSync(this.workspacePath, { recursive: true, force: true });
      fs.mkdirSync(this.originalsDir, { recursive: true });
      fs.mkdirSync(this.workspacePath, { recursive: true });
    }

    if (!reset && fs.existsSync(this.stateFilePath)) {
      this.state = JSON.parse(fs.readFileSync(this.stateFilePath, "utf8"));
      let changed = false;
      if (sourceLanguage !== undefined) {
        const norm = normalizeLanguageCode(sourceLanguage);
        if (norm && norm !== this.state.source_language) {
          this.state.source_language = norm;
          changed = true;
        }
      }
      if (targetLanguage !== undefined) {
        const norm = normalizeLanguageCode(targetLanguage);
        if (norm && norm !== "ALL" && norm !== this.state.target_language) {
          this.state.target_language = norm;
          changed = true;
        }
      }
      if (typeof duplicateFilterEnabled === "boolean" && duplicateFilterEnabled !== this.state.duplicate_filter_enabled) {
        this.state.duplicate_filter_enabled = duplicateFilterEnabled;
        coordinateDuplicateStatuses(this.state.items, duplicateFilterEnabled);
        this.state.revisions.items += 1;
        changed = true;
      }
      if (name && name !== this.state.name) {
        this.state.name = name;
        changed = true;
      }
      if (changed) {
        this.saveState();
        this.clearSnapshotSync();
      }
    } else {
      this.state = createInitialState({
        name: name || path.basename(resolvedProjectDir) || "novel_project",
        sourceLanguage: sourceLanguage ?? "JA",
        targetLanguage: targetLanguage ?? "ZH",
      });
      if (typeof duplicateFilterEnabled === "boolean") {
        this.state.duplicate_filter_enabled = duplicateFilterEnabled;
      }
      this.saveState();
    }

    this.activeSnapshotKey = null;
    this.sourcesMaterializedRev = null;

    writeJsonFile(path.join(this.workspacePath, "package.json"), {
      private: true,
      type: "module",
    });
    fs.mkdirSync(path.join(this.workspacePath, "work"), { recursive: true });
    fs.mkdirSync(path.join(this.workspacePath, "uploads"), { recursive: true });

    return this.getSummary();
  }

  saveState() {
    writeFileAtomic(this.stateFilePath, JSON.stringify(this.state, null, 2) + "\n");
  }

  #currentSnapshotKey() {
    return JSON.stringify({
      projectDir: this.projectDir,
      source_language: this.state.source_language,
      target_language: this.state.target_language,
      revisions: this.state.revisions,
    });
  }

  isSnapshotFresh() {
    return (
      this.activeSnapshotKey !== null &&
      this.activeSnapshotKey === this.#currentSnapshotKey() &&
      fs.existsSync(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.contract)) &&
      fs.existsSync(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.projectMeta))
    );
  }

  getSummary() {
    const statusCounts = {};
    for (const item of this.state.items) {
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    }
    return {
      project_dir: this.projectDir.replace(/\\/gu, "/"),
      workspace_dir: this.workspacePath.replace(/\\/gu, "/"),
      name: this.state.name,
      source_language: this.state.source_language,
      target_language: this.state.target_language,
      duplicate_filter_enabled: this.state.duplicate_filter_enabled,
      counts: {
        files: this.state.files.length,
        items: this.state.items.length,
        glossary: this.state.quality.glossary.length,
        text_preserve: this.state.quality.text_preserve.length,
        pre_replacement: this.state.quality.pre_replacement.length,
        post_replacement: this.state.quality.post_replacement.length,
      },
      item_statuses: statusCounts,
      files: this.state.files.map((f) => ({
        file_path: f.file_path,
        file_type: f.file_type,
      })),
    };
  }

  readOriginalAssetBytes(filePath) {
    const full = path.join(this.originalsDir, filePath);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full);
  }

  writeOriginalAssetBytes(filePath, bytes) {
    const full = path.join(this.originalsDir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  }

  removeOriginalAssetBytes(filePath) {
    const full = path.join(this.originalsDir, filePath);
    fs.rmSync(full, { recursive: true, force: true });
  }

  computeWarnings() {
    const context = buildProofreadingContext({
      glossary: { enabled: true, entries: this.state.quality.glossary },
      pre_replacement: {
        enabled: this.state.quality.pre_replacement.length > 0,
        entries: this.state.quality.pre_replacement,
      },
      text_preserve: {
        mode: this.state.quality.text_preserve.length > 0 ? "custom" : "smart",
        entries: this.state.quality.text_preserve,
      },
    });

    const fileOrder = new Map(this.state.files.map((f, idx) => [f.file_path, idx]));
    const orderedItems = [...this.state.items].sort(
      (a, b) =>
        (fileOrder.get(a.file_path) ?? 0) - (fileOrder.get(b.file_path) ?? 0) ||
        a.row_number - b.row_number ||
        a.item_id - b.item_id,
    );

    const warningRecords = [];
    for (const item of orderedItems) {
      const evaluated = evaluateProofreadingItem(item, context, {
        source_language: this.state.source_language,
        target_language: this.state.target_language,
      });
      if (evaluated.warnings.length > 0) {
        warningRecords.push({
          item_id: item.item_id,
          warnings: evaluated.warnings,
          glossary_applications: evaluated.glossary_applications,
        });
      }
    }
    return { orderedItems, warningRecords };
  }

  clearSnapshotSync() {
    this.activeSnapshotKey = null;
    const targets = [
      AGENT_WORKSPACE_PATHS.knowledge,
      AGENT_WORKSPACE_PATHS.projectMeta,
      AGENT_WORKSPACE_PATHS.contract,
      AGENT_WORKSPACE_PATHS.reference,
      "items",
      "pages",
      AGENT_WORKSPACE_PATHS.prompts,
      ...QUALITY_RULE_KINDS,
      "changes",
    ];
    for (const rel of targets) {
      fs.rmSync(path.join(this.workspacePath, rel), { recursive: true, force: true });
    }
  }

  clearSourcesSync() {
    this.sourcesMaterializedRev = null;
    fs.rmSync(path.join(this.workspacePath, "sources"), { recursive: true, force: true });
    fs.rmSync(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.sourceIssues), { force: true });
  }

  ensureSources() {
    if (
      this.sourcesMaterializedRev === this.state.revisions.files &&
      fs.existsSync(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.sourceIssues))
    ) {
      return;
    }

    this.clearSourcesSync();
    const sourcesRoot = path.join(this.workspacePath, "sources");
    fs.mkdirSync(sourcesRoot, { recursive: true });
    const issues = [];

    for (const fileMeta of this.state.files) {
      const relPath = fileMeta.file_path;
      const origBytes = this.readOriginalAssetBytes(relPath);
      if (!origBytes) {
        issues.push({
          asset_path: relPath,
          stage: "read_asset",
          message: "Original asset bytes missing in project store.",
        });
        continue;
      }

      const targetPath = path.join(sourcesRoot, relPath);
      const ext = path.extname(relPath).toLowerCase();
      if (ext === ".epub" || ext === ".generic" || fileMeta.is_container) {
        try {
          const entries = readZipEntries(origBytes);
          fs.mkdirSync(targetPath, { recursive: true });
          for (const [memberName, entry] of entries.entries()) {
            if (entry.dir || entry.isDir) continue;
            const safeMember = memberName.replace(/\\/gu, "/").replace(/^\/+/u, "");
            if (safeMember.split("/").includes("..")) continue;
            const memberPath = path.join(targetPath, safeMember);
            fs.mkdirSync(path.dirname(memberPath), { recursive: true });
            fs.writeFileSync(memberPath, entry.data);
          }
        } catch (err) {
          issues.push({
            asset_path: relPath,
            stage: "unpack_container",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, origBytes);
      }
    }

    writeJsonlFile(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.sourceIssues), issues);
    this.sourcesMaterializedRev = this.state.revisions.files;
  }

  ensureSnapshot() {
    if (!this.isSnapshotFresh()) {
      this.clearSnapshotSync();

      const { orderedItems, warningRecords } = this.computeWarnings();
      const knowledgeFp = knowledgeFingerprint(this.state.knowledge);

      const projectMeta = {
        knowledge: { fp: knowledgeFp },
        source_language: this.state.source_language,
        target_language: this.state.target_language,
        counts: {
          files: this.state.files.length,
          items: orderedItems.length,
          pages: this.state.pages.length,
          items_with_warnings: warningRecords.length,
          ...Object.fromEntries(
            QUALITY_RULE_KINDS.map((k) => [k, this.state.quality[k].length]),
          ),
        },
        files: this.state.files.map((f) => ({
          file_path: f.file_path,
          file_type: f.file_type,
        })),
      };

      fs.writeFileSync(
        path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.knowledge),
        this.state.knowledge,
        "utf8",
      );
      for (const [refRelPath, refContent] of Object.entries(AGENT_WORKSPACE_REFERENCES)) {
        const fullRefPath = path.join(this.workspacePath, refRelPath);
        fs.mkdirSync(path.dirname(fullRefPath), { recursive: true });
        fs.writeFileSync(fullRefPath, refContent, "utf8");
      }

      writeJsonFile(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.contract), AGENT_WORKSPACE_CONTRACT);
      writeJsonFile(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.projectMeta), projectMeta);
      writeJsonlFile(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.pages), []);

      const workspaceItems = orderedItems.map((it) => {
        const row = {
          item_id: it.item_id,
          src: it.src ?? "",
          dst: it.dst ?? "",
          name_src: it.name_src ?? "",
          name_dst: it.name_dst ?? "",
          file_path: it.file_path,
          row_number: it.row_number ?? 0,
          status: it.status ?? "NONE",
        };
        return {
          item_id: row.item_id,
          fp: itemFingerprint(row),
          src: row.src,
          dst: row.dst,
          name_src: row.name_src,
          name_dst: row.name_dst,
          file_path: row.file_path,
          row_number: row.row_number,
          status: row.status,
        };
      });
      writeJsonlFile(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.items), workspaceItems);
      writeJsonlFile(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.warnings), warningRecords);

      const promptsObj = Object.fromEntries(
        PROMPT_KINDS.map((k) => [
          k,
          {
            fp: promptFingerprint(k, this.state.prompts[k] ?? null),
            text: this.state.prompts[k] ?? null,
          },
        ]),
      );
      writeJsonFile(path.join(this.workspacePath, AGENT_WORKSPACE_PATHS.prompts), promptsObj);

      for (const kind of QUALITY_RULE_KINDS) {
        const fields = QUALITY_BUSINESS_FIELDS[kind];
        const rows = this.state.quality[kind].map((entry, idx) => {
          const base = {
            id: entry.entry_id,
            ...Object.fromEntries(fields.map((f) => [f, entry[f]])),
          };
          return {
            id: entry.entry_id,
            fp: qualityFingerprint(kind, base),
            sort: idx,
            ...Object.fromEntries(fields.map((f) => [f, entry[f]])),
          };
        });
        writeJsonlFile(path.join(this.workspacePath, AGENT_WORKSPACE_QUALITY_ENTRY_PATHS[kind]), rows);
      }

      for (const changeRelPath of ALL_WORKSPACE_CHANGE_FILE_PATHS) {
        const fullChangePath = path.join(this.workspacePath, changeRelPath);
        fs.mkdirSync(path.dirname(fullChangePath), { recursive: true });
        fs.writeFileSync(fullChangePath, "", "utf8");
      }

      this.activeSnapshotKey = this.#currentSnapshotKey();
    }

    this.ensureSources();
    fs.mkdirSync(path.join(this.workspacePath, "work"), { recursive: true });
    fs.mkdirSync(path.join(this.workspacePath, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(this.workspacePath, ".run"), { recursive: true });
    for (const changeRelPath of ALL_WORKSPACE_CHANGE_FILE_PATHS) {
      fs.mkdirSync(path.dirname(path.join(this.workspacePath, changeRelPath)), { recursive: true });
    }
  }

  resolveSourceInputPath(rawSourcePath) {
    if (path.isAbsolute(rawSourcePath)) {
      return path.resolve(rawSourcePath);
    }
    const normalized = rawSourcePath.replace(/\\/gu, "/");
    if (/^(uploads|work)\//u.test(normalized)) {
      const target = path.resolve(this.workspacePath, normalized);
      if (!isInsidePath(this.workspacePath, target)) {
        throw new Error(`Invalid workspace-relative source_path: ${rawSourcePath}`);
      }
      return target;
    }
    const fromProject = path.resolve(this.projectDir, normalized);
    if (fs.existsSync(fromProject)) {
      return fromProject;
    }
    throw new Error(
      `Invalid source_path "${rawSourcePath}": use an absolute path or a path starting with uploads/ or work/.`,
    );
  }

  inspectSources(sourcePaths) {
    return sourcePaths.map((rawPath) => {
      let resolved;
      try {
        resolved = this.resolveSourceInputPath(rawPath);
      } catch (err) {
        return {
          source_path: rawPath,
          files: [],
          godot_packs: [],
          failures: [{ path: rawPath, message: err instanceof Error ? err.message : String(err) }],
        };
      }
      const [entry] = inspectSourcesOnDisk([resolved], this.workspacePath);
      return {
        ...entry,
        source_path: rawPath,
      };
    });
  }

  getOutputPaths(directory) {
    const parentDir = directory ? path.resolve(directory) : this.projectDir;
    const baseName = this.state.name || path.basename(this.projectDir) || "output";
    const pickUnique = (suffix) => {
      let candidate = path.join(parentDir, `${baseName}_${suffix}`);
      let idx = 2;
      while (fs.existsSync(candidate)) {
        candidate = path.join(parentDir, `${baseName}_${suffix}_${idx}`);
        idx += 1;
      }
      return candidate.replace(/\\/gu, "/");
    };
    return {
      manual: false,
      translated_path: pickUnique("译文"),
      bilingual_path: pickUnique("双语对照"),
    };
  }

  generateFiles(bilingualFiles = []) {
    const stagingRoot = path.join(this.workspacePath, "work", crypto.randomUUID());
    const translatedPath = path.join(stagingRoot, "translated");
    const bilingualPath = path.join(stagingRoot, "bilingual");
    const writebackInputPath = path.join(stagingRoot, "writeback_input");

    return generateProjectFiles({
      files: this.state.files,
      items: this.state.items,
      readOriginalAssetBytes: (relPath) => this.readOriginalAssetBytes(relPath),
      translatedPath,
      bilingualPath,
      writebackInputPath,
      bilingualFiles,
      targetLanguage: this.state.target_language,
    });
  }

  applyWorkspace() {
    if (this.activeSnapshotKey === null) {
      throw new Error(
        "agent_workspace_missing: Workspace snapshot has not been initialized yet. Call workspace_run first.",
      );
    }

    const parsed = this.#parseAllChanges();
    const hasFileRows =
      parsed.files.creates.length > 0 ||
      parsed.files.updates.length > 0 ||
      parsed.files.deletes.length > 0 ||
      parsed.rejected.some((r) => r.scope === "files");

    if (hasFileRows) {
      return this.#applyFileBatch(parsed);
    }
    return this.#applyContentBatch(parsed);
  }

  #parseAllChanges() {
    const rejected = [];

    const knowledge = [];
    for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS.knowledge.updates))) {
      if (row.error) {
        rejected.push({ scope: "knowledge", op: "update", reason: "invalid_change", line: row.line, message: row.error });
      } else if (typeof row.value.fp !== "string" || row.value.fp === "" || typeof row.value.text !== "string") {
        rejected.push({ scope: "knowledge", op: "update", reason: "invalid_change", line: row.line, message: "knowledge update requires string fp and string text." });
      } else if (Buffer.byteLength(row.value.text, "utf8") > 4 * 1024 * 1024) {
        rejected.push({ scope: "knowledge", op: "update", reason: "invalid_change", line: row.line, message: "knowledge text exceeds 4 MiB." });
      } else {
        knowledge.push({ line: row.line, fp: row.value.fp, text: row.value.text });
      }
    }

    const items = [];
    for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS.items.updates))) {
      if (row.error) {
        rejected.push({ scope: "items", op: "update", reason: "invalid_change", line: row.line, message: row.error });
        continue;
      }
      const v = row.value;
      const allowedKeys = new Set(["item_id", "fp", "dst", "name_dst", "status"]);
      const unknownKey = Object.keys(v).find((k) => !allowedKeys.has(k));
      const hasMutation = "dst" in v || "name_dst" in v || "status" in v;
      const validStatus = v.status === undefined || ITEM_MANUAL_STATUSES.includes(v.status);
      const validDst = v.dst === undefined || typeof v.dst === "string";
      const validNameDst = v.name_dst === undefined || v.name_dst === null || typeof v.name_dst === "string";
      if (
        unknownKey !== undefined ||
        !Number.isInteger(v.item_id) ||
        v.item_id < 1 ||
        typeof v.fp !== "string" ||
        v.fp === "" ||
        !hasMutation ||
        !validStatus ||
        !validDst ||
        !validNameDst
      ) {
        rejected.push({
          scope: "items",
          op: "update",
          reason: "invalid_change",
          line: row.line,
          ...(typeof v.item_id === "number" ? { id: v.item_id } : {}),
          message: "Invalid item update record.",
        });
        continue;
      }
      const { item_id, fp, ...update } = v;
      items.push({ line: row.line, item_id, fp, update });
    }

    const prompts = [];
    for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS.prompts.updates))) {
      if (row.error) {
        rejected.push({ scope: "prompts", op: "update", reason: "invalid_change", line: row.line, message: row.error });
        continue;
      }
      const v = row.value;
      if (
        !PROMPT_KINDS.includes(v.kind) ||
        typeof v.fp !== "string" ||
        v.fp === "" ||
        !(typeof v.text === "string" || v.text === null)
      ) {
        rejected.push({ scope: "prompts", op: "update", reason: "invalid_change", line: row.line, message: "Invalid prompt update record." });
        continue;
      }
      prompts.push({ line: row.line, kind: v.kind, fp: v.fp, text: v.text });
    }

    const pages = [];
    for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS.pages.updates))) {
      rejected.push({
        scope: "pages",
        op: "update",
        reason: row.error ? "invalid_change" : "target_missing",
        line: row.line,
        message: row.error ?? "PDF pages are not supported in novel plugin mode.",
      });
    }

    const quality = {};
    for (const kind of QUALITY_RULE_KINDS) {
      const creates = [];
      const updates = [];
      const deletes = [];
      const fields = QUALITY_BUSINESS_FIELDS[kind];

      for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS[kind].creates))) {
        if (row.error || !this.#validateQualityCreate(kind, row.value)) {
          rejected.push({
            scope: "quality",
            op: "create",
            kind,
            reason: "invalid_change",
            line: row.line,
            ...(typeof row.value?.src === "string" && row.value.src !== "" ? { src: row.value.src } : {}),
            message: row.error ?? `Invalid ${kind} create record.`,
          });
          continue;
        }
        const { sort, ...rest } = row.value;
        creates.push({ line: row.line, kind, sort, fields: rest });
      }

      for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS[kind].updates))) {
        if (row.error || !this.#validateQualityUpdate(kind, row.value)) {
          rejected.push({
            scope: "quality",
            op: "update",
            kind,
            reason: "invalid_change",
            line: row.line,
            ...(typeof row.value?.id === "string" ? { id: row.value.id } : {}),
            message: row.error ?? `Invalid ${kind} update record.`,
          });
          continue;
        }
        const { id, fp, sort, ...rest } = row.value;
        const picked = {};
        for (const f of fields) {
          if (f in rest && rest[f] !== undefined) picked[f] = rest[f];
        }
        updates.push({
          line: row.line,
          kind,
          id,
          fp,
          fields: picked,
          ...(sort !== undefined ? { sort } : {}),
        });
      }

      for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS[kind].deletes))) {
        if (
          row.error ||
          typeof row.value.id !== "string" ||
          row.value.id === "" ||
          typeof row.value.fp !== "string" ||
          row.value.fp === "" ||
          Object.keys(row.value).length !== 2
        ) {
          rejected.push({
            scope: "quality",
            op: "delete",
            kind,
            reason: "invalid_change",
            line: row.line,
            ...(typeof row.value?.id === "string" ? { id: row.value.id } : {}),
            message: row.error ?? `Invalid ${kind} delete record.`,
          });
          continue;
        }
        deletes.push({ line: row.line, kind, id: row.value.id, fp: row.value.fp });
      }

      quality[kind] = { creates, updates, deletes };
    }

    const files = { creates: [], updates: [], deletes: [] };
    for (const op of AGENT_WORKSPACE_CHANGE_OPERATIONS) {
      for (const row of readChangeRows(path.join(this.workspacePath, AGENT_WORKSPACE_CHANGE_PATHS.files[op]))) {
        const v = row.value;
        if (row.error) {
          rejected.push({ scope: "files", op: op === "creates" ? "create" : op === "updates" ? "update" : "delete", reason: "invalid_change", line: row.line, message: row.error });
          continue;
        }
        if (op === "creates") {
          const validInh = v.inheritance_mode === undefined || v.inheritance_mode === "none" || v.inheritance_mode === "inherit";
          if (typeof v.source_path !== "string" || v.source_path.trim() === "" || !validInh) {
            rejected.push({ scope: "files", op: "create", reason: "invalid_change", line: row.line, message: "Invalid file create record." });
          } else {
            files.creates.push({ line: row.line, source_path: v.source_path, inheritance_mode: v.inheritance_mode ?? "none" });
          }
        } else if (op === "updates") {
          const hasMut = typeof v.new_file_path === "string" || (Number.isInteger(v.sort) && v.sort >= -1);
          if (typeof v.file_path !== "string" || v.file_path.trim() === "" || !hasMut) {
            rejected.push({ scope: "files", op: "update", reason: "invalid_change", line: row.line, file_path: v.file_path, message: "Invalid file update record." });
          } else {
            files.updates.push({ line: row.line, file_path: v.file_path, new_file_path: v.new_file_path, sort: v.sort });
          }
        } else {
          if (typeof v.file_path !== "string" || v.file_path.trim() === "") {
            rejected.push({ scope: "files", op: "delete", reason: "invalid_change", line: row.line, message: "Invalid file delete record." });
          } else {
            files.deletes.push({ line: row.line, file_path: v.file_path });
          }
        }
      }
    }

    return { batch: { knowledge, items, prompts, pages, quality }, files, rejected };
  }

  #validateQualityCreate(kind, v) {
    if (!Number.isInteger(v.sort) || v.sort < -1) return false;
    const fields = QUALITY_BUSINESS_FIELDS[kind];
    const allowed = new Set([...fields, "sort"]);
    if (Object.keys(v).some((k) => !allowed.has(k))) return false;
    if (typeof v.src !== "string" || v.src.trim() === "") return false;
    if (kind === "glossary") {
      return typeof v.dst === "string" && typeof v.info === "string" && typeof v.case_sensitive === "boolean";
    }
    if (kind === "text_preserve") {
      return typeof v.info === "string";
    }
    if (kind === "pre_replacement" || kind === "post_replacement") {
      if (typeof v.dst !== "string" || typeof v.regex !== "boolean" || typeof v.case_sensitive !== "boolean") return false;
      if (v.regex) {
        try {
          new RegExp(v.src, v.case_sensitive ? "gu" : "giu");
        } catch {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  #validateQualityUpdate(kind, v) {
    if (typeof v.id !== "string" || v.id === "" || typeof v.fp !== "string" || v.fp === "") return false;
    const fields = QUALITY_BUSINESS_FIELDS[kind];
    const allowed = new Set(["id", "fp", "sort", ...fields]);
    if (Object.keys(v).some((k) => !allowed.has(k))) return false;
    if (Object.keys(v).length < 3) return false;
    if (v.sort !== undefined && (!Number.isInteger(v.sort) || v.sort < -1)) return false;
    if (v.src !== undefined && (typeof v.src !== "string" || v.src.trim() === "")) return false;
    if (kind === "glossary") {
      if (v.dst !== undefined && typeof v.dst !== "string") return false;
      if (v.info !== undefined && typeof v.info !== "string") return false;
      if (v.case_sensitive !== undefined && typeof v.case_sensitive !== "boolean") return false;
    } else if (kind === "text_preserve") {
      if (v.info !== undefined && typeof v.info !== "string") return false;
    } else {
      if (v.dst !== undefined && typeof v.dst !== "string") return false;
      if (v.regex !== undefined && typeof v.regex !== "boolean") return false;
      if (v.case_sensitive !== undefined && typeof v.case_sensitive !== "boolean") return false;
    }
    return true;
  }

  #applyFileBatch(parsed) {
    const rejected = [...parsed.rejected];

    // 文件批次不能包含其他变更
    const hasContentChanges =
      parsed.batch.knowledge.length > 0 ||
      parsed.batch.items.length > 0 ||
      parsed.batch.prompts.length > 0 ||
      parsed.batch.pages.length > 0 ||
      QUALITY_RULE_KINDS.some(
        (k) =>
          parsed.batch.quality[k].creates.length > 0 ||
          parsed.batch.quality[k].updates.length > 0 ||
          parsed.batch.quality[k].deletes.length > 0,
      );

    if (hasContentChanges) {
      rejected.push({
        scope: "files",
        op: "create",
        reason: "invalid_change",
        line: 1,
        message: "File batch cannot be mixed with content changes.",
      });
    }

    const currentFileMap = new Map(this.state.files.map((f) => [f.file_path, f]));
    const seenTargets = new Set();
    for (const del of parsed.files.deletes) {
      if (seenTargets.has(del.file_path)) {
        rejected.push({ scope: "files", op: "delete", reason: "merge_conflict", line: del.line, file_path: del.file_path });
      } else if (!currentFileMap.has(del.file_path)) {
        rejected.push({ scope: "files", op: "delete", reason: "target_missing", line: del.line, file_path: del.file_path });
      }
      seenTargets.add(del.file_path);
    }

    for (const upd of parsed.files.updates) {
      if (seenTargets.has(upd.file_path)) {
        rejected.push({ scope: "files", op: "update", reason: "merge_conflict", line: upd.line, file_path: upd.file_path });
      } else if (!currentFileMap.has(upd.file_path)) {
        rejected.push({ scope: "files", op: "update", reason: "target_missing", line: upd.line, file_path: upd.file_path });
      } else if (upd.new_file_path !== undefined) {
        const oldExt = path.posix.extname(upd.file_path).toLowerCase();
        const newExt = path.posix.extname(upd.new_file_path).toLowerCase();
        if (oldExt !== newExt) {
          rejected.push({ scope: "files", op: "update", reason: "invalid_change", line: upd.line, file_path: upd.file_path, message: "Renaming must preserve file extension." });
        }
      }
      seenTargets.add(upd.file_path);
    }

    const seenCreateSources = new Set();
    const resolvedCreates = [];
    for (const cr of parsed.files.creates) {
      if (seenCreateSources.has(cr.source_path)) {
        rejected.push({ scope: "files", op: "create", reason: "merge_conflict", line: cr.line, source_path: cr.source_path });
        continue;
      }
      seenCreateSources.add(cr.source_path);
      try {
        const resolved = this.resolveSourceInputPath(cr.source_path);
        const [inspected] = inspectSourcesOnDisk([resolved], this.workspacePath);
        if (inspected.failures.length > 0 || inspected.files.length === 0) {
          rejected.push({
            scope: "files",
            op: "create",
            reason: "source_failed",
            line: cr.line,
            source_path: cr.source_path,
            message: inspected.failures[0]?.message ?? "No supported files found in source_path.",
          });
        } else {
          resolvedCreates.push({ ...cr, resolvedPath: resolved, discoveredFiles: inspected.files });
        }
      } catch (err) {
        rejected.push({
          scope: "files",
          op: "create",
          reason: "source_failed",
          line: cr.line,
          source_path: cr.source_path,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (rejected.length > 0) {
      const destroyed = rejected.some((r) => r.reason === "fp_mismatch" || r.reason === "target_missing");
      if (destroyed) this.clearSnapshotSync();
      return {
        status: "rejected",
        applied: {},
        rejected,
        destroyed,
        revisions: { ...this.state.revisions },
      };
    }

    // Build inheritance lookup from existing PROCESSED items before deletions/additions
    const existingInheritancePool = new Map();
    for (const item of this.state.items) {
      if (item.status === "PROCESSED" && (item.dst ?? "") !== "") {
        const key = JSON.stringify([item.src ?? "", item.name_src ?? ""]);
        let freqMap = existingInheritancePool.get(key);
        if (!freqMap) {
          freqMap = new Map();
          existingInheritancePool.set(key, freqMap);
        }
        const valKey = JSON.stringify([item.dst ?? "", item.name_dst ?? ""]);
        freqMap.set(valKey, (freqMap.get(valKey) ?? 0) + 1);
      }
    }

    // 1. Deletes
    const deleteSet = new Set(parsed.files.deletes.map((d) => d.file_path));
    for (const fp of deleteSet) {
      this.removeOriginalAssetBytes(fp);
    }
    this.state.items = this.state.items.filter((it) => !deleteSet.has(it.file_path));

    // 2. Updates (renames & sort)
    const updateByPath = new Map(parsed.files.updates.map((u) => [u.file_path, u]));
    const keptFiles = [];
    const sortedUpdates = [];

    for (const fileMeta of this.state.files) {
      if (deleteSet.has(fileMeta.file_path)) continue;
      const upd = updateByPath.get(fileMeta.file_path);
      if (!upd) {
        keptFiles.push(fileMeta);
        continue;
      }
      let nextPath = fileMeta.file_path;
      if (upd.new_file_path && upd.new_file_path !== fileMeta.file_path) {
        nextPath = sanitizeRelAssetPath(upd.new_file_path);
        const origBytes = this.readOriginalAssetBytes(fileMeta.file_path);
        if (origBytes) {
          this.writeOriginalAssetBytes(nextPath, origBytes);
          this.removeOriginalAssetBytes(fileMeta.file_path);
        }
        for (const it of this.state.items) {
          if (it.file_path === fileMeta.file_path) it.file_path = nextPath;
        }
      }
      const nextMeta = { ...fileMeta, file_path: nextPath };
      if (upd.sort !== undefined) {
        sortedUpdates.push({ value: nextMeta, sort: upd.sort, rank: 0, line: upd.line });
      } else {
        keptFiles.push(nextMeta);
      }
    }

    const reorderedFiles = insertBySort(keptFiles, sortedUpdates);
    const takenLowerPaths = new Set(reorderedFiles.map((f) => f.file_path.toLowerCase()));

    // 3. Creates
    const createdSummaries = [];
    for (const cr of resolvedCreates) {
      const isDirSource = fs.statSync(cr.resolvedPath).isDirectory();
      const baseDir = isDirSource ? cr.resolvedPath : path.dirname(cr.resolvedPath);
      let fileCount = 0;
      let itemCount = 0;
      let inheritedCount = 0;
      const contestedGroupsByKey = new Map();
      const renamed = [];
      const parseFailed = [];

      for (const disc of cr.discoveredFiles) {
        const diskPath = path.resolve(disc.path);
        const desiredRel = sanitizeRelAssetPath(
          isDirSource
            ? path.posix.join(path.basename(cr.resolvedPath), path.relative(baseDir, diskPath).replace(/\\/gu, "/"))
            : path.basename(diskPath),
        );
        const assignedRel = deduplicateAssetPath(desiredRel, takenLowerPaths);
        if (assignedRel !== desiredRel) {
          renamed.push({ from: desiredRel, to: assignedRel });
        }

        const rawBytes = fs.readFileSync(diskPath);
        this.writeOriginalAssetBytes(assignedRel, rawBytes);
        fileCount += 1;

        try {
          const parsedAsset = parseAssetBytes(rawBytes, assignedRel, {
            targetLanguage: this.state.target_language,
          });
          reorderedFiles.push({
            file_path: assignedRel,
            file_type: parsedAsset.file_type,
            is_container: Boolean(parsedAsset.is_container),
          });

          const newFileItems = [];
          for (let idx = 0; idx < parsedAsset.items.length; idx += 1) {
            const rawItem = parsedAsset.items[idx];
            const itemId = this.state.next_item_id++;
            const status = prefilterImportedItemStatus(rawItem, this.state.source_language);
            const itemRecord = {
              ...rawItem,
              item_id: itemId,
              file_path: assignedRel,
              file_type: parsedAsset.file_type,
              row_number: rawItem.row_number ?? idx,
              src: rawItem.src ?? "",
              dst: rawItem.dst ?? "",
              name_src: rawItem.name_src ?? null,
              name_dst: rawItem.name_dst ?? null,
              status,
            };

            if (cr.inheritance_mode === "inherit" && itemRecord.status === "NONE") {
              const inhKey = JSON.stringify([itemRecord.src, itemRecord.name_src ?? ""]);
              const freqMap = existingInheritancePool.get(inhKey);
              if (freqMap && freqMap.size > 0) {
                const sortedCandidates = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
                const [bestDst, bestNameDst] = JSON.parse(sortedCandidates[0][0]);
                itemRecord.dst = bestDst;
                if (itemRecord.name_src !== null && bestNameDst !== "") {
                  itemRecord.name_dst = bestNameDst;
                }
                itemRecord.status = "PROCESSED";
                inheritedCount += 1;
                if (freqMap.size > 1) {
                  const list = contestedGroupsByKey.get(inhKey) ?? [];
                  list.push(itemId);
                  contestedGroupsByKey.set(inhKey, list);
                }
              }
            }

            newFileItems.push(itemRecord);
          }

          coordinateDuplicateStatuses(newFileItems, this.state.duplicate_filter_enabled);
          this.state.items.push(...newFileItems);
          itemCount += newFileItems.length;
        } catch {
          reorderedFiles.push({
            file_path: assignedRel,
            file_type: "NONE",
            is_container: false,
          });
          parseFailed.push(assignedRel);
        }
      }

      createdSummaries.push({
        source_path: cr.source_path,
        files: fileCount,
        items: itemCount,
        pages: 0,
        inherited: inheritedCount,
        contested: [...contestedGroupsByKey.values()],
        renamed,
        parse_failed: parseFailed,
      });
    }

    this.state.files = reorderedFiles;
    this.state.revisions.files += 1;
    this.state.revisions.items += 1;
    this.saveState();
    this.clearSnapshotSync();
    this.clearSourcesSync();

    return {
      status: "applied",
      applied: {
        files: {
          created: createdSummaries,
          updated: parsed.files.updates.length,
          deleted: parsed.files.deletes.length,
        },
      },
      rejected: [],
      destroyed: true,
      revisions: { ...this.state.revisions },
    };
  }

  #applyContentBatch(parsed) {
    const rejected = [...parsed.rejected];
    const applied = {};

    // 1. Knowledge
    let nextKnowledge = null;
    if (parsed.batch.knowledge.length > 1) {
      for (const k of parsed.batch.knowledge) {
        rejected.push({ scope: "knowledge", op: "update", reason: "merge_conflict", line: k.line });
      }
    } else if (parsed.batch.knowledge.length === 1) {
      const intent = parsed.batch.knowledge[0];
      const currentFp = knowledgeFingerprint(this.state.knowledge);
      if (intent.fp !== currentFp) {
        rejected.push({ scope: "knowledge", op: "update", reason: "fp_mismatch", line: intent.line });
      } else if (intent.text !== this.state.knowledge) {
        nextKnowledge = intent.text;
      }
    }

    // 2. Prompts
    const promptIntentsByKind = new Map();
    const promptChanges = [];
    for (const p of parsed.batch.prompts) {
      const list = promptIntentsByKind.get(p.kind) ?? [];
      list.push(p);
      promptIntentsByKind.set(p.kind, list);
    }
    for (const [kind, intents] of promptIntentsByKind.entries()) {
      if (intents.length > 1) {
        for (const p of intents) {
          rejected.push({ scope: "prompts", op: "update", kind, reason: "merge_conflict", line: p.line });
        }
        continue;
      }
      const intent = intents[0];
      const curText = this.state.prompts[kind] ?? null;
      const curFp = promptFingerprint(kind, curText);
      if (intent.fp !== curFp) {
        rejected.push({ scope: "prompts", op: "update", kind, reason: "fp_mismatch", line: intent.line });
      } else if (intent.text !== curText) {
        promptChanges.push({ kind, text: intent.text });
      }
    }

    // 3. Items
    const currentItemById = new Map(this.state.items.map((it) => [it.item_id, it]));
    const itemIntentsById = new Map();
    for (const intent of parsed.batch.items) {
      const list = itemIntentsById.get(intent.item_id) ?? [];
      list.push(intent);
      itemIntentsById.set(intent.item_id, list);
    }

    const validItemUpdates = [];
    for (const [itemId, intents] of itemIntentsById.entries()) {
      if (intents.length > 1) {
        for (const it of intents) {
          rejected.push({ scope: "items", op: "update", id: itemId, reason: "merge_conflict", line: it.line });
        }
        continue;
      }
      const intent = intents[0];
      const cur = currentItemById.get(itemId);
      if (!cur) {
        rejected.push({ scope: "items", op: "update", id: itemId, reason: "target_missing", line: intent.line });
        continue;
      }
      const curFp = itemFingerprint({
        item_id: cur.item_id,
        src: cur.src ?? "",
        dst: cur.dst ?? "",
        name_src: cur.name_src ?? "",
        name_dst: cur.name_dst ?? "",
        file_path: cur.file_path,
        row_number: cur.row_number ?? 0,
        status: cur.status ?? "NONE",
      });
      if (intent.fp !== curFp) {
        rejected.push({ scope: "items", op: "update", id: itemId, reason: "fp_mismatch", line: intent.line });
        continue;
      }
      validItemUpdates.push({ cur, update: intent.update });
    }

    // 4. Quality Rules
    const qualityPlans = {};
    for (const kind of QUALITY_RULE_KINDS) {
      const intents = parsed.batch.quality[kind];
      if (intents.creates.length === 0 && intents.updates.length === 0 && intents.deletes.length === 0) {
        continue;
      }
      const plan = this.#resolveQualityKind(kind, intents, this.state.quality[kind], rejected);
      if (plan.changed) {
        qualityPlans[kind] = plan;
      }
    }

    // Commit valid mutations
    if (nextKnowledge !== null) {
      this.state.knowledge = nextKnowledge;
      this.state.revisions.knowledge += 1;
      applied.knowledge = { updated: 1 };
    }

    if (promptChanges.length > 0) {
      for (const ch of promptChanges) {
        this.state.prompts[ch.kind] = ch.text;
      }
      this.state.revisions.prompts += 1;
      applied.prompts = { updated: promptChanges.map((c) => c.kind) };
    }

    if (validItemUpdates.length > 0) {
      const statusChangedIds = new Set();
      const updatedIds = new Set();

      for (const { cur, update } of validItemUpdates) {
        const prevDst = cur.dst ?? "";
        const prevNameDst = cur.name_dst ?? "";
        const prevStatus = cur.status ?? "NONE";

        let nextDst = prevDst;
        let nextNameDst = cur.name_dst;
        if ("dst" in update && update.dst !== undefined) {
          nextDst = update.dst;
        }
        if ("name_dst" in update) {
          nextNameDst = update.name_dst === "" ? null : update.name_dst;
        }

        const contentChanged = nextDst !== prevDst || (nextNameDst ?? "") !== prevNameDst;
        let nextStatus = prevStatus;
        if (update.status !== undefined) {
          nextStatus = update.status;
        } else if (contentChanged) {
          nextStatus = "PROCESSED";
        }

        if (contentChanged || nextStatus !== prevStatus) {
          cur.dst = nextDst;
          cur.name_dst = nextNameDst;
          cur.status = nextStatus;
          updatedIds.add(cur.item_id);
          if (nextStatus !== prevStatus) {
            statusChangedIds.add(cur.item_id);
          }
        }
      }

      if (statusChangedIds.size > 0) {
        const dupChanged = coordinateDuplicateStatuses(
          this.state.items,
          this.state.duplicate_filter_enabled,
          statusChangedIds,
        );
        for (const id of dupChanged) updatedIds.add(id);
      }

      if (updatedIds.size > 0) {
        this.state.revisions.items += 1;
        applied.items = { updated: updatedIds.size };
      }
    }

    const appliedQualityKinds = Object.keys(qualityPlans);
    if (appliedQualityKinds.length > 0) {
      applied.quality = {};
      for (const kind of appliedQualityKinds) {
        this.state.quality[kind] = qualityPlans[kind].entries;
        applied.quality[kind] = qualityPlans[kind].summary;
      }
      this.state.revisions.quality += 1;
    }

    const hasApplied = Object.keys(applied).length > 0;
    if (hasApplied) {
      this.saveState();
    }

    const status =
      hasApplied && rejected.length > 0
        ? "partial"
        : hasApplied
          ? "applied"
          : rejected.length > 0
            ? "rejected"
            : "unchanged";

    const destroyed =
      hasApplied ||
      rejected.some((r) => r.reason === "fp_mismatch" || r.reason === "target_missing");

    if (destroyed) {
      this.clearSnapshotSync();
    }

    return {
      status,
      applied,
      rejected,
      destroyed,
      revisions: { ...this.state.revisions },
    };
  }

  #resolveQualityKind(kind, intents, currentEntries, rejectedOut) {
    const fields = QUALITY_BUSINESS_FIELDS[kind];
    const currentById = new Map(currentEntries.map((e, idx) => [e.entry_id, { entry: e, idx }]));
    const touchedIds = new Map();

    for (const del of intents.deletes) {
      touchedIds.set(del.id, (touchedIds.get(del.id) ?? 0) + 1);
    }
    for (const upd of intents.updates) {
      touchedIds.set(upd.id, (touchedIds.get(upd.id) ?? 0) + 1);
    }

    const validDeletes = new Set();
    for (const del of intents.deletes) {
      if ((touchedIds.get(del.id) ?? 0) > 1) {
        rejectedOut.push({ scope: "quality", op: "delete", kind, id: del.id, reason: "merge_conflict", line: del.line });
        continue;
      }
      const found = currentById.get(del.id);
      if (!found) {
        rejectedOut.push({ scope: "quality", op: "delete", kind, id: del.id, reason: "target_missing", line: del.line });
        continue;
      }
      const fp = qualityFingerprint(kind, { id: found.entry.entry_id, ...found.entry });
      if (del.fp !== fp) {
        rejectedOut.push({ scope: "quality", op: "delete", kind, id: del.id, reason: "fp_mismatch", line: del.line });
        continue;
      }
      validDeletes.add(del.id);
    }

    const validUpdatesById = new Map();
    for (const upd of intents.updates) {
      if ((touchedIds.get(upd.id) ?? 0) > 1) {
        rejectedOut.push({ scope: "quality", op: "update", kind, id: upd.id, reason: "merge_conflict", line: upd.line });
        continue;
      }
      const found = currentById.get(upd.id);
      if (!found) {
        rejectedOut.push({ scope: "quality", op: "update", kind, id: upd.id, reason: "target_missing", line: upd.line });
        continue;
      }
      const fp = qualityFingerprint(kind, { id: found.entry.entry_id, ...found.entry });
      if (upd.fp !== fp) {
        rejectedOut.push({ scope: "quality", op: "update", kind, id: upd.id, reason: "fp_mismatch", line: upd.line });
        continue;
      }
      const merged = { ...found.entry, ...upd.fields };
      if ((kind === "pre_replacement" || kind === "post_replacement") && merged.regex) {
        try {
          new RegExp(merged.src, merged.case_sensitive ? "gu" : "giu");
        } catch {
          rejectedOut.push({
            scope: "quality",
            op: "update",
            kind,
            id: upd.id,
            reason: "invalid_change",
            line: upd.line,
            message: "Invalid regular expression after update.",
          });
          continue;
        }
      }
      validUpdatesById.set(upd.id, { upd, merged, origIdx: found.idx });
    }

    // Deduplicate src keys across surviving + updated + created rules
    const ruleSrcKey = (entry) => {
      if (kind === "glossary" || kind === "pre_replacement" || kind === "post_replacement") {
        return entry.case_sensitive ? `cs:${entry.src}` : `ci:${entry.src.toLowerCase()}`;
      }
      return `tp:${entry.src}`;
    };

    const occupiedSrcKeys = new Set();
    for (const cur of currentEntries) {
      if (validDeletes.has(cur.entry_id)) continue;
      const updInfo = validUpdatesById.get(cur.entry_id);
      const effective = updInfo ? updInfo.merged : cur;
      const key = ruleSrcKey(effective);
      if (occupiedSrcKeys.has(key) && updInfo) {
        rejectedOut.push({
          scope: "quality",
          op: "update",
          kind,
          id: cur.entry_id,
          reason: "merge_conflict",
          line: updInfo.upd.line,
          message: "Duplicate rule src key.",
        });
        validUpdatesById.delete(cur.entry_id);
        occupiedSrcKeys.add(ruleSrcKey(cur));
      } else {
        occupiedSrcKeys.add(key);
      }
    }

    const validCreates = [];
    for (const cr of intents.creates) {
      const normalizedFields = Object.fromEntries(fields.map((f) => [f, cr.fields[f]]));
      const key = ruleSrcKey(normalizedFields);
      if (occupiedSrcKeys.has(key)) {
        rejectedOut.push({
          scope: "quality",
          op: "create",
          kind,
          src: normalizedFields.src,
          reason: "merge_conflict",
          line: cr.line,
          message: "Duplicate rule src key.",
        });
        continue;
      }
      occupiedSrcKeys.add(key);
      const entryId = `${kind}_${this.state.next_entry_seq++}`;
      validCreates.push({
        line: cr.line,
        sort: cr.sort,
        entry: { entry_id: entryId, ...normalizedFields },
      });
    }

    const kept = [];
    const sorted = [];
    let updatedCount = 0;

    currentEntries.forEach((cur, idx) => {
      if (validDeletes.has(cur.entry_id)) return;
      const updInfo = validUpdatesById.get(cur.entry_id);
      if (!updInfo) {
        kept.push(cur);
        return;
      }
      const fieldChanged = fields.some((f) => cur[f] !== updInfo.merged[f]);
      const sortChanged = updInfo.upd.sort !== undefined && updInfo.upd.sort !== idx;
      if (fieldChanged || sortChanged) {
        updatedCount += 1;
      }
      if (updInfo.upd.sort !== undefined) {
        sorted.push({
          value: updInfo.merged,
          sort: updInfo.upd.sort,
          rank: 0,
          line: updInfo.upd.line,
        });
      } else {
        kept.push(updInfo.merged);
      }
    });

    for (const cr of validCreates) {
      sorted.push({
        value: cr.entry,
        sort: cr.sort,
        rank: 1,
        line: cr.line,
      });
    }

    const nextEntries = insertBySort(kept, sorted);
    const changed = validDeletes.size > 0 || updatedCount > 0 || validCreates.length > 0;
    return {
      changed,
      entries: nextEntries,
      summary: {
        created: validCreates.length,
        updated: updatedCount,
        deleted: validDeletes.size,
      },
    };
  }

  /** 直接提交批量翻译产出并令工作区快照失效 */
  commitBatchTranslations(patches) {
    if (!patches || patches.length === 0) return 0;
    const byId = new Map(this.state.items.map((it) => [it.item_id, it]));
    const statusChangedIds = new Set();
    let count = 0;

    for (const patch of patches) {
      const cur = byId.get(patch.item_id);
      if (!cur) continue;
      if (patch.dst !== undefined) cur.dst = patch.dst;
      if (patch.name_dst !== undefined) {
        cur.name_dst = patch.name_dst === "" ? null : patch.name_dst;
      }
      const prevStatus = cur.status;
      cur.status = patch.status ?? "PROCESSED";
      if (cur.status !== prevStatus) {
        statusChangedIds.add(cur.item_id);
      }
      count += 1;
    }

    if (statusChangedIds.size > 0) {
      coordinateDuplicateStatuses(
        this.state.items,
        this.state.duplicate_filter_enabled,
        statusChangedIds,
      );
    }

    if (count > 0) {
      this.state.revisions.items += 1;
      this.saveState();
      this.activeSnapshotKey = null;
    }
    return count;
  }
}

function optionsFromEnvSkillDir() {
  const dir = process.env.LG_USER_SKILL_DIR;
  return dir && dir.trim() !== "" ? path.resolve(dir) : null;
}
