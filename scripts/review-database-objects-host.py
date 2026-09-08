"""Read-only privileged object inventory. No credentials or object bodies leave the host."""
import hashlib
import json
import os
import subprocess

reader = "import os,sys,json;os.chdir('/www/server/panel');sys.path.insert(0,'/www/server/panel/class');import public;print(json.dumps(public.M('config').where('id=?',(1,)).getField('mysql_root')))"
loaded = subprocess.run(['/www/server/panel/pyenv/bin/python3', '-B', '-c', reader], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=True)
password = json.loads(loaded.stdout)
if not isinstance(password, str) or not password or '\x00' in password:
    raise ValueError('credential_unavailable')

def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r') + '"'

fd = os.memfd_create('database-object-review', os.MFD_CLOEXEC)
os.fchmod(fd, 0o600)
os.write(fd, ('[client]\nuser=root\npassword=' + quote(password) + '\nprotocol=SOCKET\nsocket=/tmp/mysql.sock\n').encode())

def sql(query):
    if not query.startswith('SELECT ') or ';' in query:
        raise ValueError('read_only_query_required')
    result = subprocess.run(['/www/server/mysql/bin/mysql', '--defaults-extra-file=/proc/self/fd/' + str(fd), '--batch', '--skip-column-names', '--raw'], input=query.encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, pass_fds=(fd,), timeout=30)
    if result.returncode:
        raise ValueError('metadata_read_failed')
    return result.stdout.decode().strip()

try:
    uuid = sql('SELECT @@server_uuid')
    if uuid != 'ac423207-6ef3-11f1-b302-000c29fda104':
        raise ValueError('server_identity_mismatch')
    queries = {
        'triggers': "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',TRIGGER_NAME,'table',EVENT_OBJECT_TABLE,'timing',ACTION_TIMING,'event',EVENT_MANIPULATION,'body_sha256',SHA2(ACTION_STATEMENT,256))),JSON_ARRAY()) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='dev_vue'",
        'views': "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',TABLE_NAME,'definition_sha256',SHA2(VIEW_DEFINITION,256),'security',SECURITY_TYPE)),JSON_ARRAY()) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='dev_vue'",
        'routines': "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',ROUTINE_NAME,'type',ROUTINE_TYPE,'body_sha256',SHA2(ROUTINE_DEFINITION,256),'security',SECURITY_TYPE)),JSON_ARRAY()) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='dev_vue'",
        'events': "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',EVENT_NAME,'status',STATUS,'body_sha256',SHA2(EVENT_DEFINITION,256))),JSON_ARRAY()) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='dev_vue'",
    }
    first = {key: json.loads(sql(query)) for key, query in queries.items()}
    second = {key: json.loads(sql(query)) for key, query in queries.items()}
    if first != second:
        raise ValueError('objects_changed_during_read')
    report = {'kind': 'database-privileged-object-review/v1', 'database': 'dev_vue', 'server_uuid': uuid,
              'observed_at_utc': sql("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ')"),
              'privileged_metadata': True, 'database_writes': 0, 'privilege_changes': 0,
              'two_reads_equal': True, 'objects': first}
    print(json.dumps(report, ensure_ascii=True))
finally:
    os.close(fd)
