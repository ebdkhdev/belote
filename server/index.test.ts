import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.QUEUE_FILL_MS = '50'
process.env.BOT_DELAY_MS = '1'
process.env.TURN_MS = '60000'
const { startServer } = await import('./index.ts')

function client(port: number) {
  const ws = new WebSocket(`ws://localhost:${port}`)
  const inbox: any[] = []
  const waiters: [(m: any) => boolean, (m: any) => void][] = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    inbox.push(m)
    const i = waiters.findIndex(([ok]) => ok(m))
    if (i >= 0) waiters.splice(i, 1)[0][1](m)
  }
  return {
    ws,
    open: new Promise((r) => (ws.onopen = r)),
    send: (m: object) => ws.send(JSON.stringify(m)),
    next: (ok: (m: any) => boolean) => {
      const hit = inbox.find(ok)
      return hit ? Promise.resolve(hit) : new Promise<any>((r) => waiters.push([ok, r]))
    },
  }
}

test('queue fills with bots, hides other hands, accepts a legal move, survives a reconnect', async () => {
  const wss = startServer(0)
  const port = (wss.address() as any).port
  const id = 'test-player-0123456789'
  const myTurn = (m: any) => m.type === 'state' && m.view.turn === m.view.seat && m.view.phase !== 'gameOver'

  const a = client(port)
  await a.open
  a.send({ type: 'hello', id, name: 'Ana' })
  await a.next((m) => m.type === 'lobby')
  a.send({ type: 'queue' })
  const first = await a.next((m) => m.type === 'state')
  assert.deepEqual(first.players, ['Ana', 'Bot', 'Bot', 'Bot'])
  assert.equal(first.view.hand.length, 8)
  assert.equal(first.view.hands, undefined) // other players' cards never leave the server

  const turn = await a.next(myTurn)
  const action = turn.view.phase === 'bidding' ? { type: 'pass' } : { type: 'play', card: turn.view.legalCards[0] }
  a.send({ type: 'action', action })
  await a.next((m) => m.type === 'state' && m !== turn && m.view.turn !== m.view.seat)

  a.ws.close()
  const b = client(port)
  await b.open
  b.send({ type: 'hello', id, name: 'Ana' })
  const back = await b.next((m) => m.type === 'state')
  assert.equal(back.view.seat, turn.view.seat)
  b.ws.close()
  wss.close()
  process.exit(0) // room timers would keep the process alive
})
