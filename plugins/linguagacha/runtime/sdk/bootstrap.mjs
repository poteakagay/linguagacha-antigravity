import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { bindProjectRequestSender } from "./project.mjs";

register("./loader-hooks.mjs", import.meta.url);

function deepFreeze(value) {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const isEntry = process.env.LG_WORKSPACE_ENTRY === "1";
delete process.env.LG_WORKSPACE_ENTRY;

if (isEntry) {
  await initWorkspaceRuntime();
}

async function initWorkspaceRuntime() {
  const startMsg = await new Promise((resolve, reject) => {
    process.once("message", (msg) => {
      if (msg && msg.type === "start") resolve(msg);
      else reject(new Error("Workspace runtime did not receive a valid start message."));
    });
    process.once("disconnect", () => process.exit(1));
  });

  let nextId = 1;
  const pending = new Map();

  const updateRef = () => {
    if (pending.size > 0) process.channel?.ref();
    else process.channel?.unref();
  };

  process.on("message", (msg) => {
    if (!msg || msg.type !== "response") return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    updateRef();
    if (msg.result?.ok) entry.resolve(msg.result.value);
    else entry.reject(new Error(msg.result?.message ?? "Host request failed."));
  });

  const callHost = (request) =>
    new Promise((resolve, reject) => {
      if (!process.send || !process.connected) {
        reject(new Error("Workspace runtime IPC channel is closed."));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      updateRef();
      process.send({ type: "request", id, request }, (err) => {
        if (err) {
          pending.delete(id);
          updateRef();
          reject(err);
        }
      });
    });

  bindProjectRequestSender(callHost);

  const contract = JSON.parse(await readFile("contract.json", "utf8"));
  const wsApi = deepFreeze({
    contract,
    userSkillDirectory: startMsg.userSkillDirectory,
    fontsDirectory: startMsg.fontsDirectory,
    setDoing: async (text) => {
      await callHost({ kind: "doing", text: text ?? null });
    },
    emitImage: async (imagePath, options) => {
      await callHost({ kind: "emit_image", path: imagePath, options });
    },
  });

  Object.defineProperty(globalThis, "ws", {
    value: wsApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  process.channel?.unref();
}
