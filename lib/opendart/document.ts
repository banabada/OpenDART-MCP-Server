import { getBinary } from "./client";
import { OpenDartError } from "./errors";

export interface DocumentHeading {
  title: string;
  depth: number;
  start: number;
  end: number;
}

export interface DocumentText {
  fileName: string;
  text: string;
  headings: DocumentHeading[];
}

const BLOCK_TAGS = new Set(["P", "TR", "TABLE", "TITLE", "BR", "PGBRK", "LIBRARY", "COVER-TITLE"]);
const CELL_TAGS = new Set(["TD", "TH", "TE", "TU"]);

function decodeEntities(s: string): string {
  return s
    .replace(/&cr;/gi, "\n")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeXmlBytes(bytes: Uint8Array): string {
  const preview = new TextDecoder("ascii").decode(bytes.slice(0, 200));
  const enc = preview.match(/encoding=["']([^"']+)["']/i)?.[1].toLowerCase() ?? "utf-8";
  return new TextDecoder(enc === "euc-kr" || enc === "cp949" ? "euc-kr" : "utf-8").decode(bytes);
}

// Converts a DART filing XML (dart3/dart4 schema) to plain text. Headings come
// from <TITLE> elements, with depth taken from the enclosing <SECTION-n>.
// Table cells are joined with " | " and rows end with a newline. Sentence text
// is kept as written so quotes can be matched against the original.
export function dartXmlToText(xml: string): { text: string; headings: DocumentHeading[] } {
  const body = xml.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const tokenRe = /<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*?)(\/?)>|([^<]+)/g;
  const out: string[] = [];
  const push = (s: string) => out.push(s);
  const sectionStack: number[] = [];
  const headings: DocumentHeading[] = [];
  let titleBuf: string[] | null = null;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(body)) !== null) {
    const [, closing, rawName, , selfClosing, textPart] = m;
    if (textPart !== undefined) {
      const t = decodeEntities(textPart.replace(/[ \t\r\n]+/g, " "));
      if (titleBuf) titleBuf.push(t);
      else if (t.trim()) push(t);
      continue;
    }
    const name = rawName.toUpperCase();
    const section = name.match(/^SECTION-(\d+)$/);
    if (section) {
      if (closing) sectionStack.pop();
      else if (!selfClosing) sectionStack.push(Number(section[1]));
      continue;
    }
    if (name === "TITLE") {
      if (!closing && !selfClosing) {
        titleBuf = [];
      } else if (closing && titleBuf) {
        const title = titleBuf.join("").replace(/\s+/g, " ").trim();
        titleBuf = null;
        if (title) {
          const depth = sectionStack[sectionStack.length - 1] ?? 1;
          push("\n\n");
          headings.push({ title, depth, start: -1, end: -1 });
          push(`${"#".repeat(Math.min(depth + 1, 6))} ${title}\n`);
        }
      }
      continue;
    }
    if (closing || selfClosing) {
      if (CELL_TAGS.has(name)) push(" | ");
      else if (BLOCK_TAGS.has(name)) push("\n");
    }
  }

  let text = out.join("");
  // Spacing is normalised after conversion, so heading offsets are found by
  // locating each heading line in order.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/^ \| /, "").replace(/( \| )+$/, "").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  let cursor = 0;
  for (const h of headings) {
    const marker = `${"#".repeat(Math.min(h.depth + 1, 6))} ${h.title}`;
    const at = text.indexOf(marker, cursor);
    h.start = at >= 0 ? at : cursor;
    cursor = h.start + marker.length;
  }
  headings.forEach((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.depth <= h.depth);
    h.end = next ? next.start : text.length;
  });

  return { text, headings };
}

export async function fetchDocumentText(rceptNo: string, apiKey: string): Promise<DocumentText> {
  const buffer = await getBinary("document", { rcept_no: rceptNo }, apiKey);
  const bytes = new Uint8Array(buffer);

  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    const msg = new TextDecoder("utf-8").decode(bytes.slice(0, 500));
    const status = msg.match(/<status>(\d+)<\/status>/)?.[1] ?? "900";
    throw new OpenDartError(status, "document");
  }

  const { unzipSync } = await import("fflate");
  const files = unzipSync(bytes);
  const names = Object.keys(files).filter((n) => n.toLowerCase().endsWith(".xml"));
  if (names.length === 0) throw new OpenDartError("013", "document");
  // The main report is <rcept_no>.xml; attachments (audit reports etc.) carry a suffix.
  const fileName =
    names.find((n) => n === `${rceptNo}.xml`) ??
    names.sort((a, b) => files[b].length - files[a].length)[0];

  const { text, headings } = dartXmlToText(decodeXmlBytes(files[fileName]));
  return { fileName, text, headings };
}
