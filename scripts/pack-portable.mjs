/* Local portable build using the sibling desktop app's installed Electron tools.
 * Usage: node scripts/pack-portable.mjs [desktop-toolchain-directory] [output-directory]
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toolchain = resolve(process.argv[2] ?? join(root, '../toolbox-desktop'))
const output = resolve(process.argv[3] ?? join(root, 'dist'))
const widgets = await realpath(join(root, 'node_modules/@toolbox/widgets'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const widgetManifest = JSON.parse(await readFile(join(widgets, 'package.json'), 'utf8'))
const electron = JSON.parse(await readFile(join(toolchain, 'node_modules/electron/package.json'), 'utf8'))

function run(script, args, cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${script} exited with code ${result.status}`)
}

run(join(root, 'node_modules/typescript/bin/tsc'), ['-p', join(widgets, 'tsconfig.json')], widgets)
run(join(root, 'node_modules/typescript/bin/tsc'), ['-p', join(root, 'tsconfig.json')])

// Stage outside the workspace to avoid editor locks on Electron/ASAR files.
const stage = await mkdtemp(join(tmpdir(), 'modelfarm-portable-'))
const appDir = join(stage, 'app')
const buildDir = join(stage, 'release')
await mkdir(join(appDir, 'scripts'), { recursive: true })
await cp(join(root, 'dist'), join(appDir, 'dist'), {
  recursive: true,
  filter: (path) => {
    const rel = relative(join(root, 'dist'), path)
    // Never ship runtime data (the Electron profile) inside the bundle.
    if (rel === 'ModelFarm-data' || rel.startsWith(`ModelFarm-data${sep}`)) return false
    return !/\.(exe|map|ts)$/.test(path)
  }
})
await copyFile(join(root, 'scripts/desktop.cjs'), join(appDir, 'scripts/desktop.cjs'))

async function copyModules(source, destination, excludeWidgets = false) {
  const excluded = new Set(['.bin', '.package-lock.json', '@types', 'typescript', 'undici-types'])
  if (excludeWidgets) excluded.add('@toolbox')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => !excluded.has(relative(source, path).split(sep)[0])
  })
}

await copyModules(join(root, 'node_modules'), join(appDir, 'node_modules'), true)
const packagedWidgets = join(appDir, 'node_modules/@toolbox/widgets')
await mkdir(packagedWidgets, { recursive: true })
// Never follow the workspace link wholesale: only ship the widget runtime.
for (const entry of ['dist', 'package.json', 'LICENSE']) {
  await cp(join(widgets, entry), join(packagedWidgets, entry), { recursive: true })
}
await copyModules(join(widgets, 'node_modules'), join(packagedWidgets, 'node_modules'))

await writeFile(join(appDir, 'package.json'), JSON.stringify({
  name: 'toolbox-model-farm',
  productName: 'Model Farm',
  version: manifest.version,
  description: 'Portable Model Farm and Toolbox ops panel',
  author: 'Alpha Team',
  license: manifest.license,
  private: true,
  type: 'module',
  main: 'scripts/desktop.cjs',
  dependencies: { ...manifest.dependencies, '@toolbox/widgets': widgetManifest.version },
  build: {
    appId: 'com.alpha.toolbox.modelfarm',
    productName: 'Model Farm',
    electronVersion: electron.version,
    electronDist: join(toolchain, 'node_modules/electron/dist'),
    npmRebuild: false,
    asar: true,
    compression: 'maximum',
    directories: { output: buildDir },
    files: ['dist/**/*.js', 'scripts/desktop.cjs', 'package.json'],
    win: { icon: join(toolchain, 'build/icon.png'), target: [{ target: 'portable', arch: ['x64'] }] },
    portable: { artifactName: 'ModelFarm-Portable-${version}.${ext}' }
  }
}, null, 2))

console.log(`PACKAGE_STAGE=${stage}`)
run(join(toolchain, 'node_modules/electron-builder/cli.js'), [
  '--projectDir', appDir, '--win', 'portable', '--x64', '--publish', 'never'
], appDir)

await mkdir(output, { recursive: true })
const artifactName = `ModelFarm-Portable-${manifest.version}.exe`
const artifactPath = join(output, artifactName)
// A rebuild of the same version replaces the previous artifact.
await rm(artifactPath, { force: true })
await copyFile(join(buildDir, artifactName), artifactPath)
console.log(`PORTABLE_EXE=${join(output, artifactName)}`)
console.log(`UNPACKED_APP=${join(buildDir, 'win-unpacked')}`)
