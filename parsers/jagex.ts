import { defineParser, type ParserInputV1 } from '@ses-inbox/parser-sdk';

/**
 * Jagex account verification codes. The subject reads "<CODE> is your Jagex verification code".
 * The rule in inbox.config.ts only routes authenticated mail from contact.jagex.com here.
 */
export interface JagexResult {
  code: string;
  source: 'subject' | 'body';
}

export const handler = defineParser<JagexResult>((input) => extractJagexCode(input));

/** Words that can sit in the code's position ("This is your Jagex verification code"). */
const NOT_A_CODE = new Set(['this', 'that', 'here', 'below', 'what', 'which', 'it', 'code', 'your', 'the', 'is']);

const SUBJECT = /(?:^|\s)([A-Za-z0-9]{4,12})\s+is\s+your\s+Jagex\s+verification\s+code\b/i;
const BODY_PATTERNS = [
  /(?:^|\s)([A-Za-z0-9]{4,12})\s+is\s+your\s+Jagex\s+verification\s+code\b/i,
  /verification\s+code(?:\s+is)?\s*[:-]?\s*([A-Za-z0-9]{4,12})\b/i,
];

export function extractJagexCode(input: Pick<ParserInputV1, 'subject' | 'text'>): JagexResult {
  const fromSubject = pick(SUBJECT.exec(input.subject)?.[1]);
  if (fromSubject) return { code: fromSubject, source: 'subject' };
  const text = (input.text ?? '').slice(0, 200_000);
  for (const pattern of BODY_PATTERNS) {
    const code = pick(pattern.exec(text)?.[1]);
    if (code) return { code, source: 'body' };
  }
  throw new Error('no Jagex verification code found in the subject or body');
}

function pick(candidate: string | undefined): string | undefined {
  if (!candidate || NOT_A_CODE.has(candidate.toLowerCase())) return undefined;
  return candidate;
}
