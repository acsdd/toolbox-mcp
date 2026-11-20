import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'
import { appVersion } from '../dist/version.js'
import { remoteClientInfo } from '../dist/remote.js'

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }

it('reports the package version as the app version', () => {
  assert.equal(appVersion(), manifest.version)
})

it('identifies remote-server connections with the running app version', () => {
  assert.deepEqual(remoteClientInfo(), { name: 'toolbox-mcp', version: appVersion() })
})
