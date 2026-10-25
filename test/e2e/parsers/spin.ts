import { defineParser } from '@ses-inbox/parser-sdk';

/** E2E parser that never returns, to prove the worker is terminated at its timeout. */
export const handler = defineParser(() => {
  for (;;) {
    // Busy loop: a promise-based timeout could never interrupt this.
  }
});
