import { writeFileSync } from 'node:fs'
const OUT = process.argv[2]
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (m, p = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, x => x.error ? rej(new Error(x.error.message)) : res(x.result)); ws.send(JSON.stringify({ id: n, method: m, params: p })) })
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('EXC '+r.exceptionDetails.text); return r.result.value }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shot = async n => { const { data } = await send('Page.captureScreenshot', { format:'png' }); writeFileSync(`${OUT}/${n}.png`, Buffer.from(data,'base64')) }
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:8080/login' }); await sleep(5000)
if (await ev(`location.pathname === '/login'`)) {
  await ev(`(() => { const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
    const ins=[...document.querySelectorAll('input')]; set(ins[0],'admin@kubuno.local'); set(ins.find(i=>i.type==='password'),'Ethan#@]1024'); return true })()`)
  await sleep(400); await ev(`[...document.querySelectorAll('button')].find(b=>b.type==='submit')?.click()`); await sleep(6000)
}
await send('Page.navigate', { url: 'http://localhost:8080/calendar' }); await sleep(11000)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 })
await sleep(3500)
console.log(await ev(`(() => {
  const win = document.querySelector('[role=dialog]')
  const content = win?.querySelector('.kb-window-content')
  const hex = c => { const m = c.match(/\\d+/g); return m ? '#' + m.slice(0,3).map(n => (+n).toString(16).padStart(2,'0')).join('').toUpperCase() : c }
  const field = document.querySelector('.kb-window-content input[placeholder*="lieu"]')
  return JSON.stringify({
    classe: win?.className.includes('kb-window-form-canvas'),
    fondFormulaire: hex(getComputedStyle(content).backgroundColor),
    fondChamp: field && hex(getComputedStyle(field).backgroundColor),
    bandeau: hex(getComputedStyle(document.querySelector('.kb-window-titlebar')).backgroundColor),
  })
})()`))
await shot('T1-teinte')
ws.close()
