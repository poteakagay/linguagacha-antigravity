import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK_DIR = import.meta.dirname;

const MODULE_MAP = new Map([
  ["@lg/utils/literal-matcher", pathToFileURL(path.join(SDK_DIR, "literal-matcher.mjs")).href],
  ["@lg/project/item-contexts", pathToFileURL(path.join(SDK_DIR, "item-contexts.mjs")).href],
  ["@lg/project", pathToFileURL(path.join(SDK_DIR, "project.mjs")).href],
  ["@lg/pdf", pathToFileURL(path.join(SDK_DIR, "stubs.mjs")).href],
  ["@lg/pdf/mupdf", pathToFileURL(path.join(SDK_DIR, "stubs.mjs")).href],
  ["@lg/media", pathToFileURL(path.join(SDK_DIR, "stubs.mjs")).href],
  ["@lg/uv", pathToFileURL(path.join(SDK_DIR, "stubs.mjs")).href],
  ["@lg/npm", pathToFileURL(path.join(SDK_DIR, "stubs.mjs")).href],
  ["@lg/search", pathToFileURL(path.join(SDK_DIR, "stubs.mjs")).href],
  ["jszip", pathToFileURL(path.join(SDK_DIR, "jszip-shim.mjs")).href],
  ["chardet", pathToFileURL(path.join(SDK_DIR, "encoding-shim.mjs")).href],
  ["iconv-lite", pathToFileURL(path.join(SDK_DIR, "encoding-shim.mjs")).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const mapped = MODULE_MAP.get(specifier);
  if (mapped !== undefined) {
    return {
      shortCircuit: true,
      url: mapped,
    };
  }
  return nextResolve(specifier, context);
}
