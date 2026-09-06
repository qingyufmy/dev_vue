"""Test the payment order writer with synthetic rows in the development reference schema."""
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    if sys.platform != 'linux' or os.getuid() != 0 or len(sys.argv) != 1:
        raise ValueError('scope')
    reader = "import os,sys,json;os.chdir('/www/server/panel');sys.path.insert(0,'/www/server/panel/class');import public;print(json.dumps(public.M('config').where('id=?',(1,)).getField('mysql_root')))"
    result = subprocess.run(['/www/server/panel/pyenv/bin/python3', '-B', '-c', reader],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=True)
    password = json.loads(result.stdout)
    if not isinstance(password, str) or not password or '\x00' in password:
        raise ValueError('credential')
    fd = os.memfd_create('aurum-payment-order-probe', os.MFD_CLOEXEC)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, json.dumps({'user': 'root', 'password': password, 'socketPath': '/tmp/mysql.sock'}).encode())
        os.lseek(fd, 0, os.SEEK_SET)
        script = Path(__file__).resolve().with_name('probe-setting-reader-host.mjs')
        return subprocess.run(['/www/server/nodejs/v24.18.0/bin/node', str(script)],
                              env={'PATH': '/usr/bin:/bin', 'TZ': 'UTC', 'V4_BACKUP_CREDENTIAL_FD': str(fd)},
                              pass_fds=(fd,), timeout=90).returncode
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"status":"failed","code":"payment_order_launcher_failed"}', file=sys.stderr)
        sys.exit(1)
