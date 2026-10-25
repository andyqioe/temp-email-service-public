import { defineParser, type ParserInputV1 } from '@ses-inbox/parser-sdk';

/**
 * Example parser: pulls one-time codes and verification links out of a message.
 * To write your own: copy this file, register it in parsers/registry.ts, and add a rule
 * (`{ name, module, match }`) to the stage's `parsers` in inbox.config.ts.
 */
export interface OtpResult {
  /** Best guess at the one-time code, or null. */
  code: string | null;
  /** Every candidate code, best first. */
  codes: string[];
  /** Links that look like verify / confirm / sign-in links, in document order. */
  links: string[];
}

export const handler = defineParser<OtpResult>((input) => extractOtp(input));

/** Parsers see untrusted input; scanning is capped so cost stays linear and small. */
const MAX_SCAN = 200_000;

export function extractOtp(input: Pick<ParserInputV1, 'subject' | 'text' | 'html'>): OtpResult {
  const text = (input.text ?? htmlToText(input.html ?? '')).slice(0, MAX_SCAN);
  // URLs are full of token-like strings ("?token=abc123"); never read codes out of them.
  const codes = findCodes(`${input.subject}\n${text.replace(/https?:\/\/\S+/gi, ' ')}`);
  return { code: codes[0] ?? null, codes, links: findLinks(input.html, input.text) };
}

/** "code", "OTP", "passcode", "PIN", or "token", optionally followed by "is", then the code itself. */
const KEYWORD = /\b(?:code|otp|passcode|pin|token)\b\W{0,20}(?:is\b)?\W{0,10}(\d{3}[ -]\d{3}|[A-Za-z0-9]{4,10})\b/gi;
// Bare numbers count only when they stand alone: not part of a word or handle ("maria#1459"),
// a path, a date, or a time.
const SIX_DIGITS = /(?<![\w#/.:-])\d{6}(?![\w/.:-])/g;
const FOUR_TO_EIGHT = /(?<![\w#/.:-])\d{4,8}(?![\w/.:-])/g;

export function findCodes(text: string): string[] {
  const ranked: string[] = [];
  const add = (c: string) => {
    const code = c.replace(/[\s-]/g, '');
    if (code.length >= 4 && code.length <= 10 && /\d/.test(code) && !looksLikeYear(code) && !ranked.includes(code)) {
      ranked.push(code);
    }
  };
  for (const m of text.matchAll(KEYWORD)) add(m[1] ?? '');
  for (const m of text.matchAll(SIX_DIGITS)) add(m[0]);
  for (const m of text.matchAll(FOUR_TO_EIGHT)) add(m[0]);
  return ranked;
}

const LINK_HINT = /verif|confirm|activat|validat|magic|token|log[- ]?in|sign[- ]?in|auth|reset|password|invite|unlock/i;

export function findLinks(html: string | undefined, text: string | undefined): string[] {
  const found: string[] = [];
  const add = (url: string, context = '') => {
    // Trailing punctuation is almost never part of a URL; html-to-text also wraps links as "text [url]".
    const clean = decodeEntities(url).trim().replace(/[)\]}>.,;:!?'"]+$/, '');
    if (!/^https?:\/\//i.test(clean)) return;
    if (!LINK_HINT.test(clean) && !LINK_HINT.test(context)) return;
    if (!found.includes(clean)) found.push(clean);
  };
  if (html) {
    for (const a of anchors(html.slice(0, MAX_SCAN))) add(a.href, htmlToText(a.text));
  }
  if (text) {
    for (const m of text.slice(0, MAX_SCAN).matchAll(/https?:\/\/[^\s<>"']+/gi)) add(m[0]);
  }
  return found.slice(0, 20);
}

function looksLikeYear(code: string): boolean {
  return /^(19|20)\d{2}$/.test(code);
}

/**
 * Linear scan for <a href="...">text</a>. A backtracking regex here is quadratic on crafted
 * input with many unclosed tags; indexOf-based scanning stops as soon as a closer is missing.
 */
function anchors(html: string): Array<{ href: string; text: string }> {
  const lower = html.toLowerCase();
  const out: Array<{ href: string; text: string }> = [];
  let pos = 0;
  let closersLeft = true;
  while (out.length < 200) {
    const start = lower.indexOf('<a', pos);
    if (start === -1) break;
    const tagEnd = lower.indexOf('>', start);
    if (tagEnd === -1) break;
    pos = tagEnd + 1;
    if (!/\s/.test(lower.charAt(start + 2))) continue; // <abbr>, <area>, ...
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html.slice(start, tagEnd));
    if (!href) continue;
    let text = '';
    if (closersLeft) {
      const close = lower.indexOf('</a', pos);
      if (close === -1) closersLeft = false;
      else text = html.slice(pos, close);
    }
    out.push({ href: href[1] ?? href[2] ?? '', text });
  }
  return out;
}

function stripBlocks(html: string, tag: 'script' | 'style'): string {
  const lower = html.toLowerCase();
  let out = '';
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(`<${tag}`, pos);
    if (start === -1) return out + html.slice(pos);
    out += `${html.slice(pos, start)} `;
    const end = lower.indexOf(`</${tag}`, start);
    if (end === -1) return out; // unclosed: drop the rest
    const close = lower.indexOf('>', end);
    pos = close === -1 ? html.length : close + 1;
  }
}

function htmlToText(html: string): string {
  return decodeEntities(
    stripBlocks(stripBlocks(html.slice(0, MAX_SCAN), 'script'), 'style')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}
