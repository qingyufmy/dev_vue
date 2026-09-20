import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('runtime generator accepts 201/202 JSON success without inventing a 200 response, and rejects error-only contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aurum-runtime-status-'))
  try {
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'contracts/http'), { recursive: true })
    await writeFile(join(root, 'scripts/generate-api-runtime.mjs'), await readFile(new URL('../scripts/generate-api-runtime.mjs', import.meta.url)))
    await writeFile(join(root, 'contracts/http/runtime.json'), JSON.stringify({ operations: ['createExample'] }))
    for (const status of ['201', '202', '400']) {
      await writeFile(join(root, 'contracts/openapi-v4.json'), JSON.stringify({ paths: { '/example': { post: {
        operationId: 'createExample', responses: { [status]: { content: { 'application/json': { schema: { type: 'object' } } } } },
      } } } }))
      const result = spawnSync(process.execPath, [join(root, 'scripts/generate-api-runtime.mjs')], { encoding: 'utf8' })
      if (status === '400') {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /runtime_response_schema_required/)
      } else {
        assert.equal(result.status, 0, result.stderr)
        const generated = await readFile(join(root, 'server/src/transport/generated/http-contracts.ts'), 'utf8')
        assert.ok(generated.includes(`"${status}"`))
        assert.ok(!generated.includes('"200"'))
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
