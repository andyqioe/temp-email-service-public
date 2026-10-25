import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../config/load';

/** Facts about the live account that CloudFormation cannot discover by itself. Written by `inbox preflight`. */
export interface PreflightState {
  version: 1;
  generatedAt: string;
  account: string;
  region: string;
  ruleSet: {
    name: string;
    /** True when this project creates and activates the rule set; false when adding rules to someone else's. */
    owned: boolean;
  };
  stages: Record<string, StagePreflight>;
}

export interface StagePreflight {
  /** Current state of the stage's receipt rule, so a deploy never re-enables a paused rule. */
  ruleEnabled: boolean;
  hostedZoneId?: string;
}

export const PREFLIGHT_FILE = path.join(REPO_ROOT, 'infra', '.preflight.json');

export function readPreflight(file = PREFLIGHT_FILE): PreflightState {
  if (!fs.existsSync(file)) {
    throw new Error(`${path.relative(process.cwd(), file)} is missing. Run \`npm run deploy -- --stage <stage>\` (it runs preflight first).`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PreflightState;
}

export function writePreflight(state: PreflightState, file = PREFLIGHT_FILE): void {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
