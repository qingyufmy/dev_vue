"""Mirror rehearsal helper: credential JSON is inherited through anonymous memory."""
import json
import os
from pathlib import Path
import subprocess
import sys

def main():
    if sys.platform != 'linux' or os.getuid() != 0 or len(sys.argv) not in (3, 4):
        raise ValueError('scope')
    mode = sys.argv[1]
    if mode not in ('prepare', 'check', 'apply', 'recover', 'verify'):
        raise ValueError('mode')
    if len(sys.argv) != (4 if mode == 'prepare' else 3):
        raise ValueError('arguments')
    directory = Path(__file__).resolve().parents[2]
    for value in sys.argv[2:]:
        if not Path(value).resolve().is_relative_to(directory):
            raise ValueError('path')
    env = json.load(sys.stdin)
    fd = os.memfd_create('settings-rehearsal-environment', os.MFD_CLOEXEC)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, json.dumps(env).encode('utf-8'))
        os.lseek(fd, 0, os.SEEK_SET)
        script = 'prepare-dev-vue-settings.mjs' if mode == 'prepare' else 'migrate-dev-vue-settings.mjs'
        args = ['/www/server/nodejs/v24.18.0/bin/node', str(Path(__file__).parent / script),
                '--write' if mode == 'prepare' else '--' + mode, *sys.argv[2:]]
        return subprocess.run(args, env={'PATH': '/usr/bin:/bin', 'TZ': 'UTC', 'AURUM_SETTINGS_ENV_FD': str(fd)},
                              pass_fds=(fd,), timeout=180).returncode
    finally:
        os.close(fd)

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"code":"settings_cli_helper_failed"}', file=sys.stderr)
        sys.exit(1)
