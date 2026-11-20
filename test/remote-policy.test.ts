import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertRemoteEndpointAllowed, isPublicAddress, RemoteEndpointError } from '../dist/remote.js'

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }]

describe('remote endpoint policy', () => {
  it('accepts a public https endpoint after resolving to a public address', async () => {
    const url = await assertRemoteEndpointAllowed('https://mcp.example.com/mcp', { resolve: publicDns })
    assert.equal(url.hostname, 'mcp.example.com')
  })

  it('accepts a public literal IP', async () => {
    const url = await assertRemoteEndpointAllowed('https://93.184.216.34/mcp')
    assert.equal(url.hostname, '93.184.216.34')
  })

  it('refuses plain http and non-web schemes', async () => {
    for (const endpoint of ['http://mcp.example.com/mcp', 'ftp://mcp.example.com/mcp', 'file:///etc/passwd', 'not a url']) {
      await assert.rejects(() => assertRemoteEndpointAllowed(endpoint, { resolve: publicDns }), RemoteEndpointError)
    }
  })

  it('refuses localhost names without asking DNS', async () => {
    let asked = false
    const resolve = async () => {
      asked = true
      return publicDns()
    }
    for (const endpoint of ['https://localhost/mcp', 'https://LOCALHOST:8443/mcp', 'https://app.localhost/mcp', 'https://printer.local/mcp', 'https://db.internal/mcp']) {
      await assert.rejects(() => assertRemoteEndpointAllowed(endpoint, { resolve }), RemoteEndpointError)
    }
    assert.equal(asked, false)
  })

  it('refuses loopback, private, link-local, CGNAT and reserved literal addresses', async () => {
    for (const host of [
      '127.0.0.1', '127.10.20.30', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '[::1]', '[::]', '[fe80::1]', '[fd00::1]', '[fc00::1]', '[::ffff:127.0.0.1]', '[64:ff9b::7f00:1]', '[ff02::1]'
    ]) {
      await assert.rejects(() => assertRemoteEndpointAllowed(`https://${host}/mcp`), RemoteEndpointError, host)
    }
  })

  it('refuses a public name that resolves into a private network', async () => {
    const resolve = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 }
    ]
    await assert.rejects(
      () => assertRemoteEndpointAllowed('https://rebind.example.com/mcp', { resolve }),
      /10\.0\.0\.7, a private or reserved address/
    )
  })

  it('refuses a name that resolves only to IPv6 loopback or ULA', async () => {
    for (const address of ['::1', 'fd12:3456::1', 'fe80::abcd']) {
      const resolve = async () => [{ address, family: 6 }]
      await assert.rejects(() => assertRemoteEndpointAllowed('https://v6.example.com/mcp', { resolve }), RemoteEndpointError, address)
    }
  })

  it('reports resolution failure and empty answers', async () => {
    await assert.rejects(
      () => assertRemoteEndpointAllowed('https://nx.example.com/mcp', { resolve: async () => { throw new Error('ENOTFOUND') } }),
      /Could not resolve "nx\.example\.com"/
    )
    await assert.rejects(
      () => assertRemoteEndpointAllowed('https://empty.example.com/mcp', { resolve: async () => [] }),
      /did not resolve/
    )
  })

  it('refuses endpoints carrying credentials', async () => {
    await assert.rejects(
      () => assertRemoteEndpointAllowed('https://user:secret@mcp.example.com/mcp', { resolve: publicDns }),
      /credentials/
    )
  })

  it('classifies addresses', () => {
    assert.equal(isPublicAddress('93.184.216.34'), true)
    assert.equal(isPublicAddress('8.8.8.8'), true)
    assert.equal(isPublicAddress('2001:4860:4860::8888'), true)
    assert.equal(isPublicAddress('127.0.0.1'), false)
    assert.equal(isPublicAddress('::1'), false)
    assert.equal(isPublicAddress('not-an-ip'), false)
  })
})
