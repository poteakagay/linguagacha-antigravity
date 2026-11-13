const CONTEXT_NEIGHBORS = 2; // 同文件前后各两条非空原文

/**
 * 查询目标条目的同文件邻近语境，单次扫描合并共享证据。
 */
export async function queryItemContexts(items, item_ids) {
  const targetIds = new Set(item_ids);
  const contextsById = new Map();
  const returnedItemById = new Map();
  let currentFilePath = null;
  let beforeItems = [];
  let pendingContexts = [];

  for await (const item of items) {
    if (item.file_path !== currentFilePath) {
      currentFilePath = item.file_path;
      beforeItems = [];
      pendingContexts = [];
    }

    if (String(item.src ?? "").trim() !== "") {
      for (const pending of pendingContexts) {
        pending.item_ids.push(item.item_id);
        pending.remaining -= 1;
        returnedItemById.set(item.item_id, item);
      }
      pendingContexts = pendingContexts.filter((pending) => pending.remaining > 0);
    }

    const item_id = item.item_id;
    if (targetIds.has(item_id)) {
      const context = {
        target_item_id: item_id,
        item_ids: [...beforeItems.map((entry) => entry.item_id), item_id],
        remaining: CONTEXT_NEIGHBORS,
      };
      contextsById.set(item_id, context);
      for (const before of beforeItems) returnedItemById.set(before.item_id, before);
      returnedItemById.set(item_id, item);
      pendingContexts.push(context);
    }

    if (String(item.src ?? "").trim() !== "") {
      beforeItems.push(item);
      if (beforeItems.length > CONTEXT_NEIGHBORS) beforeItems.shift();
    }
  }

  const contexts = item_ids.flatMap((itemId) => {
    const context = contextsById.get(itemId);
    return context === undefined
      ? []
      : [{ target_item_id: context.target_item_id, item_ids: context.item_ids }];
  });
  return {
    contexts,
    items: [...returnedItemById.values()],
    missing_item_ids: item_ids.filter((itemId) => !contextsById.has(itemId)),
  };
}
