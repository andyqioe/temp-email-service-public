"""Read-only release scan. Prints locations/counts, never matching values."""
import hashlib
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATTERNS = {
    'qmail_token': r'sit_[A-Za-z0-9_-]{43}',
    'npm_token': r'npm_[A-Za-z0-9]{30,}',
    'aws_access_key': r'(?:AKIA|ASIA)[A-Z0-9]{16}',
    'github_token': r'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})',
    'private_key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'credential_literal': r'''(?i)(?:aws_secret_access_key|aws_session_token|INBOX_TOKEN|NPM_TOKEN)\s*[:=]\s*["'][^"'\n]{16,}["']''',
}
ALLOWED = {'package/package.json', 'package/README.md', 'package/LICENSE', 'package/THIRD_PARTY_NOTICES.txt', 'package/qmail.mjs'}
findings = []


def scan(name, data):
    text = data.decode('utf-8', errors='replace')
    for label, pattern in PATTERNS.items():
        count = len(re.findall(pattern, text))
        if count:
            findings.append({'path': name, 'category': label, 'count': count})


version = json.loads((ROOT / 'package.json').read_text())['version']
artifact = ROOT / 'dist' / f'andyqioe-qmail-{version}.tgz'
with tarfile.open(artifact) as archive:
    members = archive.getmembers()
    if len(members) != len(ALLOWED) or {m.name for m in members} != ALLOWED or any(not m.isfile() for m in members):
        raise SystemExit('Tarball inventory differs from the reviewed regular-file allowlist')
    for member in members:
        scan(member.name, archive.extractfile(member).read())
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
for name in sorted(set(filter(None, paths))):
    source = ROOT / name
    if source.is_symlink():
        findings.append({'path': name, 'category': 'symlink'})
    elif source.is_file():
        scan(name, source.read_bytes())
    if re.search(r'(^|/)(\.env(?:\..*)?|\.npmrc|credentials|inbox\.config\.ts|.*\.(pem|key))$', name):
        findings.append({'path': name, 'category': 'sensitive_filename'})
inputs = json.loads((ROOT / 'dist/build-inputs.json').read_text())['inputs']
for name in inputs:
    if re.search(r'(^|/)test/|mailparser|nodemailer|inbox\.config|(^|/)\.env', name):
        findings.append({'path': name, 'category': 'forbidden_bundle_input'})
print(json.dumps({
    'artifact': artifact.name,
    'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(),
    'source_files_scanned': len(set(filter(None, paths))),
    'bundle_inputs': len(inputs),
    'findings': findings,
    'limits': 'Pattern and file-boundary checks are not proof of absence of arbitrary or encoded secrets. No history scan or remote access is performed.',
}, indent=2))
sys.exit(bool(findings))
