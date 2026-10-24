/**
 * Minimal, dependency-free XML reader/writer helpers used by the MusicXML
 * module. It deliberately supports only the subset of XML that MusicXML needs
 * (elements, attributes, character data, CDATA, comments, processing
 * instructions and a skipped DOCTYPE) but it does so defensively: imported
 * files are untrusted, so the parser is bounded in size, depth and node count
 * and throws a human-readable `Error` instead of hanging or exploding.
 */

export interface XmlElement {
  /** Local name (namespace prefixes are stripped). */
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data directly inside this element. */
  text: string;
}

const MAX_XML_LENGTH = 64 * 1024 * 1024;
const MAX_XML_DEPTH = 256;
const MAX_XML_NODES = 500_000;
const MAX_XML_ATTRIBUTES = 512;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function codePointText(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

/** Decodes the predefined XML entities plus numeric character references. */
export function decodeXmlEntities(input: string): string {
  if (input.indexOf('&') === -1) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.length > 1 && (body[0] === '#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const decoded = codePointText(code);
      return decoded === null ? match : decoded;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

interface StartTag {
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  end: number;
}

function readStartTag(input: string, start: number): StartTag {
  const len = input.length;
  let pos = start + 1;
  let name = '';
  while (pos < len) {
    const ch = input[pos];
    if (isSpace(ch) || ch === '>' || ch === '/') break;
    name += ch;
    pos += 1;
  }
  if (!name) throw new Error('Invalid MusicXML: malformed tag.');
  const attributes: Record<string, string> = {};
  let attributeCount = 0;
  while (pos < len) {
    while (pos < len && isSpace(input[pos])) pos += 1;
    if (pos >= len) throw new Error('Invalid MusicXML: unterminated tag.');
    const ch = input[pos];
    if (ch === '>') return { name, attributes, selfClosing: false, end: pos + 1 };
    if (ch === '/') {
      if (input[pos + 1] !== '>') throw new Error('Invalid MusicXML: malformed self-closing tag.');
      return { name, attributes, selfClosing: true, end: pos + 2 };
    }
    const equals = input.indexOf('=', pos);
    if (equals === -1) throw new Error('Invalid MusicXML: malformed attribute.');
    const rawName = input.slice(pos, equals).trim();
    if (!rawName || rawName.includes('"') || rawName.includes("'")) {
      throw new Error('Invalid MusicXML: malformed attribute name.');
    }
    pos = equals + 1;
    while (pos < len && isSpace(input[pos])) pos += 1;
    const quote = input[pos];
    if (quote !== '"' && quote !== "'") {
      throw new Error('Invalid MusicXML: attribute values must be quoted.');
    }
    pos += 1;
    const close = input.indexOf(quote, pos);
    if (close === -1) throw new Error('Invalid MusicXML: unterminated attribute value.');
    attributes[localName(rawName)] = decodeXmlEntities(input.slice(pos, close));
    pos = close + 1;
    attributeCount += 1;
    if (attributeCount > MAX_XML_ATTRIBUTES) {
      throw new Error('Invalid MusicXML: element has too many attributes.');
    }
  }
  throw new Error('Invalid MusicXML: unterminated tag.');
}

/**
 * Parses an XML document into a lightweight element tree. Throws `Error` with a
 * readable message when the document is empty, truncated or not well formed.
 */
export function parseXml(source: string): XmlElement {
  if (typeof source !== 'string') throw new Error('MusicXML input must be text.');
  if (source.length > MAX_XML_LENGTH) throw new Error('MusicXML file is too large to import.');
  let input = source;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  if (input.trim() === '') throw new Error('This MusicXML file is empty.');

  const len = input.length;
  let pos = 0;
  let nodeCount = 0;
  const documentRoot: XmlElement = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [documentRoot];

  const fail = (message: string): never => {
    throw new Error(`Invalid MusicXML: ${message}`);
  };
  const appendText = (chunk: string): void => {
    if (!chunk) return;
    stack[stack.length - 1].text += decodeXmlEntities(chunk);
  };

  while (pos < len) {
    const nextTag = input.indexOf('<', pos);
    if (nextTag === -1) {
      appendText(input.slice(pos));
      break;
    }
    if (nextTag > pos) appendText(input.slice(pos, nextTag));
    pos = nextTag;

    if (input.startsWith('<!--', pos)) {
      const end = input.indexOf('-->', pos + 4);
      if (end === -1) return fail('unterminated comment');
      pos = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', pos)) {
      const end = input.indexOf(']]>', pos + 9);
      if (end === -1) return fail('unterminated CDATA section');
      stack[stack.length - 1].text += input.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }
    if (input.startsWith('<?', pos)) {
      const end = input.indexOf('?>', pos + 2);
      if (end === -1) return fail('unterminated processing instruction');
      pos = end + 2;
      continue;
    }
    if (input.startsWith('<!', pos)) {
      // DOCTYPE or other declaration: skip it, balancing [ ... ] and quotes.
      let depth = 0;
      let quote: string | null = null;
      let scan = pos + 2;
      for (; scan < len; scan += 1) {
        const ch = input[scan];
        if (quote !== null) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '[') {
          depth += 1;
        } else if (ch === ']') {
          depth = Math.max(0, depth - 1);
        } else if (ch === '>' && depth === 0) {
          break;
        }
      }
      if (scan >= len) return fail('unterminated declaration');
      pos = scan + 1;
      continue;
    }
    if (input.startsWith('</', pos)) {
      const end = input.indexOf('>', pos + 2);
      if (end === -1) return fail('unterminated closing tag');
      const rawName = input.slice(pos + 2, end).trim();
      if (!rawName) return fail('empty closing tag');
      const top = stack.pop();
      if (!top || top === documentRoot) return fail(`unexpected closing tag </${rawName}>`);
      if (top.name !== localName(rawName)) return fail(`mismatched closing tag </${rawName}>`);
      pos = end + 1;
      continue;
    }

    const tag = readStartTag(input, pos);
    pos = tag.end;
    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES) return fail('document has too many elements');
    if (stack.length > MAX_XML_DEPTH) return fail('document is nested too deeply');
    const element: XmlElement = {
      name: localName(tag.name),
      attributes: tag.attributes,
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(element);
    if (!tag.selfClosing) stack.push(element);
  }

  if (stack.length > 1) return fail('unexpected end of file inside an element');
  if (documentRoot.children.length === 0) return fail('no root element found');
  if (documentRoot.children.length > 1) return fail('multiple root elements found');
  return documentRoot.children[0];
}

export function childrenNamed(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter((child) => child.name === name);
}

export function firstChild(parent: XmlElement, name: string): XmlElement | null {
  for (const child of parent.children) {
    if (child.name === name) return child;
  }
  return null;
}

/** Trimmed character data of the first child with `name`, or null. */
export function childText(parent: XmlElement, name: string): string | null {
  const child = firstChild(parent, name);
  return child ? child.text.trim() : null;
}

/** Trimmed character data of an element (empty string for null). */
export function ownText(element: XmlElement | null): string {
  return element ? element.text.trim() : '';
}

/** Removes characters that are not legal in an XML 1.0 document. */
export function stripXmlInvalidChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/g, '');
}

export function escapeXmlText(value: string): string {
  return stripXmlInvalidChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
