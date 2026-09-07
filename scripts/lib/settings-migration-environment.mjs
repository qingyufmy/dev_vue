import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import { requireBackfill as check } from './v4-backfill-contract.mjs'

export async function loadSettingsMigrationEnvironment(root) {
  const fd = process.env.AURUM_SETTINGS_ENV_FD
  let env
  if (fd !== undefined) {
    check(process.platform === 'linux' && process.getuid() === 0 && /^[1-9][0-9]{0,5}$/.test(fd)
      && Number(fd) >= 3, 'settings_environment_fd_scope')
    env = JSON.parse(await readFile(`/proc/self/fd/${fd}`, 'utf8'))
    check(env && typeof env === 'object' && !Array.isArray(env), 'settings_environment_invalid')
  } else env = parse(await readFile(new URL('server/.env', root)))
  check(typeof env.MYSQL_DATABASE === 'string' && (env.MYSQL_DATABASE === 'dev_vue'
    || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(env.MYSQL_DATABASE)), 'settings_environment_database')
  check(typeof env.MYSQL_USER === 'string' && typeof env.MYSQL_PASSWORD === 'string', 'settings_environment_credentials')
  return env
}

export function settingsMigrationConnectionOptions(env) {
  check(env.MYSQL_SOCKET === undefined || env.MYSQL_SOCKET === '/tmp/mysql.sock', 'settings_environment_socket')
  return { host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
    ...(env.MYSQL_SOCKET ? { socketPath: env.MYSQL_SOCKET } : {}),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE,
    dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true }
}
