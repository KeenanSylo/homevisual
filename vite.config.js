import { defineConfig } from 'vite'
import { resolve } from 'path'
import { spawn } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'

// dev only: POST /__bake { id, items, hour } runs dev/bake.sh (headless export + Blender bake) for the
// layout you have on screen; GET /__bake reports progress. The app reloads the lightmap when it's done.
function bakeServer() {
  let job = null
  const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
  return {
    name: 'hemma-bake',
    configureServer(server) {
      server.middlewares.use('/__bake', (req, res) => {
        if (req.method !== 'POST') return json(res, 200, job ? { ...job, log: undefined, elapsed: Math.round((Date.now() - job.started) / 1000) } : { state: 'idle' })
        if (job && job.state === 'running') return json(res, 409, { error: 'a bake is already running' })
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          let p
          try { p = JSON.parse(body) } catch { return json(res, 400, { error: 'bad json' }) }
          if (!/^[\w-]+$/.test(p.id || '') || !Array.isArray(p.items)) return json(res, 400, { error: 'need id and items' })
          const hour = Math.max(0, Math.min(23, Math.round(Number(p.hour) || 15)))
          mkdirSync(resolve(__dirname, 'dev/bake-work'), { recursive: true })
          const file = resolve(__dirname, `dev/bake-work/${p.id}.items.json`)
          writeFileSync(file, JSON.stringify(p.items))
          job = { id: p.id, hour, state: 'running', step: 'exporting', started: Date.now(), log: '' }
          const run = job
          const ch = spawn('sh', ['dev/bake.sh', p.id, '@' + file, String(hour), '1024'], { cwd: __dirname })
          const onData = (d) => {
            run.log += d
            if (/baking \d+ (objects|parts)/.test(d)) run.step = 'baking'
            if (/white balance/.test(d)) run.step = 'denoising'
          }
          ch.stdout.on('data', onData); ch.stderr.on('data', onData)
          ch.on('close', (code) => { run.state = code === 0 ? 'done' : 'error'; run.step = run.state; run.finished = Date.now(); if (code) console.error('[bake] failed\n' + run.log.slice(-2000)) })
          json(res, 202, { state: 'running' })
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [bakeServer()],
  server: { port: 5190, watch: { usePolling: true, interval: 250, ignored: ['**/dev/bake-work/**', '**/bake/**'] } },
  build: {
    target: 'es2022',
    rollupOptions: { input: { home: resolve(__dirname, 'index.html'), app: resolve(__dirname, 'app.html'), editor: resolve(__dirname, 'editor.html') } },
  },
})
