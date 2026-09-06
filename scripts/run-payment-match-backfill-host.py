"""Approved-host launcher: BaoTa credential stays in anonymous, inherited memory FDs.

No environment file, service, database grant, or disk credential file is changed.
The export/restore gate lives in execute-v4-backup.mjs, not in this launcher.
"""
import json
import os
import re
import subprocess
import sys


def main():
    if len(sys.argv) != 1 or sys.platform != 'linux' or os.getuid() != 0:
        raise ValueError('scope')
    database_user = 'root'
    # Use the panel's supported read path; do not read a stale encrypted SQLite field.
    reader = (
        "import os,sys,json;os.chdir('/www/server/panel');"
        "sys.path.insert(0,'/www/server/panel/class');import public;"
        "print(json.dumps(public.M('config').where('id=?',(1,)).getField('mysql_root')))"
    )
    result = subprocess.run(
        ["/www/server/panel/pyenv/bin/python3", "-B", "-c", reader],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=True,
    )
    password = json.loads(result.stdout)
    if not isinstance(password, str) or not password or "\x00" in password:
        raise ValueError("credential")
    credential = {"user": database_user, "password": password, "socketPath": "/tmp/mysql.sock"}
    def quote(value):
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t') + '"'
    defaults = '[client]\nuser=' + quote(database_user) + '\npassword=' + quote(password) + '\nprotocol=SOCKET\nsocket="/tmp/mysql.sock"\n'
    fds = []
    try:
        for name, payload in [("aurum-backup-credential", json.dumps(credential)), ("aurum-backup-client", defaults)]:
            fd = os.memfd_create(name, os.MFD_CLOEXEC)
            fds.append(fd)
            os.fchmod(fd, 0o600)
            os.write(fd, payload.encode("utf-8"))
            os.lseek(fd, 0, os.SEEK_SET)
        env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC",
               "V4_BACKUP_CREDENTIAL_FD": str(fds[0]), "V4_BACKUP_MYSQL_DEFAULTS_FD": str(fds[1]),
               "V4_BACKUP_MYSQL2_MODULE": "/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js"}
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rehearse-payment-match-backfill-host.mjs")
        completed = subprocess.run(
            ["/www/server/nodejs/v24.18.0/bin/node", script],
            env=env, pass_fds=tuple(fds), timeout=7200,
        )
        return completed.returncode
    finally:
        for fd in fds:
            os.close(fd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print('{"status":"failed","code":"backup_host_launcher_failed"}', file=sys.stderr)
        sys.exit(1)
