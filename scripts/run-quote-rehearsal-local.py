"""Rehearse the quote provenance upgrade only in the verified restored database through an ephemeral VM SSH tunnel."""
import json
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ['--prepare', '--apply', '--replay'] or not Path(sys.argv[2]).is_absolute():
        raise ValueError('destination_required')
    root = Path(__file__).resolve().parent.parent
    reader = "import os,sys,json;os.chdir('/www/server/panel');sys.path.insert(0,'/www/server/panel/class');import public;print(json.dumps(public.M('config').where('id=?',(1,)).getField('mysql_root')))"
    remote = '/www/server/panel/pyenv/bin/python3 -B -c ' + shlex.quote(reader)
    captured = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'aurum-vm', remote],
                              capture_output=True, text=True, check=True, timeout=25)
    secret = json.loads(captured.stdout)
    if not isinstance(secret, str) or not secret or '\x00' in secret:
        raise ValueError('credential_unavailable')
    # Do not attach to or terminate an existing listener.
    with socket.socket() as check:
        check.bind(('127.0.0.1', 13316))
    tunnel = subprocess.Popen(['ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
                               '-L', '127.0.0.1:13316:127.0.0.1:3306', 'aurum-vm'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
    try:
        for _ in range(50):
            if tunnel.poll() is not None:
                raise RuntimeError('tunnel_ended')
            try:
                with socket.create_connection(('127.0.0.1', 13316), timeout=.2):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('tunnel_unavailable')
        result = subprocess.run(['node', str(root / 'scripts/rehearse-quote-provenance-local.mjs'),
                                 sys.argv[1], sys.argv[2]],
                                input=json.dumps({'host': '127.0.0.1', 'port': 13316, 'user': 'root', 'password': secret}),
                                capture_output=True, text=True, encoding='utf-8', cwd=root)
        sys.stdout.write(result.stdout)
        if result.returncode and not result.stdout.strip():
            print(json.dumps({'passed': False, 'code': 'child_failed_before_report', 'trace': [line.strip() for line in result.stderr.splitlines() if line.strip().startswith('at ')][:5]}))
        return result.returncode
    finally:
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()
            tunnel.wait()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'passed': False, 'code': 'quote_rehearsal_orchestration_failed', 'kind': type(error).__name__}))
        sys.exit(1)
