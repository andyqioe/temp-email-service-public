import { defineParser } from '@ses-inbox/parser-sdk';

/** E2E parser that always fails, to exercise retries, error status, and the parse DLQ. */
export const handler = defineParser(() => {
  throw new Error('deliberate failure from the e2e fail parser');
});
