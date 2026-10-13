import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveApiKey } from "@/lib/opendart/client";
import { fetchDocumentText } from "@/lib/opendart/document";
import { formatApiError } from "@/lib/opendart/errors";

const DEFAULT_MAX_CHARS = 20000;

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "opendart_document",
    {
      title: "공시 원문 (Filing Original Text)",
      description: `Read the original text of a DART filing (사업보고서, 반기·분기보고서, 주요사항보고서 등) from OpenDART document.xml.
Text is returned as written in the filing, so sentences can be quoted and matched against the original. Tables become rows of cells joined with " | ".

Usage:
  1. Find the receipt number (rcept_no) with opendart_search_disclosure.
  2. Call without section to get the table of contents (headings with their sizes).
  3. Call with section (part of a heading, e.g. "사업의 내용", "매출 및 수주상황") to read that section, including its sub-sections.
  4. If the result says more text remains, call again with the given offset.

Args:
  - rcept_no: 14-digit receipt number (접수번호)
  - section (optional): text contained in the heading to read. Omit for the table of contents
  - offset (optional): character offset within the section (or whole document) to start from (default 0)
  - max_chars (optional): characters to return per call (default ${DEFAULT_MAX_CHARS}, max 50000)`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14-digit receipt number (접수번호)"),
        section: z.string().optional().describe("Text contained in the heading to read, e.g. '사업의 내용'. Omit for the table of contents"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
        max_chars: z.number().int().min(1000).max(50000).optional().describe(`Characters per call (default ${DEFAULT_MAX_CHARS})`),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ rcept_no, section, offset = 0, max_chars = DEFAULT_MAX_CHARS, api_key }) => {
      try {
        const key = resolveApiKey(api_key);
        const doc = await fetchDocumentText(rcept_no, key);

        if (!section) {
          const toc = doc.headings
            .map((h) => `${"  ".repeat(Math.max(h.depth - 1, 0))}- ${h.title} (${(h.end - h.start).toLocaleString()}자)`)
            .join("\n");
          const text = `## 목차 (Table of Contents) — ${rcept_no}\n\n파일: ${doc.fileName}, 전체 ${doc.text.length.toLocaleString()}자\n\n${toc || "(목차 없음: section 없이 offset으로 전체 본문을 읽으세요)"}`;
          return { content: [{ type: "text" as const, text }] };
        }

        const query = section.replace(/\s+/g, "");
        const matches = doc.headings.filter((h) => h.title.replace(/\s+/g, "").includes(query));
        if (matches.length === 0) {
          const titles = doc.headings.map((h) => h.title).join(", ");
          return {
            content: [{ type: "text" as const, text: `No heading contains "${section}". / 해당 제목이 없습니다.\n\n제목 목록: ${titles}` }],
            isError: true,
          };
        }

        const target = matches[0];
        const body = doc.text.slice(target.start, target.end);
        const chunk = body.slice(offset, offset + max_chars);
        const next = offset + chunk.length;
        const lines = [
          `## ${target.title} — ${rcept_no}`,
          `구간 ${offset.toLocaleString()}~${next.toLocaleString()} / ${body.length.toLocaleString()}자`,
        ];
        if (matches.length > 1) lines.push(`다른 일치 제목: ${matches.slice(1).map((h) => h.title).join(", ")}`);
        lines.push("", chunk);
        if (next < body.length) lines.push("", `… 남은 본문 ${(body.length - next).toLocaleString()}자. 이어 읽기: offset=${next}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
