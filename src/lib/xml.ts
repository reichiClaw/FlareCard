/**
 * A small namespace-aware XML parser and a string-based writer. Workers do not
 * ship DOMParser, and WebDAV request bodies are small and well-formed enough
 * that a compact hand-written parser is sufficient.
 */

export interface XmlNode {
  /** Resolved namespace URI ("" when none). */
  ns: string;
  /** Local name (prefix stripped). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content. */
  text: string;
}

export const NS_DAV = "DAV:";
export const NS_CARDDAV = "urn:ietf:params:xml:ns:carddav";
export const NS_CS = "http://calendarserver.org/ns/";
export const NS_APPLE = "http://apple.com/ns/ical/";

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

export class XmlParseError extends Error {}

interface Frame {
  node: XmlNode;
  nsMap: Record<string, string>;
}

export function parseXml(input: string): XmlNode | null {
  const src = input.replace(/^\uFEFF/, "");
  if (!src.trim()) return null;
  let pos = 0;
  const stack: Frame[] = [];
  let root: XmlNode | null = null;
  const rootNs: Record<string, string> = { xml: "http://www.w3.org/XML/1998/namespace" };

  const resolve = (qname: string, nsMap: Record<string, string>, isAttr: boolean): { ns: string; name: string } => {
    const idx = qname.indexOf(":");
    if (idx < 0) return { ns: isAttr ? "" : (nsMap[""] ?? ""), name: qname };
    const prefix = qname.slice(0, idx);
    const ns = nsMap[prefix];
    if (ns === undefined) throw new XmlParseError(`Unbound namespace prefix "${prefix}"`);
    return { ns, name: qname.slice(idx + 1) };
  };

  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    if (lt < 0) {
      if (stack.length && src.slice(pos).trim()) stack[stack.length - 1].node.text += decodeEntities(src.slice(pos));
      break;
    }
    if (lt > pos && stack.length) {
      stack[stack.length - 1].node.text += decodeEntities(src.slice(pos, lt));
    }
    pos = lt;

    if (src.startsWith("<?", pos)) {
      const end = src.indexOf("?>", pos);
      if (end < 0) throw new XmlParseError("Unterminated processing instruction");
      pos = end + 2;
      continue;
    }
    if (src.startsWith("<!--", pos)) {
      const end = src.indexOf("-->", pos);
      if (end < 0) throw new XmlParseError("Unterminated comment");
      pos = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", pos)) {
      const end = src.indexOf("]]>", pos);
      if (end < 0) throw new XmlParseError("Unterminated CDATA");
      if (stack.length) stack[stack.length - 1].node.text += src.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }
    if (src.startsWith("<!", pos)) {
      // DOCTYPE and friends: refuse, we never need them and they enable entity attacks.
      throw new XmlParseError("DOCTYPE declarations are not allowed");
    }
    if (src.startsWith("</", pos)) {
      const end = src.indexOf(">", pos);
      if (end < 0) throw new XmlParseError("Unterminated end tag");
      const qname = src.slice(pos + 2, end).trim();
      const frame = stack.pop();
      if (!frame) throw new XmlParseError(`Unexpected end tag </${qname}>`);
      const { ns, name } = resolve(qname, frame.nsMap, false);
      if (ns !== frame.node.ns || name !== frame.node.name) {
        throw new XmlParseError(`Mismatched end tag </${qname}>`);
      }
      pos = end + 1;
      continue;
    }

    // Start tag
    const tagEnd = findTagEnd(src, pos);
    if (tagEnd < 0) throw new XmlParseError("Unterminated start tag");
    let tag = src.slice(pos + 1, tagEnd);
    const selfClosing = tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1);
    const nameMatch = /^([^\s/>]+)/.exec(tag);
    if (!nameMatch) throw new XmlParseError("Missing element name");
    const qname = nameMatch[1];
    const rawAttrs = parseAttrs(tag.slice(qname.length));

    const parentMap = stack.length ? stack[stack.length - 1].nsMap : rootNs;
    let nsMap = parentMap;
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === "xmlns") {
        nsMap = { ...nsMap, "": v };
      } else if (k.startsWith("xmlns:")) {
        nsMap = { ...nsMap, [k.slice(6)]: v };
      }
    }
    const { ns, name } = resolve(qname, nsMap, false);
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === "xmlns" || k.startsWith("xmlns:")) continue;
      attrs[k] = v;
      // Also expose a namespace-stripped alias for prefixed attributes.
      const idx = k.indexOf(":");
      if (idx >= 0 && !(k.slice(idx + 1) in rawAttrs)) attrs[k.slice(idx + 1)] = v;
    }
    const node: XmlNode = { ns, name, attrs, children: [], text: "" };
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else if (root) throw new XmlParseError("Multiple root elements");
    else root = node;
    if (!selfClosing) stack.push({ node, nsMap });
    pos = tagEnd + 1;
  }
  if (stack.length) throw new XmlParseError("Unclosed element");
  return root;
}

function findTagEnd(src: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

export function findChild(node: XmlNode | null | undefined, ns: string, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.ns === ns && c.name === name);
}

export function findChildren(node: XmlNode | null | undefined, ns: string, name: string): XmlNode[] {
  return node?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
}

// ---------------------------------------------------------------------------
// Writer

/** Escapes element text. Quotes are left alone so ETags render as "abc", which every client expects. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Strip control characters that are illegal in XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export const PREFIXES: Record<string, string> = {
  [NS_DAV]: "D",
  [NS_CARDDAV]: "C",
  [NS_CS]: "CS",
  [NS_APPLE]: "A",
};

/**
 * Renders an element for a (ns, name) pair. Known namespaces use the fixed
 * prefixes declared on the multistatus root; unknown namespaces get an inline
 * default-namespace declaration so the output is always well-formed.
 */
export function element(ns: string, name: string, inner = "", attrs = ""): string {
  const prefix = PREFIXES[ns];
  if (prefix) {
    const q = `${prefix}:${name}`;
    return inner ? `<${q}${attrs}>${inner}</${q}>` : `<${q}${attrs}/>`;
  }
  const decl = ns ? ` xmlns="${escapeAttr(ns)}"` : "";
  return inner ? `<${name}${decl}${attrs}>${inner}</${name}>` : `<${name}${decl}${attrs}/>`;
}

export const dav = (name: string, inner = "", attrs = "") => element(NS_DAV, name, inner, attrs);
export const card = (name: string, inner = "", attrs = "") => element(NS_CARDDAV, name, inner, attrs);
export const cs = (name: string, inner = "", attrs = "") => element(NS_CS, name, inner, attrs);

export const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>\n';

export function rootDecls(): string {
  return Object.entries(PREFIXES)
    .map(([ns, p]) => ` xmlns:${p}="${ns}"`)
    .join("");
}

export function multistatus(responses: string[], extra = ""): string {
  return `${XML_DECL}<D:multistatus${rootDecls()}>${responses.join("")}${extra}</D:multistatus>`;
}

export function davError(inner: string): string {
  return `${XML_DECL}<D:error${rootDecls()}>${inner}</D:error>`;
}
