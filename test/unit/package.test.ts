import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from 'vitest';

const exec = promisify(execFile);

test('private tarball installs standalone and setup never registers implicitly', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qmail-package-'));
  const root = process.cwd();
  const env = { PATH: process.env.PATH, HOME: temp, XDG_CONFIG_HOME: path.join(temp, 'config'), AWS_EC2_METADATA_DISABLED: 'true' };
  const server = createServer((_req, res) => res.end(JSON.stringify({ messages: [{ id: 'fixture' }] })));
  try {
    await exec('npm', ['run', 'pack:cli'], { cwd: root, env });
    const manifest = JSON.parse(await fs.readFile('dist/qmail/package.json', 'utf8'));
    expect(manifest.name).toBe('@andyqioe/qmail');
    expect(manifest.publishConfig.access).toBe('restricted');
    expect(manifest.scripts).toBeUndefined();
    const tarball = path.join(root, 'dist/andyqioe-qmail-0.1.0.tgz');
    const files = await exec('tar', ['-tzf', tarball]);
    expect(files.stdout.trim().split('\n').sort()).toEqual(['package/LICENSE', 'package/README.md', 'package/THIRD_PARTY_NOTICES.txt', 'package/package.json', 'package/qmail.mjs']);
    expect(manifest.license).toBe('MIT');
    const inputs = JSON.parse(await fs.readFile('dist/build-inputs.json', 'utf8'));
    expect(Object.keys(inputs.inputs).filter((name) => /test\/|mailparser|nodemailer|inbox\.config/.test(name))).toEqual([]);
    await exec('npm', ['install', '--offline', '--no-audit', '--no-fund', '--prefix', temp, tarball], { cwd: temp, env });
    const bin = path.join(temp, 'node_modules/@andyqioe/qmail/qmail.mjs');
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      try {
        const result = await exec(process.execPath, [bin, ...args], { cwd: temp, env: { ...env, ...extra }, timeout: 5000 });
        return { ...result, code: 0 };
      } catch (error) {
        return error as Error & { stdout: string; stderr: string; code: number };
      }
    };
    expect((await run(['--help'])).code).toBe(0);
    const setup = await run(['setup']);
    expect(setup.code).toBe(1);
    expect(setup.stderr).toContain('in a terminal');
    expect((await run(['setup', '--yes'])).stderr).toContain('--method');
    expect((await run(['setup', '--method', 'aws', '--yes', '--name', 'fixture'])).stderr).toContain('--region');
    expect((await run(['setup', '--method', 'invalid'])).code).toBe(1);
    expect((await run(['setup', '--method', 'existing'])).stderr).toContain('--yes');
    expect((await run(['poll', 'fixture@example.test'])).stderr).toContain('qmail setup');
    const config = path.join(env.XDG_CONFIG_HOME, 'ses-inbox/config.json');
    await fs.mkdir(path.dirname(config), { recursive: true });
    const saved = JSON.stringify({ stages: { prod: { apiUrl: 'http://127.0.0.1:1', token: 'fixture-secret' } } });
    await fs.writeFile(config, saved, { mode: 0o600 });
    const preserved = await run(['setup', '--yes', '--name', 'other']);
    expect(preserved.code).toBe(0);
    expect(preserved.stderr).not.toContain('fixture-secret');
    expect(await fs.readFile(config, 'utf8')).toBe(saved);
    const replaceArgs = ['setup', '--method', 'existing', '--yes', '--replace', '--api-url', 'https://api.example.test'];
    const replaced = await run(replaceArgs, { INBOX_TOKEN: 'fixture-new' });
    expect(replaced.code).toBe(0);
    expect(replaced.stdout).toBe('');
    expect(replaced.stderr).not.toContain('fixture-new');
    expect(JSON.parse(await fs.readFile(config, 'utf8')).stages.prod.token).toBe('fixture-new');
    expect((await fs.stat(config)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(config))).mode & 0o777).toBe(0o700);
    expect((await run(['setup', '--method', 'existing', '--yes', '--stage', 'test', '--api-url', 'https://api.example.test'], { INBOX_TOKEN: 'second-stage' })).code).toBe(0);
    expect(Object.keys(JSON.parse(await fs.readFile(config, 'utf8')).stages).sort()).toEqual(['prod', 'test']);
    const validConfig = await fs.readFile(config, 'utf8');
    await fs.writeFile(config, '{malformed-private-data');
    const malformed = await run(replaceArgs, { INBOX_TOKEN: 'fixture-new' });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).not.toContain('malformed-private-data');
    expect(await fs.readFile(config, 'utf8')).toBe('{malformed-private-data');
    await fs.rm(config);
    const target = path.join(temp, 'untouched.json');
    await fs.writeFile(target, validConfig);
    await fs.symlink(target, config);
    expect((await run(replaceArgs, { INBOX_TOKEN: 'fixture-new' })).stderr).toContain('symlink');
    expect(await fs.readFile(target, 'utf8')).toBe(validConfig);
    await fs.rm(config);
    await fs.writeFile(config, validConfig);

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const mail = await run(['poll', 'fixture@example.test', '--mode=once', '--json'], {
      INBOX_API_URL: `http://127.0.0.1:${address.port}`, INBOX_TOKEN: 'fixture-token',
    });
    expect(mail.code).toBe(0);
    expect(mail.stdout).toBe('{"id":"fixture"}\n');
    expect(mail.stderr).toBe('');
    const awsRequests: string[] = [];
    const awsServer = createServer((req, res) => {
      const target = String(req.headers['x-amz-target'] ?? 'DescribeStacks');
      awsRequests.push(target);
      req.resume();
      if (target === 'DescribeStacks') {
        res.setHeader('content-type', 'text/xml');
        res.end('<DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><DescribeStacksResult><Stacks><member><StackName>fixture</StackName><Outputs><member><OutputKey>ApiUrl</OutputKey><OutputValue>https://fixture.example.test</OutputValue></member><member><OutputKey>TableName</OutputKey><OutputValue>fixture-table</OutputValue></member></Outputs></member></Stacks></DescribeStacksResult></DescribeStacksResponse>');
      } else { res.setHeader('content-type', 'application/x-amz-json-1.0'); res.end('{}'); }
    });
    awsServer.listen(0, '127.0.0.1');
    await once(awsServer, 'listening');
    try {
      const endpoint = `http://127.0.0.1:${(awsServer.address() as { port: number }).port}`;
      const aws = await run(['setup', '--method', 'aws', '--yes', '--region', 'us-east-1', '--stack', 'fixture', '--name', 'fixture', '--stage', 'aws'], {
        AWS_ENDPOINT_URL_CLOUDFORMATION: endpoint, AWS_ENDPOINT_URL_DYNAMODB: endpoint,
        AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture',
      });
      expect(aws.code, aws.stderr).toBe(0);
      expect(awsRequests.some((name) => name.includes('DescribeStacks'))).toBe(true);
      expect(awsRequests.some((name) => name.includes('TransactWriteItems'))).toBe(true);
      const awsConfig = JSON.parse(await fs.readFile(config, 'utf8'));
      expect(awsConfig.stages.aws.token).toMatch(/^sit_/);
      expect(aws.stdout + aws.stderr).not.toContain(awsConfig.stages.aws.token);
    } finally { awsServer.closeAllConnections(); awsServer.close(); }

  } finally {
    server.closeAllConnections();
    server.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}, 60_000);
