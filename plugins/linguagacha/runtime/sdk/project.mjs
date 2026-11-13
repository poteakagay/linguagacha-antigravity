let activeRequestSender = null;

export function bindProjectRequestSender(sender) {
  activeRequestSender = sender;
}

function requireSender() {
  if (typeof activeRequestSender !== "function") {
    throw new Error(
      "@lg/project is only available inside workspace_run scripts (or when bound to a ProjectStore).",
    );
  }
  return activeRequestSender;
}

export async function inspectSources(sourcePaths) {
  if (!Array.isArray(sourcePaths) || sourcePaths.some((p) => typeof p !== "string" || p.length === 0)) {
    throw new Error("inspectSources(source_paths) expects an array of non-empty string paths.");
  }
  const result = await requireSender()({ kind: "inspect_sources", source_paths: sourcePaths });
  if (!Array.isArray(result)) {
    throw new Error("Invalid inspect_sources response.");
  }
  return result;
}

export async function getOutputPaths(directory) {
  if (directory !== undefined && typeof directory !== "string") {
    throw new Error("getOutputPaths(directory?) expects an optional absolute directory path.");
  }
  const result = await requireSender()({
    kind: "get_output_paths",
    ...(directory === undefined ? {} : { directory }),
  });
  if (typeof result !== "object" || result === null || !("manual" in result)) {
    throw new Error("Invalid get_output_paths response.");
  }
  return result;
}

export async function generateFiles(bilingualFiles = []) {
  if (!Array.isArray(bilingualFiles) || bilingualFiles.some((p) => typeof p !== "string")) {
    throw new Error("generateFiles(bilingual_files) expects an array of file_path strings.");
  }
  const result = await requireSender()({
    kind: "generate_files",
    bilingual_files: bilingualFiles,
  });
  if (typeof result !== "object" || result === null || !("accepted" in result)) {
    throw new Error("Invalid generate_files response.");
  }
  return result;
}
