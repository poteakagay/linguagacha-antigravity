import crypto from "node:crypto";

export const QUALITY_RULE_KINDS = Object.freeze([
  "glossary",
  "pre_replacement",
  "post_replacement",
  "text_preserve",
]);

export const PROMPT_KINDS = Object.freeze(["translation", "analysis"]);

export const ITEM_STATUSES = Object.freeze([
  "NONE",
  "PROCESSED",
  "EXCLUDED",
  "RULE_SKIPPED",
  "LANGUAGE_SKIPPED",
  "DUPLICATED",
]);

export const ITEM_MANUAL_STATUSES = Object.freeze(["NONE", "PROCESSED", "EXCLUDED"]);

export const AGENT_WORKSPACE_PATHS = Object.freeze({
  contract: "contract.json",
  projectMeta: "project_meta.json",
  knowledge: "project-knowledge.md",
  pages: "pages/entries.jsonl",
  items: "items/entries.jsonl",
  warnings: "items/warnings.jsonl",
  prompts: "prompts.json",
  reference: "reference",
  sourceIssues: "source_issues.jsonl",
});

export const AGENT_WORKSPACE_QUALITY_ENTRY_PATHS = Object.freeze({
  glossary: "glossary/entries.jsonl",
  pre_replacement: "pre_replacement/entries.jsonl",
  post_replacement: "post_replacement/entries.jsonl",
  text_preserve: "text_preserve/entries.jsonl",
});

export const AGENT_WORKSPACE_CHANGE_OPERATIONS = Object.freeze(["creates", "updates", "deletes"]);

export const AGENT_WORKSPACE_CHANGE_PATHS = Object.freeze({
  knowledge: Object.freeze({ updates: "changes/knowledge/updates.jsonl" }),
  files: Object.freeze({
    creates: "changes/files/creates.jsonl",
    updates: "changes/files/updates.jsonl",
    deletes: "changes/files/deletes.jsonl",
  }),
  pages: Object.freeze({ updates: "changes/pages/updates.jsonl" }),
  items: Object.freeze({ updates: "changes/items/updates.jsonl" }),
  prompts: Object.freeze({ updates: "changes/prompts/updates.jsonl" }),
  glossary: Object.freeze({
    creates: "changes/glossary/creates.jsonl",
    updates: "changes/glossary/updates.jsonl",
    deletes: "changes/glossary/deletes.jsonl",
  }),
  pre_replacement: Object.freeze({
    creates: "changes/pre_replacement/creates.jsonl",
    updates: "changes/pre_replacement/updates.jsonl",
    deletes: "changes/pre_replacement/deletes.jsonl",
  }),
  post_replacement: Object.freeze({
    creates: "changes/post_replacement/creates.jsonl",
    updates: "changes/post_replacement/updates.jsonl",
    deletes: "changes/post_replacement/deletes.jsonl",
  }),
  text_preserve: Object.freeze({
    creates: "changes/text_preserve/creates.jsonl",
    updates: "changes/text_preserve/updates.jsonl",
    deletes: "changes/text_preserve/deletes.jsonl",
  }),
});

export const ALL_WORKSPACE_CHANGE_FILE_PATHS = Object.freeze([
  AGENT_WORKSPACE_CHANGE_PATHS.knowledge.updates,
  AGENT_WORKSPACE_CHANGE_PATHS.files.creates,
  AGENT_WORKSPACE_CHANGE_PATHS.files.updates,
  AGENT_WORKSPACE_CHANGE_PATHS.files.deletes,
  AGENT_WORKSPACE_CHANGE_PATHS.pages.updates,
  AGENT_WORKSPACE_CHANGE_PATHS.items.updates,
  AGENT_WORKSPACE_CHANGE_PATHS.prompts.updates,
  ...QUALITY_RULE_KINDS.flatMap((kind) =>
    AGENT_WORKSPACE_CHANGE_OPERATIONS.map((op) => AGENT_WORKSPACE_CHANGE_PATHS[kind][op]),
  ),
]);

export const QUALITY_BUSINESS_FIELDS = Object.freeze({
  glossary: ["src", "dst", "info", "case_sensitive"],
  pre_replacement: ["src", "dst", "regex", "case_sensitive"],
  post_replacement: ["src", "dst", "regex", "case_sensitive"],
  text_preserve: ["src", "info"],
});

function deepFreeze(value) {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const referencePath = (topic) => `${AGENT_WORKSPACE_PATHS.reference}/${topic}.md`;

export const AGENT_WORKSPACE_CONTRACT = deepFreeze({
  datasets: {
    pages: {
      path: AGENT_WORKSPACE_PATHS.pages,
      reference: referencePath("pages"),
      purpose: "全部原稿页面，每行对应一个原稿页",
    },
    project_meta: {
      path: AGENT_WORKSPACE_PATHS.projectMeta,
      reference: referencePath("project_meta"),
      purpose: "工程语言、完整数量、文件顺序与知识指纹",
    },
    items: {
      path: AGENT_WORKSPACE_PATHS.items,
      reference: referencePath("items"),
      purpose: "全部翻译条目，正文与姓名属于同一条目",
    },
    warnings: {
      path: AGENT_WORKSPACE_PATHS.warnings,
      reference: referencePath("items"),
      purpose: "当前快照的校对警告与字段级证据，按 `item_id` 关联条目",
    },
    prompts: {
      path: AGENT_WORKSPACE_PATHS.prompts,
      reference: referencePath("prompts"),
      purpose: "当前翻译提示词",
    },
    ...Object.fromEntries(
      QUALITY_RULE_KINDS.map((kind) => [
        kind,
        {
          path: AGENT_WORKSPACE_QUALITY_ENTRY_PATHS[kind],
          reference: referencePath(kind),
          purpose: `全部 ${kind} 规则，按当前顺序排列`,
        },
      ]),
    ),
  },
  changes: {
    knowledge: {
      updates: {
        path: AGENT_WORKSPACE_CHANGE_PATHS.knowledge.updates,
        reference: referencePath("knowledge"),
      },
    },
    files: Object.fromEntries(
      AGENT_WORKSPACE_CHANGE_OPERATIONS.map((op) => [
        op,
        {
          path: AGENT_WORKSPACE_CHANGE_PATHS.files[op],
          reference: referencePath("files"),
        },
      ]),
    ),
    pages: {
      updates: {
        path: AGENT_WORKSPACE_CHANGE_PATHS.pages.updates,
        reference: referencePath("pages"),
      },
    },
    items: {
      updates: {
        path: AGENT_WORKSPACE_CHANGE_PATHS.items.updates,
        reference: referencePath("items"),
      },
    },
    prompts: {
      updates: {
        path: AGENT_WORKSPACE_CHANGE_PATHS.prompts.updates,
        reference: referencePath("prompts"),
      },
    },
    ...Object.fromEntries(
      QUALITY_RULE_KINDS.map((kind) => [
        kind,
        Object.fromEntries(
          AGENT_WORKSPACE_CHANGE_OPERATIONS.map((op) => [
            op,
            {
              path: AGENT_WORKSPACE_CHANGE_PATHS[kind][op],
              reference: referencePath(kind),
            },
          ]),
        ),
      ]),
    ),
  },
});

const SORT_NOTES = [
  "排序时，先移除删除对象和指定了 `sort` 的对象，其余对象保留相对顺序，再按 `sort` 从小到大插入，`-1` 最后追加。",
  "插入位置相同时，先放更新，再放新增，各自按变更文件中的行序排列。",
];

function buildQualityReferenceMarkdown(kind, fieldsTs) {
  const entryPath = AGENT_WORKSPACE_QUALITY_ENTRY_PATHS[kind];
  const changePaths = AGENT_WORKSPACE_CHANGE_PATHS[kind];
  const optionalFieldsTs = fieldsTs
    .split("\n")
    .map((line) => line.replace(/^(\s*\w+):/u, "$1?:"))
    .join("\n");
  return [
    `# ${kind} 工作区参考`,
    "",
    `- \`ws.contract.datasets.${kind}.path\`：\`${entryPath}\`，记录类型为 \`Dataset_${kind}\`。`,
    `- \`ws.contract.changes.${kind}.creates.path\`：\`${changePaths.creates}\`，记录类型为 \`Change_${kind}_creates\`。`,
    `- \`ws.contract.changes.${kind}.updates.path\`：\`${changePaths.updates}\`，记录类型为 \`Change_${kind}_updates\`。`,
    `- \`ws.contract.changes.${kind}.deletes.path\`：\`${changePaths.deletes}\`，记录类型为 \`Change_${kind}_deletes\`。`,
    "",
    "```ts",
    "/** 从当前快照原样复制对象指纹，提交时用它检查对象是否已变化。 */",
    "type WorkspaceFingerprint = string;",
    `type Dataset_${kind} = {`,
    "  id: string;",
    "  fp: WorkspaceFingerprint;",
    "  /** 当前在数组中的位置，从 0 开始。 */",
    "  sort: number;",
    fieldsTs,
    "};",
    "/** 提供全部业务字段和排序位置，由宿主分配对象标识。 */",
    `type Change_${kind}_creates = {`,
    fieldsTs,
    "  /** -1 表示追加到末尾。非负值表示从 0 开始的插入位置，超出当前长度时追加到末尾。 */",
    "  sort: number;",
    "};",
    "/** 提供对象身份、指纹，以及至少一个业务字段或排序位置。省略的字段保留当前值。 */",
    `type Change_${kind}_updates = {`,
    "  id: string;",
    "  fp: WorkspaceFingerprint;",
    optionalFieldsTs,
    "  sort?: number;",
    "};",
    `type Change_${kind}_deletes = {`,
    "  id: string;",
    "  fp: WorkspaceFingerprint;",
    "};",
    "```",
    "",
    ...SORT_NOTES.map((n) => `- ${n}`),
    "",
  ].join("\n");
}

export const AGENT_WORKSPACE_REFERENCES = deepFreeze({
  [referencePath("project_meta")]: [
    "# project_meta 工作区参考",
    "",
    `- \`ws.contract.datasets.project_meta.path\`：\`${AGENT_WORKSPACE_PATHS.projectMeta}\`，记录类型为 \`Dataset_project_meta\`。`,
    "",
    "```ts",
    "type Dataset_project_meta = {",
    "  knowledge: { fp: string };",
    "  source_language: string;",
    "  target_language: string;",
    "  counts: {",
    "    files: number;",
    "    items: number;",
    "    pages: number;",
    "    items_with_warnings: number;",
    "    glossary: number;",
    "    text_preserve: number;",
    "    pre_replacement: number;",
    "    post_replacement: number;",
    "  };",
    "  files: Array<{ file_path: string; file_type: string }>;",
    "};",
    "```",
    "",
    `- \`files\` 列出全部资产，原稿位于 \`sources/<file_path>\`。\`knowledge\` 是工程知识的指纹，正文位于 \`${AGENT_WORKSPACE_PATHS.knowledge}\`。`,
    "",
  ].join("\n"),

  [referencePath("knowledge")]: [
    "# knowledge 工作区参考",
    "",
    `- \`ws.contract.changes.knowledge.updates.path\`：\`${AGENT_WORKSPACE_CHANGE_PATHS.knowledge.updates}\`，记录类型为 \`Change_knowledge_updates\`。`,
    "",
    "```ts",
    "type Change_knowledge_updates = {",
    "  fp: string;",
    "  text: string;",
    "};",
    "```",
    "",
    "- `fp` 从 `project_meta.json` 的 `knowledge` 复制。`text` 是整篇最终正文，UTF-8 编码不超过 4 MiB。",
    "",
  ].join("\n"),

  [referencePath("files")]: [
    "# files 工作区参考",
    "",
    `- \`ws.contract.changes.files.creates.path\`：\`${AGENT_WORKSPACE_CHANGE_PATHS.files.creates}\`，记录类型为 \`Change_files_creates\`。`,
    `- \`ws.contract.changes.files.updates.path\`：\`${AGENT_WORKSPACE_CHANGE_PATHS.files.updates}\`，记录类型为 \`Change_files_updates\`。`,
    `- \`ws.contract.changes.files.deletes.path\`：\`${AGENT_WORKSPACE_CHANGE_PATHS.files.deletes}\`，记录类型为 \`Change_files_deletes\`。`,
    "",
    "```ts",
    "/** 只指定来源，资产名称由宿主在提交时分配。 */",
    "type Change_files_creates = {",
    "  /** 待加入的文件或文件夹。使用本机绝对路径，或以 `uploads/`、`work/` 开头、相对工作区根目录的路径。 */",
    "  source_path: string;",
    "  /** `inherit` 用工程现有条目的已完成译文填充新条目，缺省为 `none`。 */",
    "  inheritance_mode?: 'none' | 'inherit';",
    "  godot_pack_orders?: Array<{ game_root: string; ordered_pcks: string[] }>;",
    "};",
    "/** 提供目标资产和至少一个 `new_file_path` 或 `sort`。 */",
    "type Change_files_updates = {",
    "  file_path: string;",
    "  new_file_path?: string;",
    "  sort?: number;",
    "};",
    "type Change_files_deletes = {",
    "  file_path: string;",
    "};",
    "```",
    "",
    "- 同一 `file_path` 在本批只能出现在一条更新或删除记录中，同一 `source_path` 只能新增一次。",
    "- 新增资产与已有名称冲突时，宿主自动加 `_2`、`_3` 等数字后缀，实际名称以回执为准。",
    "- `new_file_path` 不能与本批开始时仍保留的其他资产相同，比较不区分大小写，本批删除的资产会释放名称，因此同批不能交换名称或链式改名。",
    "- 改名保留原扩展名，新路径每段须为跨平台合法文件名。",
    "- 删除资产会从工程中移除它的原稿、条目、页面和译文。",
    "- 新资产在其余变化之后按新增记录的顺序追加到末尾。",
    ...SORT_NOTES.map((n) => `- ${n}`),
    "",
  ].join("\n"),

  [referencePath("items")]: [
    "# items 工作区参考",
    "",
    `- \`ws.contract.datasets.items.path\`：\`${AGENT_WORKSPACE_PATHS.items}\`，记录类型为 \`Dataset_items\`。`,
    `- \`ws.contract.datasets.warnings.path\`：\`${AGENT_WORKSPACE_PATHS.warnings}\`，记录类型为 \`Dataset_warnings\`。`,
    `- \`ws.contract.changes.items.updates.path\`：\`${AGENT_WORKSPACE_CHANGE_PATHS.items.updates}\`，记录类型为 \`Change_items_updates\`。`,
    "",
    "```ts",
    "type ItemStatus = 'NONE' | 'PROCESSED' | 'EXCLUDED' | 'RULE_SKIPPED' | 'LANGUAGE_SKIPPED' | 'DUPLICATED';",
    "type Dataset_items = {",
    "  item_id: number;",
    "  fp: string;",
    "  src: string;",
    "  dst: string;",
    "  name_src: string;",
    "  name_dst: string;",
    "  file_path: string;",
    "  row_number: number;",
    "  status: ItemStatus;",
    "};",
    "type Dataset_warnings = {",
    "  item_id: number;",
    "  warnings: Array<",
    "    | { code: 'FOREIGN_CHAR_RESIDUE'; target_field: 'dst' | 'name_dst'; fragments: string[] }",
    "    | { code: 'TEXT_PRESERVE'; target_field: 'dst' | 'name_dst'; source_fragments: string[]; translation_fragments: string[] }",
    "    | { code: 'PUNCTUATION_MISMATCH' | 'GLOSSARY'; target_field: 'dst' | 'name_dst' }",
    "    | { code: 'SIMILARITY' | 'LINE_COUNT_MISMATCH'; target_field: 'dst' }",
    "  >;",
    "  glossary_applications: Array<{",
    "    entry_id: string;",
    "    src: string;",
    "    dst: string;",
    "    case_sensitive: boolean;",
    "    fields: Array<{ source_field: 'src' | 'name_src'; target_field: 'dst' | 'name_dst'; applied: boolean }>;",
    "  }>;",
    "};",
    "/** 提供对象身份、指纹和至少一个待修改字段，省略的字段保留当前值。 */",
    "type Change_items_updates = {",
    "  item_id: number;",
    "  fp: string;",
    "  dst?: string;",
    "  name_dst?: string | null;",
    "  status?: 'NONE' | 'PROCESSED' | 'EXCLUDED';",
    "};",
    "```",
    "",
    "- `dst` 或 `name_dst` 实际变化时状态默认改为 `PROCESSED`，同值提交不改变状态。",
    '- 显式 `status` 优先于默认状态，接受现有译文时可只提交 `status: "PROCESSED"`。',
    "- 同一文件中 `src` 与 `name_src` 相同的条目为同文组，宿主按重复过滤设置自动维护组内的 `NONE` 与 `DUPLICATED`。",
    "",
  ].join("\n"),

  [referencePath("pages")]: [
    "# pages 工作区参考",
    "",
    `- \`ws.contract.datasets.pages.path\`：\`${AGENT_WORKSPACE_PATHS.pages}\`，记录类型为 \`Dataset_pages\`。`,
    `- \`ws.contract.changes.pages.updates.path\`：\`${AGENT_WORKSPACE_CHANGE_PATHS.pages.updates}\`，记录类型为 \`Change_pages_updates\`。`,
    "",
    "```ts",
    "type Dataset_pages = { file_path: string; fp: string; digest: string; page: number; translation: unknown; reviewed: boolean; notes: string };",
    "type Change_pages_updates = { file_path: string; page: number; fp: string; translation: unknown; reviewed: boolean; notes: string };",
    "```",
    "",
    "- 以 `file_path` 和 `page` 定位页面，同批每页只提交一次，各页独立接受或拒绝。",
    "- 更新完整替换 `translation`、`reviewed` 和 `notes`。",
    "",
  ].join("\n"),

  [referencePath("prompts")]: [
    "# prompts 工作区参考",
    "",
    `- \`ws.contract.datasets.prompts.path\`：\`${AGENT_WORKSPACE_PATHS.prompts}\`，记录类型为 \`Dataset_prompts\`。`,
    `- \`ws.contract.changes.prompts.updates.path\`：\`${AGENT_WORKSPACE_CHANGE_PATHS.prompts.updates}\`，记录类型为 \`Change_prompts_updates\`。`,
    "",
    "```ts",
    "type Dataset_prompts = {",
    "  translation: { fp: string; text: string | null };",
    "  analysis: { fp: string; text: string | null };",
    "};",
    "type Change_prompts_updates = {",
    "  kind: 'translation' | 'analysis';",
    "  fp: string;",
    "  text: string | null;",
    "};",
    "```",
    "",
  ].join("\n"),

  [referencePath("glossary")]: buildQualityReferenceMarkdown(
    "glossary",
    ["  src: string;", "  dst: string;", "  info: string;", "  case_sensitive: boolean;"].join("\n"),
  ),
  [referencePath("pre_replacement")]: buildQualityReferenceMarkdown(
    "pre_replacement",
    ["  src: string;", "  dst: string;", "  regex: boolean;", "  case_sensitive: boolean;"].join("\n"),
  ),
  [referencePath("post_replacement")]: buildQualityReferenceMarkdown(
    "post_replacement",
    ["  src: string;", "  dst: string;", "  regex: boolean;", "  case_sensitive: boolean;"].join("\n"),
  ),
  [referencePath("text_preserve")]: buildQualityReferenceMarkdown(
    "text_preserve",
    ["  src: string;", "  info: string;"].join("\n"),
  ),
});

export function workspaceFingerprint(tuple) {
  const canonical = JSON.stringify(tuple);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export function knowledgeFingerprint(text) {
  return workspaceFingerprint(["knowledge", text ?? ""]);
}

export function itemFingerprint(row) {
  return workspaceFingerprint([
    "item",
    row.item_id ?? null,
    row.src ?? "",
    row.dst ?? "",
    row.name_src ?? "",
    row.name_dst ?? "",
    row.file_path ?? "",
    row.row_number ?? 0,
    row.status ?? "NONE",
  ]);
}

export function qualityFingerprint(kind, row) {
  const fields = QUALITY_BUSINESS_FIELDS[kind];
  return workspaceFingerprint([
    "quality",
    kind,
    row.id ?? row.entry_id ?? "",
    ...fields.map((f) => row[f] ?? null),
  ]);
}

export function promptFingerprint(kind, text) {
  return workspaceFingerprint(["prompt", kind, text ?? null]);
}

/** 100% 复现原版 insert_by_sort */
export function insertBySort(kept, sorted) {
  const result = [...kept];
  const ordered = [...sorted].sort((left, right) => {
    if (left.sort === -1 && right.sort !== -1) return 1;
    if (right.sort === -1 && left.sort !== -1) return -1;
    return left.sort - right.sort || left.rank - right.rank || left.line - right.line;
  });
  for (let index = 0; index < ordered.length; ) {
    const sort = ordered[index].sort;
    const group = [];
    while (index < ordered.length && ordered[index].sort === sort) {
      group.push(ordered[index++].value);
    }
    result.splice(sort === -1 ? result.length : Math.min(sort, result.length), 0, ...group);
  }
  return result;
}
