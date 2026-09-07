import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from '../scripts/lib/settings-migration-environment.mjs'

it('only admits dev_vue and explicitly named restore mirrors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'settings-env-'))
  try {
    await mkdir(join(directory, 'server'))
    for (const database of ['dev_vue', 'dev_vue_m1_source_20260907_02', 'production', 'dev_xin', 'dev_vue_m1_source_other']) {
      await writeFile(join(directory, 'server/.env'), `MYSQL_DATABASE=${database}\nMYSQL_USER=fixture\nMYSQL_PASSWORD=fixture\n`)
      const result = loadSettingsMigrationEnvironment(pathToFileURL(directory + '/'))
      if (['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database)) expect((await result).MYSQL_DATABASE).toBe(database)
      else await expect(result).rejects.toThrow('environment_database')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
it('keeps exact date and integer representations and rejects an arbitrary socket', () => {
  expect(settingsMigrationConnectionOptions({ MYSQL_DATABASE: 'dev_vue', MYSQL_SOCKET: '/tmp/mysql.sock' }))
    .toMatchObject({ database: 'dev_vue', dateStrings: true, timezone: 'Z', bigNumberStrings: true, socketPath: '/tmp/mysql.sock' })
  expect(() => settingsMigrationConnectionOptions({ MYSQL_SOCKET: '/other' })).toThrow('environment_socket')
})
