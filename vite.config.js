import { defineConfig } from 'vite'

/** Relative paths so index.html + assets work from a zip / iframe without site-root URLs. */
export default defineConfig({
  base: './',
})
