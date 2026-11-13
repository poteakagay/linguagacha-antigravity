const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 全仓字面量匹配的唯一规范化规则；大小写标志只控制 casefold。 */
export function normalizeLiteralText(text, case_sensitive) {
  const str = String(text ?? "");
  const normalized = str.normalize("NFKC");
  return case_sensitive ? normalized : foldLiteralText(normalized);
}

/** 在 NFKC 结果上统一德语展开及希腊词尾变体。 */
function foldLiteralText(normalized) {
  return normalized.replaceAll("ẞ", "ss").replaceAll("ß", "ss").toLowerCase().replaceAll("ς", "σ");
}

/** 编译大小写敏感与不敏感字面量；空文本跳过，重复身份直接拒绝。 */
export function compileLiteralPatterns(patterns) {
  const caseByKey = new Map();
  for (const pattern of patterns) {
    if (caseByKey.has(pattern.key)) {
      throw new Error(`Duplicate literal pattern key: ${pattern.key}.`);
    }
    caseByKey.set(pattern.key, Boolean(pattern.case_sensitive));
  }

  const activePatterns = patterns.filter((pattern) => String(pattern.text ?? "") !== "");
  const buckets = [true, false].flatMap((case_sensitive) => {
    const indexes = activePatterns.flatMap((pattern, index) =>
      Boolean(pattern.case_sensitive) === case_sensitive ? [index] : [],
    );
    const matcher = buildAhoMatcher(
      indexes.map((index) => normalizeLiteralText(activePatterns[index].text, case_sensitive)),
    );
    return matcher === null ? [] : [{ matcher, indexes, case_sensitive }];
  });

  const scanRanges = (text, visit, selectedKeys) => {
    const str = String(text ?? "");
    const selectedModes =
      selectedKeys === undefined
        ? undefined
        : new Set([...selectedKeys].map((key) => caseByKey.get(key)));
    const selectedBuckets =
      selectedModes === undefined
        ? buckets
        : buckets.filter((bucket) => selectedModes.has(bucket.case_sensitive));
    if (selectedBuckets.length === 0 || str === "") return;
    const inputs = normalizeTextWithSourceRanges(
      str,
      selectedBuckets.map((bucket) => bucket.case_sensitive),
    );
    for (const bucket of selectedBuckets) {
      collectMatches(
        bucket.matcher,
        inputs.get(bucket.case_sensitive),
        bucket.indexes,
        (index) => selectedKeys === undefined || selectedKeys.has(activePatterns[index].key),
        visit,
      );
    }
  };

  return {
    patterns: activePatterns,
    matches(text) {
      const str = String(text ?? "");
      if (str === "") return false;
      return buckets.some(({ matcher, case_sensitive }) =>
        scanAhoText(matcher, normalizeLiteralText(str, case_sensitive), () => true),
      );
    },
    scanKeys(text, visit) {
      const str = String(text ?? "");
      if (str === "") return;
      for (const { matcher, indexes, case_sensitive } of buckets) {
        const seen = new Set();
        scanAhoText(matcher, normalizeLiteralText(str, case_sensitive), (index) => {
          if (!seen.has(index)) {
            seen.add(index);
            visit(activePatterns[indexes[index]].key);
          }
          return seen.size === indexes.length;
        });
      }
    },
    scan(text, visit) {
      scanRanges(text, (index, range) => visit(activePatterns[index].key, range));
    },
    match(text, selectedKeys) {
      const rangesByIndex = new Map();
      scanRanges(
        text,
        (index, range) => {
          const ranges = rangesByIndex.get(index) ?? [];
          ranges.push(range);
          rangesByIndex.set(index, ranges);
        },
        selectedKeys,
      );
      return [...rangesByIndex]
        .sort(([left], [right]) => left - right)
        .map(([index, ranges]) => ({ key: activePatterns[index].key, ranges }));
    },
  };
}

function scanAhoText(matcher, text, visit) {
  let nodeIndex = 0;
  for (let index = 0; index < text.length; index += 1) {
    nodeIndex = advanceAhoMatcher(matcher, nodeIndex, text[index]);
    for (const output of matcher.nodes[nodeIndex].outputs) {
      if (visit(output, index)) return true;
    }
  }
  return false;
}

function advanceAhoMatcher(matcher, nodeIndex, character) {
  let nextNodeIndex = nodeIndex;
  while (nextNodeIndex !== 0 && !matcher.nodes[nextNodeIndex].next.has(character)) {
    nextNodeIndex = matcher.nodes[nextNodeIndex].fail;
  }
  return matcher.nodes[nextNodeIndex].next.get(character) ?? 0;
}

function buildAhoMatcher(patterns) {
  if (patterns.length === 0) return null;
  const nodes = [{ next: new Map(), fail: 0, outputs: [] }];
  patterns.forEach((pattern, patternIndex) => {
    let nodeIndex = 0;
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      const nextIndex = nodes[nodeIndex].next.get(character);
      if (nextIndex !== undefined) {
        nodeIndex = nextIndex;
        continue;
      }
      const createdIndex = nodes.length;
      nodes[nodeIndex].next.set(character, createdIndex);
      nodes.push({ next: new Map(), fail: 0, outputs: [] });
      nodeIndex = createdIndex;
    }
    nodes[nodeIndex].outputs.push(patternIndex);
  });

  const queue = [...nodes[0].next.values()];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const node = nodes[queue[queueIndex]];
    for (const [character, childIndex] of node.next) {
      queue.push(childIndex);
      let failIndex = node.fail;
      while (failIndex !== 0 && !nodes[failIndex].next.has(character)) {
        failIndex = nodes[failIndex].fail;
      }
      const fallbackIndex = nodes[failIndex].next.get(character) ?? 0;
      const child = nodes[childIndex];
      child.fail = fallbackIndex;
      child.outputs.push(...nodes[fallbackIndex].outputs);
    }
  }
  return { nodes, pattern_lengths: patterns.map((pattern) => pattern.length) };
}

function collectMatches(matcher, input, bucketIndexes, include, visit) {
  const previousRangeByPattern = new Map();
  scanAhoText(matcher, input.text, (bucketIndex, textIndex) => {
    const patternIndex = bucketIndexes[bucketIndex];
    if (!include(patternIndex)) return false;
    const patternLength = matcher.pattern_lengths[bucketIndex];
    const foldedStart = textIndex - patternLength + 1;
    const start = input.starts[foldedStart];
    const end = input.ends[textIndex];
    const previousRange = previousRangeByPattern.get(patternIndex);
    if (previousRange?.start === start && previousRange.end === end) return false;
    const range = { start, end };
    previousRangeByPattern.set(patternIndex, range);
    visit(patternIndex, range);
    return false;
  });
}

function normalizeTextWithSourceRanges(text, caseModes) {
  const segments = [];
  for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
    const value = normalizeLiteralText(segment.segment, true);
    const end = segment.index + segment.segment.length;
    const previous = segments.at(-1);
    const joined = previous === undefined ? value : previous.text + value;
    const composed = joined.normalize("NFC");
    if (previous !== undefined && composed !== joined) {
      previous.text = composed;
      previous.end = end;
    } else {
      segments.push({ text: value, start: segment.index, end });
    }
  }
  const inputs = new Map(caseModes.map((mode) => [mode, { text: "", starts: [], ends: [] }]));
  for (const { text: normalized, start, end } of segments) {
    for (const [case_sensitive, input] of inputs) {
      const value = case_sensitive ? normalized : foldLiteralText(normalized);
      input.text += value;
      for (let index = 0; index < value.length; index += 1) {
        input.starts.push(start);
        input.ends.push(end);
      }
    }
  }
  return inputs;
}
