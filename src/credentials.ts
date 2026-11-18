import { AsyncEntry } from '@napi-rs/keyring'

const SERVICE = 'toolbox-mcp/gmail'

export interface CredentialStore {
  set(ref: string, password: string): Promise<void>
  get(ref: string): Promise<string | null>
  delete(ref: string): Promise<void>
}

/** Native Windows Credential Manager / macOS Keychain / Linux Secret Service. */
export function createNativeCredentialStore(): CredentialStore {
  function entry(ref: string): AsyncEntry {
    const options = process.platform === 'linux'
      ? { linux: { store: 'secret-service' as const } }
      : undefined
    return new AsyncEntry(SERVICE, ref, options)
  }

  return {
    async set(ref, password) {
      await entry(ref).setPassword(password)
    },
    async get(ref) {
      return entry(ref).getPassword()
    },
    async delete(ref) {
      await entry(ref).deletePassword()
    }
  }
}
