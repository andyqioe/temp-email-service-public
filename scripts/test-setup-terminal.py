"""Local POSIX PTY regression for hidden entry and cancellation; build CLI first."""
import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

cli = Path(__file__).resolve().parent.parent / 'dist/qmail/qmail.mjs'
with tempfile.TemporaryDirectory() as temp:
    for cancel in (False, True):
        master, slave = pty.openpty()
        env = {'PATH': os.environ['PATH'], 'HOME': temp, 'XDG_CONFIG_HOME': temp + '/config', 'AWS_EC2_METADATA_DISABLED': 'true'}
        proc = subprocess.Popen(['node', str(cli), 'setup', '--method', 'existing', '--api-url', 'https://example.test', '--replace'], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        output = b''
        sent = confirmed = False
        deadline = time.monotonic() + 8
        try:
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        break
                if b'API token (hidden)' in output and not sent:
                    os.write(master, b'\x03' if cancel else b'synthetic-pty-token\r')
                    sent = True
                if b'[y/N]' in output and not confirmed:
                    os.write(master, b'y\r')
                    confirmed = True
                if proc.poll() is not None:
                    break
            if proc.poll() is None:
                raise AssertionError('Setup did not terminate')
            assert sent and b'synthetic-pty-token' not in output, 'Token entry echoed or never started'
            assert proc.returncode == (1 if cancel else 0), 'Unexpected setup exit code'
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            os.close(master)
print('PASS: hidden token entry, explicit consent, Ctrl-C cancellation and process termination')
