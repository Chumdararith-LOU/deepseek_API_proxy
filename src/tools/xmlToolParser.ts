import crypto from "node:crypto";
import { TOOL_CALL_KEYWORDS } from "../utils/tagNames.ts";

export interface ParsedXmlToolCall {
  name: string;
  parameters: Record<string, string>;
}

// ── Pre-compiled regexes for parse path ──
// Lifted to module-level to avoid recompilation on every parseXmlToolCalls() call
// (called 50-200 times per streaming request).
const FKW = TOOL_CALL_KEYWORDS[0]; // 'function' — the block-level keyword
const PKW = TOOL_CALL_KEYWORDS[1]; // 'parameter' — the parameter keyword
const FUNCTION_BLOCK_RE = new RegExp(`<${FKW}=[^\\s>]+[\\s\\S]*?>[\\s\\S]*?(?:<\\/${FKW}>|$)`, "g");
const PARAM_RE = new RegExp(`<${PKW}=([^\\s>]+)>([\\s\\S]*?)<\\/${PKW}>`, "g");
const FUNC_NAME_RE = new RegExp(`^<${FKW}=([^\\s>]+)>`);

// ── DSML format (DeepSeek V4 native tool-call syntax) ──
// <｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="tool"><｜｜DSML｜｜parameter name="key" string="true">value</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>
// `<` is optional everywhere: cumulative-frame delta computation can strip a tag's
// leading `<` when the previous frame ended mid-tag, leaving headless fragments.
const DSML_CONTAINER_RE = /<?\/?｜｜DSML｜｜tool_calls\s*>/g;
const DSML_INVOKE_RE = /<?｜｜DSML｜｜invoke\b([^>]*)>([\s\S]*?)<?\/｜｜DSML｜｜invoke\s*>/g;
const DSML_PARAM_RE = /<?｜｜DSML｜｜parameter\b([^>]*)>([\s\S]*?)<?\/｜｜DSML｜｜parameter\s*>/g;
const DSML_NAME_ATTR_RE = /(?:^|\s)name\s*=\s*["']([^"']+)["']/;
// <invoke name="...">json-args</invoke> — gateway round-trip format echoed by some clients
const INVOKE_RE = /<invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke\s*>/g;
const XML_ENTITY_RE = /&(?:quot|amp|lt|gt|apos|#\d+);/g;

function decodeXmlEntities(s: string): string {
  return s.replace(XML_ENTITY_RE, (e) => {
    if (e === "&quot;") return '"';
    if (e === "&amp;") return "&";
    if (e === "&lt;") return "<";
    if (e === "&gt;") return ">";
    if (e === "&apos;") return "'";
    return String.fromCodePoint(Number(e.slice(2, -1)));
  });
}

function functionNameFromTag(tag: string): string | null {
  // Match function name from <KEYWORD=NAME...> — NAME can be any non-whitespace, non-> chars
  const m = tag.match(FUNC_NAME_RE);
  return m ? m[1] : null;
}

export function parseXmlToolCalls(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const toolCalls: ParsedXmlToolCall[] = [];
  const unique = new Set<string>();
  let cleanedText = text;

  // DSML format first (DeepSeek V4 native tool-call syntax)
  DSML_INVOKE_RE.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while (true) {
    dm = DSML_INVOKE_RE.exec(text);
    if (dm === null) break;
    const nameM = dm[1].match(DSML_NAME_ATTR_RE);
    if (!nameM) continue;
    const parameters: Record<string, string> = {};
    DSML_PARAM_RE.lastIndex = 0;
    let dpm: RegExpExecArray | null;
    while (true) {
      dpm = DSML_PARAM_RE.exec(dm[2]);
      if (dpm === null) break;
      const pnameM = dpm[1].match(DSML_NAME_ATTR_RE);
      if (pnameM) parameters[pnameM[1]] = decodeXmlEntities(dpm[2].trim());
    }
    toolCalls.push({ name: nameM[1], parameters });
  }
  if (toolCalls.length > 0) {
    DSML_INVOKE_RE.lastIndex = 0;
    cleanedText = cleanedText.replace(DSML_INVOKE_RE, "").replace(DSML_CONTAINER_RE, "");
  }

  // <invoke name="...">json</invoke> round-trip format (safety net for echoed history)
  if (cleanedText.includes("<invoke")) {
    INVOKE_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while (true) {
      im = INVOKE_RE.exec(cleanedText);
      if (im === null) break;
      const parameters: Record<string, string> = {};
      try {
        const parsedArgs = JSON.parse(decodeXmlEntities(im[2].trim()));
        if (parsedArgs && typeof parsedArgs === "object") {
          for (const [k, v] of Object.entries(parsedArgs)) {
            parameters[k] = typeof v === "string" ? v : JSON.stringify(v);
          }
        }
      } catch {
        // malformed JSON body — emit call with empty args
      }
      toolCalls.push({ name: decodeXmlEntities(im[1]), parameters });
    }
    INVOKE_RE.lastIndex = 0;
    cleanedText = cleanedText.replace(INVOKE_RE, "");
  }

  // Fast path: skip the expensive regex exec loop when there's no tool call content
  const hasToolCallStart = TOOL_CALL_KEYWORDS.some((kw) => cleanedText.includes(`<${kw}=`));
  if (!hasToolCallStart) return { toolCalls, cleanedText: cleanedText.replace(/\n{3,}/g, "\n\n") };

  // Semantics: <keyword=NAME...chars...> body </keyword>
  // Matches the opening <keyword=, captures until first >, then lazily until </keyword> or end.
  FUNCTION_BLOCK_RE.lastIndex = 0;
  const re = FUNCTION_BLOCK_RE;
  const sections: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while (true) {
    match = re.exec(text);
    if (match === null) break;
    if (unique.has(match[0])) continue;
    unique.add(match[0]);

    const name = functionNameFromTag(match[0]);
    if (!name) continue;

    const closingTag = `</${FKW}>`;
    const closingIndex = match[0].lastIndexOf(closingTag);
    if (closingIndex === -1) continue; // malformed — no closing tag
    const body = match[0].slice(match[0].indexOf(">") + 1, closingIndex);

    const parameters: Record<string, string> = {};
    PARAM_RE.lastIndex = 0;
    const paramRe = PARAM_RE;
    let pm: RegExpExecArray | null;
    while (true) {
      pm = paramRe.exec(body);
      if (pm === null) break;
      parameters[pm[1].trim()] = pm[2].trim();
    }

    toolCalls.push({ name, parameters });
    sections.push(text.slice(lastIdx, match.index));
    lastIdx = re.lastIndex;
  }

  sections.push(text.slice(lastIdx));
  cleanedText = sections.join("");

  return { toolCalls, cleanedText: cleanedText.replace(/\n{3,}/g, "\n\n") };
}

/**
 * Pre-compiled regexes for stripping remaining XML markup.
 * Built dynamically from the shared TOOL_CALL_KEYWORDS array so adding
 * new tool call tag keywords is a one-line change.
 */
const [TOOL_MARKUP_RE, EXCESS_NEWLINES_RE] = (() => {
  const markupParts: string[] = [];
  for (const kw of TOOL_CALL_KEYWORDS) {
    // 1. Complete block (or truncated at next occurrence of same keyword)
    markupParts.push(`<${kw}=[^\\s>][^>]*>[\\s\\S]*?(?:<\\/${kw}>|<${kw}=|$)`);
    // 2. Bare tag with =value (no >, or > at end)
    markupParts.push(`<${kw}=[^>]*(?:>|(?=\\n|$))`);
    // 3. Bare <keyword prefix followed by whitespace, <, or end
    markupParts.push(`<${kw}(?=[\\s<]|$)`);
    // 4. Opening/closing tag
    markupParts.push(`<\\/?${kw}>`);
  }
  // DSML leftovers (partial/orphaned tags — complete blocks are removed during parse).
  // `<` is optional: cumulative-delta computation can strip a tag's leading `<`,
  // leaving headless fragments like `｜｜DSML｜｜tool_calls>`.
  markupParts.push("<?/?｜｜DSML｜｜[\\s\\S]*?(?:｜｜>|$)");
  markupParts.push("<?/?｜｜DSML｜｜tool_calls\\s*>");
  return [new RegExp(markupParts.join("|"), "g"), /\n{3,}/g];
})();

function stripRemainingXmlMarkup(text: string): string {
  return text.replace(TOOL_MARKUP_RE, "").replace(EXCESS_NEWLINES_RE, "\n\n");
}

export function cleanTextOfXmlArtifacts(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const { toolCalls, cleanedText } = parseXmlToolCalls(text);
  const fullyCleaned = stripRemainingXmlMarkup(cleanedText);
  return { toolCalls, cleanedText: fullyCleaned };
}

export function xmlToolCallToParsed(
  block: ParsedXmlToolCall,
  _index: number,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.parameters)) {
    try {
      args[key] = JSON.parse(value);
    } catch {
      args[key] = value;
    }
  }
  const rawName = block.name;
  const name = rawName.startsWith("★-") ? rawName.slice(2) : rawName;
  return {
    id: `call_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}
