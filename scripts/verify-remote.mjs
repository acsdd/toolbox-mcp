/* End-to-end check: spawn toolbox-mcp over stdio, confirm restored remote
 * tools are listed, and call one tool per remote server through the proxy. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: root,
  env: { ...process.env, TOOLBOX_MCP_PORT: '3854' },
  stderr: 'pipe'
})
const client = new Client({ name: 'e2e-check', version: '0.0.0' })
await client.connect(transport)

// Restore runs after the server accepts connections — wait for both remotes.
let status
for (let attempt = 0; attempt < 60; attempt++) {
  status = await client.callTool({ name: 'remote_status', arguments: {} })
  if (JSON.parse(status.content[0].text).length >= 2) break
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

const { tools } = await client.listTools()
const remote = tools.filter((t) => t.name.startsWith('cve_now_') || t.name.startsWith('liquidvision_'))
console.log('total tools:', tools.length, '| proxied remote tools:', remote.length)

console.log('remote_status:', status.content[0].text)

const feed = await client.callTool({ name: 'cve_now_list_feed', arguments: { name: 'critical' } })
const feedText = feed.content?.[0]?.text ?? ''
console.log('cve_now_list_feed →', feedText.slice(0, 220).replace(/\n/g, ' '))

const funding = await client.callTool({ name: 'liquidvision_get_funding_rates', arguments: { symbol: 'BTC' } })
const fundingText = funding.content?.[0]?.text ?? ''
console.log('liquidvision_get_funding_rates →', fundingText.slice(0, 220).replace(/\n/g, ' '))

await client.close()
process.exit(0)
