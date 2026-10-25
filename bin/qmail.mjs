#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so `npm link` gives you a global `qmail` command.
import { register } from 'tsx/esm/api';

register();
await import('../cli/main.ts');
