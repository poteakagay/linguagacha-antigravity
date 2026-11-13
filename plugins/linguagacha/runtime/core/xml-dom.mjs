const VOID_HTML_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const NAMED_HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: "\u00a0", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026", middot: "\u00b7",
  bull: "\u2022", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  times: "\u00d7", divide: "\u00f7", plusmn: "\u00b1", deg: "\u00b0",
  yen: "\u00a5", euro: "\u20ac", pound: "\u00a3", cent: "\u00a2",
  sect: "\u00a7", para: "\u00b6", laquo: "\u00ab", raquo: "\u00bb",
  hearts: "\u2665", diams: "\u2666", clubs: "\u2663", spades: "\u2660",
  zwj: "\u200d", zwnj: "\u200c", lrm: "\u200e", rlm: "\u200f",
};

export function decodeHtmlEntities(str) {
  if (!str || !str.includes("&")) return str;
  return str.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9._:-]*));/gu, (match, dec, hex, named) => {
    if (dec !== undefined) {
      const cp = Number.parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (named !== undefined) {
      const mapped = NAMED_HTML_ENTITIES[named] ?? NAMED_HTML_ENTITIES[named.toLowerCase()];
      return mapped !== undefined ? mapped : match;
    }
    return match;
  });
}

export class DomNode {
  constructor(type) {
    this.type = type;
    this.parent = null;
    this.prev = null;
    this.next = null;
  }
}

export class Document extends DomNode {
  constructor(children = []) {
    super("root");
    this.children = children;
    relinkChildren(this);
  }
}

export class Element extends DomNode {
  constructor(name, attribs = {}, children = []) {
    super("tag");
    this.name = name;
    this.attribs = { ...attribs };
    this.children = children;
    relinkChildren(this);
  }
}

export class Text extends DomNode {
  constructor(data = "") {
    super("text");
    this.data = String(data);
  }
}

export class RawNode extends DomNode {
  constructor(kind, data) {
    super(kind);
    this.data = data;
  }
}

export function isTag(node) {
  return node instanceof Element || node?.type === "tag";
}

export function isText(node) {
  return node instanceof Text || node?.type === "text";
}

export function relinkChildren(parent) {
  let previous = null;
  for (const child of parent.children) {
    child.parent = parent;
    child.prev = previous;
    if (previous !== null) previous.next = child;
    previous = child;
  }
  if (previous !== null) previous.next = null;
}

export function cloneNode(node, recursive = true) {
  if (node instanceof Text) return new Text(node.data);
  if (node instanceof RawNode) return new RawNode(node.type, node.data);
  if (node instanceof Document) {
    return new Document(recursive ? node.children.map((c) => cloneNode(c, true)) : []);
  }
  if (node instanceof Element) {
    return new Element(
      node.name,
      { ...node.attribs },
      recursive ? node.children.map((c) => cloneNode(c, true)) : [],
    );
  }
  throw new Error(`Unsupported DOM node clone: ${node?.type}`);
}

function parseAttributes(attrText, xmlMode) {
  const attribs = {};
  const attrRegex = /([^\s=/>"'<]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of attrText.matchAll(attrRegex)) {
    const rawName = match[1];
    if (!rawName || rawName === "/") continue;
    const rawVal = match[2] ?? match[3] ?? match[4] ?? (xmlMode ? "" : "");
    attribs[rawName] = decodeHtmlEntities(rawVal);
  }
  return attribs;
}

/**
 * 解析 XML / XHTML / HTML 为 DOM Document。
 * `xmlMode: true` 时检查标签严格配对，未闭合或错配会抛出解析错误（供 EPUB AST 判断是否回退 HTML 容错模式）。
 */
export function parseDomDocument(source, { xmlMode = true, recover = false } = {}) {
  const text = String(source ?? "");
  const root = new Document([]);
  const stack = [root];

  if (xmlMode && !recover) {
    // Reject bare unescaped '&' outside CDATA/comments in strict XML mode
    const withoutSpecial = text
      .replace(/<!--[\s\S]*?-->/gu, "")
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, "");
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/u.test(withoutSpecial)) {
      throw new Error("Strict XML parse error: unescaped entity or bare ampersand");
    }
  }

  const tokenRegex =
    /<!--([\s\S]*?)-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?([\s\S]*?)\?>|<!DOCTYPE\s+([\s\S]*?)>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>"'<]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*)(\/?)>/gu;

  let lastIndex = 0;
  const pushChild = (node) => {
    const current = stack[stack.length - 1];
    current.children.push(node);
  };

  for (const match of text.matchAll(tokenRegex)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      const rawSlice = text.slice(lastIndex, idx);
      pushChild(new Text(decodeHtmlEntities(rawSlice)));
    }
    lastIndex = idx + match[0].length;

    if (match[1] !== undefined) {
      pushChild(new RawNode("comment", match[1]));
    } else if (match[2] !== undefined) {
      // CDATA content becomes text node in DOM
      pushChild(new Text(match[2]));
    } else if (match[3] !== undefined) {
      pushChild(new RawNode("directive", match[3]));
    } else if (match[4] !== undefined) {
      pushChild(new RawNode("doctype", match[4]));
    } else if (match[5] !== undefined) {
      // Closing tag
      const closeName = match[5];
      if (xmlMode && !recover) {
        const top = stack[stack.length - 1];
        if (!(top instanceof Element) || top.name !== closeName) {
          throw new Error(`Strict XML tag mismatch: expected </${top?.name}>, got </${closeName}>`);
        }
        relinkChildren(top);
        stack.pop();
      } else {
        const lowerClose = closeName.toLowerCase();
        let foundIdx = -1;
        for (let i = stack.length - 1; i >= 1; i -= 1) {
          const candidate = stack[i];
          if (candidate.name === closeName || (!xmlMode && candidate.name.toLowerCase() === lowerClose)) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx >= 1) {
          while (stack.length > foundIdx) {
            const popped = stack.pop();
            relinkChildren(popped);
          }
        }
      }
    } else if (match[6] !== undefined) {
      // Opening tag
      const openName = match[6];
      const attrPart = match[7] ?? "";
      const selfClose = match[8] === "/";
      const attribs = parseAttributes(attrPart, xmlMode);
      const elem = new Element(openName, attribs, []);

      // Handle raw script/style in HTML mode
      const localLower = openName.toLowerCase();
      pushChild(elem);

      const isVoidHtml = !xmlMode && VOID_HTML_TAGS.has(localLower);
      if (!selfClose && !isVoidHtml) {
        if (!xmlMode && (localLower === "script" || localLower === "style")) {
          const closeRe = new RegExp(`</${openName}\\s*>`, "iu");
          const rest = text.slice(lastIndex);
          const closeMatch = closeRe.exec(rest);
          if (closeMatch) {
            const rawInner = rest.slice(0, closeMatch.index);
            if (rawInner) elem.children.push(new Text(rawInner));
            relinkChildren(elem);
            lastIndex += closeMatch.index + closeMatch[0].length;
            tokenRegex.lastIndex = lastIndex;
            continue;
          }
        }
        stack.push(elem);
      }
    }
  }

  if (lastIndex < text.length) {
    pushChild(new Text(decodeHtmlEntities(text.slice(lastIndex))));
  }

  if (xmlMode && !recover && stack.length !== 1) {
    throw new Error(`Strict XML parse error: unclosed tag <${stack[stack.length - 1]?.name}>`);
  }

  while (stack.length > 0) {
    relinkChildren(stack.pop());
  }
  return root;
}

function escapeXmlText(text) {
  return String(text).replace(/[&<>\u00a0]/gu, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    return "&#160;";
  });
}

function escapeHtmlText(text) {
  return String(text).replace(/[&<>]/gu, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    return "&gt;";
  });
}

function escapeAttribute(text) {
  return String(text).replace(/[&"<>\u00a0]/gu, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === '"') return "&quot;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    return "&#160;";
  });
}

export function serializeDomNode(node, { xmlMode = true } = {}) {
  if (node instanceof Document) {
    return node.children.map((c) => serializeDomNode(c, { xmlMode })).join("");
  }
  if (node instanceof Text) {
    return xmlMode ? escapeXmlText(node.data) : escapeHtmlText(node.data);
  }
  if (node instanceof RawNode) {
    if (node.type === "comment") return `<!--${node.data}-->`;
    if (node.type === "doctype") return `<!DOCTYPE ${node.data}>`;
    if (node.type === "directive") return `<?${node.data}?>`;
    return "";
  }
  if (node instanceof Element) {
    const attrs = Object.entries(node.attribs)
      .map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`)
      .join("");
    if (node.children.length === 0) {
      if (xmlMode) return `<${node.name}${attrs}/>`;
      if (VOID_HTML_TAGS.has(node.name.toLowerCase())) return `<${node.name}${attrs}>`;
      return `<${node.name}${attrs}></${node.name}>`;
    }
    const lower = node.name.toLowerCase();
    if (!xmlMode && (lower === "script" || lower === "style")) {
      const raw = node.children.map((c) => (c instanceof Text ? c.data : serializeDomNode(c, { xmlMode }))).join("");
      return `<${node.name}${attrs}>${raw}</${node.name}>`;
    }
    const inner = node.children.map((c) => serializeDomNode(c, { xmlMode })).join("");
    return `<${node.name}${attrs}>${inner}</${node.name}>`;
  }
  return "";
}
