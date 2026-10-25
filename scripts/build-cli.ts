import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/qmail');
const source = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
await fs.mkdir(out, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['cli/main.ts'],
  outfile: path.join(out, 'qmail.mjs'),
  bundle: true,
  metafile: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { QMAIL_PACKAGED: 'true' },
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as qmailCreateRequire } from "node:module"; const require = qmailCreateRequire(import.meta.url);' },
});
await fs.chmod(path.join(out, 'qmail.mjs'), 0o755);
await fs.writeFile(path.join(out, 'package.json'), `${JSON.stringify({
  name: '@andyqioe/qmail',
  version: source.version,
  description: 'Receive-only SES inbox CLI',
  license: 'MIT',
  type: 'module',
  engines: { node: '>=22' },
  bin: { qmail: 'qmail.mjs' },
  files: ['qmail.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'],
  publishConfig: { access: 'restricted', registry: 'https://registry.npmjs.org/' },
}, null, 2)}\n`);
await fs.copyFile(path.join(root, 'README.md'), path.join(out, 'README.md'));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
await fs.writeFile(path.join(root, 'dist/build-inputs.json'), JSON.stringify(result.metafile, null, 2));
const packageDirs = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let dir = path.dirname(path.resolve(root, input));
  while (dir !== root && dir !== path.dirname(dir)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (metadata.name && metadata.version) {
        packageDirs.add(dir);
        break;
      }
      dir = path.dirname(dir);
    } catch {
      dir = path.dirname(dir);
    }
  }
}
const notices: string[] = [];
for (const dir of [...packageDirs].sort()) {
  const metadata = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
  const files = (await fs.readdir(dir)).filter((name) => /^(license|licence|notice|copying)([.-]|$)/i.test(name));
  if (!files.length && metadata.name.startsWith('@aws-sdk/') && metadata.license === 'Apache-2.0') {
    notices.push(`${metadata.name}@${metadata.version} (Apache-2.0)`, await fs.readFile(path.join(root, 'node_modules/@aws-sdk/client-s3/LICENSE'), 'utf8'));
    continue;
  }
  if (!files.length) throw new Error(`Missing bundled dependency license: ${metadata.name}`);
  notices.push(`${metadata.name}@${metadata.version} (${metadata.license ?? 'see license'})`);
  for (const name of files) notices.push(await fs.readFile(path.join(dir, name), 'utf8'));
}
await fs.writeFile(path.join(out, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
console.log(`Built ${out}. No publication or token creation performed.`);
