/* SHA-256 checksums for release artifacts.
 * Used by pack-portable.mjs so every build ships a sha256sum-compatible
 * SHA256SUMS.txt next to the executables instead of a hand-run command.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** Writes `<outputDir>/SHA256SUMS.txt`; returns the file path. */
export async function writeChecksums(paths, outputDir) {
  const lines = []
  for (const path of paths) {
    lines.push(`${await sha256File(path)}  ${basename(path)}`)
  }
  const target = join(outputDir, 'SHA256SUMS.txt')
  await writeFile(target, `${lines.join('\n')}\n`, 'utf8')
  return target
}
