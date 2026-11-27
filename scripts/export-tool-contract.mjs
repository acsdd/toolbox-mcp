import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildToolContract } from '../dist/tool-contract.js'
import { appVersion } from '../dist/version.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/tool-contract.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(buildToolContract(appVersion()), null, 2)}\n`)
console.log(`TOOL_CONTRACT=${output}`)
