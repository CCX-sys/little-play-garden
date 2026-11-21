// Run against portable release artifacts; no project source or tests are required.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, webkit } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const release = path.resolve(process.env.GAME_DIST || path.join(root, 'dist'))
const offline = path.join(root, '交付与试玩', '离线版')
const html = path.resolve(process.env.GAME_HTML || path.join(offline, '小小探险岛.html'))
const book = path.resolve(process.env.GAME_EPUB || path.join(offline, '小小探险岛.epub'))
const output = path.resolve(process.env.QA_REPORT || path.join(root, 'evidence/apple-offline.json'))
const engine = process.env.FALLBACK_ENGINE === 'chromium' ? chromium : webkit
const setup = { viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 }
const tempParent = await fs.realpath(os.tmpdir())
const temp = await fs.mkdtemp(path.join(tempParent, 'garden-offline-qa-'))
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')

async function serve() {
  const prefix = '/garden/'
  const mime = { '.html':'text/html', '.js':'application/javascript', '.svg':'image/svg+xml',
    '.css':'text/css', '.png':'image/png', '.webp':'image/webp', '.mp3':'audio/mpeg',
    '.json':'application/json', '.webmanifest':'application/manifest+json' }
  const server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      if (!name.startsWith(prefix)) throw Error('Wrong site')
      const target = path.resolve(release, name.slice(prefix.length) || 'index.html')
      if (!target.startsWith(release + path.sep)) throw Error('Wrong path')
      res.writeHead(200, {'Content-Type':mime[path.extname(target)],'Cache-Control':'no-store'})
      res.end(await fs.readFile(target))
    } catch {
      if (!res.headersSent) res.writeHead(404)
      res.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url:'http://127.0.0.1:' + server.address().port + prefix,
    stop:() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

async function monitor(context) {
  await context.addInitScript(() => {
    window.qaAudioCompletions = []
    // A natural ended event and non-zero media clock are independent of the UI success label.
    const watched = new WeakSet()
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function(...args) {
      if (!watched.has(this)) {
        watched.add(this)
        this.addEventListener('ended', () => {
          if (this.currentTime > 0 && Number.isFinite(this.duration)) {
            window.qaAudioCompletions.push({backend:'HTMLMediaElement', seconds:this.currentTime})
          }
        })
      }
      return play.apply(this, args)
    }
    if (window.AudioBufferSourceNode) {
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function(...args) {
        const time = this.context.currentTime
        this.addEventListener('ended', () => {
          const elapsed = this.context.currentTime - time
          if (this.buffer && elapsed >= this.buffer.duration * .9 && this.context.state === 'running') {
            window.qaAudioCompletions.push({backend:'AudioBufferSourceNode', seconds:elapsed})
          }
        }, {once:true})
        return start.apply(this, args)
      }
    }
  })
}

async function hear(page, file) {
  const clip = page.locator('[data-audio-play="' + file + '"]').first()
  await clip.waitFor()
  await page.waitForFunction(file => document.querySelector('[data-audio-play="'+file+'"]')?.getAttribute('aria-pressed') === 'false', file)
  const start = await page.evaluate(() => window.qaAudioCompletions.length)
  await clip.click()
  await page.waitForFunction(start => window.qaAudioCompletions.length > start, start, {timeout: 10000})
  return {file,...await page.evaluate(() => window.qaAudioCompletions.at(-1))}
}

async function challenge(page, mode) {
  await page.locator('.brand').click()
  await page.locator('[data-game-id="english"]').click()
  await page.locator('main a[href="#/english/' + mode + '"]').first().click()
}

async function exercise(page, url, allowed, networkMode) {
  const outside = [], exceptions = []
  page.on('request', req => {
    const target = req.url()
    if ((/^https?:/.test(target) || target.startsWith('file:')) && !allowed(target)) outside.push(target)
  })
  page.on('pageerror', err => exceptions.push(err.message))
  await page.goto(url)
  await page.locator('[data-game-id="english"]').waitFor()
  const audio = [], complete = []
  for (const mode of ['listen','match','memory','letters','shop']) {
    await challenge(page,mode)
    if (['listen','match','memory'].includes(mode)) {
      await page.getByRole('button',{name:'开始游戏',exact:true}).click()
    }
    if (mode === 'listen') {
      for (let i=0; i<10; i++) {
        const value = await page.locator('[data-answer]').getAttribute('data-answer')
        if (i===0) audio.push(await hear(page,'/assets/english/audio/words/' + value + '.mp3'))
        await page.locator('[data-word-id="' + value + '"]').click()
        await page.getByRole('button',{name:i===9?'完成本轮':'下一题',exact:true}).click()
        if (i < 9) await page.waitForFunction(previous => {
          const board = document.querySelector('[data-answer]')
          return board && board.getAttribute('data-answer') !== previous
        },value)
      }
    } else if (mode === 'match') {
      await page.locator('[data-match-word]').first().waitFor()
      for (const el of await page.locator('[data-match-word]').all()) {
        const value = await el.getAttribute('data-match-word')
        await el.click()
        await page.locator('[data-match-picture="' + value + '"]').click()
      }
    } else if (mode === 'memory') {
      await page.locator('[data-memory-word]').first().waitFor()
      const values = await page.locator('[data-memory-word][data-kind="word"]').evaluateAll(els => els.map(el=>el.dataset.memoryWord))
      assert.equal(values.length,4)
      for (const value of values) {
        const pair = page.locator('[data-memory-word="'+value+'"]')
        await pair.first().click()
        await pair.last().click()
      }
    } else if (mode === 'letters') {
      await page.locator('[data-letter-level="A"]').click()
      for (const value of ['A', 'a']) await page.locator('[data-letter-choice="' + value + '"]').click()
    } else {
      await page.locator('[data-shop-level="shop-15"]').click()
      audio.push(await hear(page,'/assets/english/audio/phrases/shop-15.mp3'))
      await page.locator('[data-product="apple"]').click()
      await page.locator('[data-product="banana"]').click()
    }
    await page.locator('.result').waitFor()
    complete.push(mode)
  }
  assert.deepEqual(outside,[])
  assert.deepEqual(exceptions,[])
  return {complete,audio,networkMode,foreignRequests:outside.length,pageErrors:exceptions}
}

const report = {status:'running',checkedAt:new Date().toISOString(),os:os.platform(),osVersion:os.release(),
  engine:engine.name(),physicalAppleDevice:false,viewport:setup.viewport,runs:{}}
try {
  report.hashes = {html:await digest(html),epub:await digest(book),worker:await digest(path.join(release,'sw.js'))}
  const standaloneDir = path.join(temp,'one file')
  await fs.mkdir(standaloneDir)
  const isolatedHTML = path.join(standaloneDir,'游戏.html')
  await fs.copyFile(html, isolatedHTML)
  const extracted = path.join(temp,'epub')
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  execFileSync(python,['-m','zipfile','-e',book,extracted])
  const chapter = pathToFileURL(path.join(extracted,'OEBPS','game.xhtml')).href
  const localHTML = pathToFileURL(isolatedHTML).href
  const browser = await engine.launch()
  report.browserVersion = browser.version()
  try {
    for (const [key,url,allowed] of [
      ['html',localHTML,target=>target.split('#')[0] === localHTML],
      ['epub',chapter,target=>target.startsWith(pathToFileURL(extracted).href + '/')],
    ]) {
      const context = await browser.newContext({...setup,offline:true})
      try {
        await monitor(context)
        report.runs[key] = await exercise(await context.newPage(),url,allowed,'browser offline; file: document')
        console.log(key,'offline games and audio passed')
      } finally { await context.close() }
    }
  } finally { await browser.close() }

  const site = await serve()
  const profile = path.join(temp,'pwa-profile')
  let context
  try {
    context = await engine.launchPersistentContext(profile,setup)
    const first = await context.newPage()
    await first.goto(site.url+'?install=1')
    await first.waitForFunction(()=>document.querySelector('#offline-status')?.textContent === '可以离线玩了',null,{timeout:120000})
    report.cached = await first.evaluate(async()=> {
      const name = (await caches.keys()).find(key=>key.startsWith('little-play-garden|'))
      const keys = await (await caches.open(name)).keys()
      return {files:keys.length,mp3:keys.filter(k=> k.url.endsWith('.mp3')).length}
    })
    assert.equal(report.cached.mp3,161)
  } finally { await context?.close(); await site.stop() }
  context = await engine.launchPersistentContext(profile,{...setup,offline:true})
  try {
    await monitor(context)
    report.runs.pwa = await exercise(await context.newPage(),site.url,target=>target.startsWith(site.url),
      'browser and HTTP server stopped; same profile reopened offline')
  } finally { await context.close() }
  report.status='passed'
} catch (error) {
  report.status='failed'; report.error=error.message
  throw error
} finally {
  await fs.mkdir(path.dirname(output),{recursive:true})
  await fs.writeFile(output, JSON.stringify(report,null,2)+'\n')
  const actual = await fs.realpath(temp)
  assert.equal(path.dirname(actual), tempParent)
  assert(path.basename(actual).startsWith('garden-offline-qa-'))
  await fs.rm(actual,{recursive:true,force:true,maxRetries:3})
}
