import type { ParserModuleName } from './names';
import { handler as echo } from '../test/e2e/parsers/echo';
import { handler as fail } from '../test/e2e/parsers/fail';
import { handler as spin } from '../test/e2e/parsers/spin';
import { handler as otp } from './example-otp';
import { handler as jagex } from './jagex';

/**
 * Every parser module that can be referenced by a rule's `module` in inbox.config.ts.
 * Ingest bundles all of them and runs the matching ones in worker threads.
 * To add a parser: write it with defineParser, add it here, then add a rule to the stage config.
 */
export const PARSER_MODULES = {
  otp,
  jagex,
  // Test-only modules used by the e2e stage.
  echo,
  fail,
  spin,
} satisfies Record<ParserModuleName, (event: unknown) => Promise<unknown>>;


export { PARSER_MODULE_NAMES, type ParserModuleName } from './names';
