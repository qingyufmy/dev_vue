import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const appsRoot = join(frontendRoot, 'apps')
const sourceExtensions = new Set(['.ts', '.tsx', '.vue', '.js', '.mjs'])
const forbiddenUiLibraries = ['element-plus', 'ant-design-vue', '@arco-design/web-vue', 'tdesign-vue-next', 'primevue']
const findings = []

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (['dist', '.nuxt', '.output', 'node_modules'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }

  return files
}

const apps = (await readdir(appsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

for (const app of apps) {
  const appRoot = join(appsRoot, app)
  const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }

  for (const library of forbiddenUiLibraries) {
    if (library in dependencies) findings.push(`${app}/package.json 引入了第二套 UI 库 ${library}`)
  }

  for (const file of await walk(appRoot)) {
    if (!sourceExtensions.has(extname(file)) || file.includes(`${sep}tests${sep}`)) continue
    const source = await readFile(file, 'utf8')
    const shownPath = relative(frontendRoot, file)

    for (const otherApp of apps.filter((candidate) => candidate !== app)) {
      const crossAppPatterns = [
        `apps/${otherApp}`,
        `apps\\${otherApp}`,
        `@aurum/${otherApp}/`,
      ]
      if (crossAppPatterns.some((pattern) => source.includes(pattern))) {
        findings.push(`${shownPath} 越界导入 ${otherApp}`)
      }
    }

    if (/\bnew\s+WebSocket\s*\(/.test(source)) findings.push(`${shownPath} 直接创建 WebSocket`)
    if (/\bfetch\s*\(/.test(source)) findings.push(`${shownPath} 在应用层直接调用 fetch`)
  }
}

const componentManifests = (await walk(frontendRoot)).filter((file) => file.endsWith('components.json'))
if (componentManifests.length !== 1 || !componentManifests[0]?.includes(`${sep}packages${sep}ui${sep}`)) {
  findings.push(`components.json 必须且只能位于 packages/ui，当前数量 ${componentManifests.length}`)
}

if (findings.length > 0) {
  console.error(findings.map((finding) => `- ${finding}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`前端边界验证通过：${apps.join('、')} 应用隔离，auth 仅承担身份中心，shadcn-vue 为唯一通用组件源。`)
}
