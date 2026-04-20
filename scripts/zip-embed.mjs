import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import archiver from 'archiver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const dist = path.join(root, 'dist')
const out = path.join(root, 'embed.zip')

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html not found. Run `npm run build` first.')
  process.exit(1)
}

const output = fs.createWriteStream(out)
const archive = archiver('zip', { zlib: { level: 9 } })

archive.on('warning', (err) => {
  if (err.code !== 'ENOENT') throw err
})

archive.on('error', (err) => {
  throw err
})

output.on('close', () => {
  console.log(`embed.zip ready (${archive.pointer()} bytes) — index.html at zip root`)
})

archive.pipe(output)
archive.directory(dist, false)
archive.finalize()
