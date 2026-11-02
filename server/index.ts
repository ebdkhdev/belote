// Game server: matchmaking queue, rooms of 4, bots for empty or idle seats. One process holds all rooms.
// shortcut: in-memory rooms and queue, single process; move to a shared store when running more than one instance.
import { WebSocketServer, type WebSocket } from 'ws'
import { apply, botAction, newGame, viewFor, type Action, type Game, type Seat } from '@belote/engine'

export const QUEUE_FILL_MS = Number(process.env.QUEUE_FILL_MS ?? 15000) // then bots fill the empty seats
export const TURN_MS = Number(process.env.TURN_MS ?? 30000) // then a bot plays for the idle player
export const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS ?? 700)

interface Player { id: string; name: string; ws: WebSocket | null }
interface Room { game: Game; seats: (Player | null)[]; timer?: NodeJS.Timeout }

const queue: Player[] = []
let queueTimer: NodeJS.Timeout | undefined
const roomOf = new Map<string, Room>() // player id -> room

const send = (ws: WebSocket | null, msg: object) => ws?.readyState === 1 && ws.send(JSON.stringify(msg))

function broadcast(room: Room) {
  const players = room.seats.map((p) => (p ? p.name : 'Bot'))
  room.seats.forEach((p, seat) => p && send(p.ws, { type: 'state', view: viewFor(room.game, seat as Seat), players }))
}

function schedule(room: Room) {
  clearTimeout(room.timer)
  const g = room.game
  if (g.phase === 'gameOver') {
    room.timer = setTimeout(() => room.seats.forEach((p) => p && roomOf.get(p.id) === room && roomOf.delete(p.id)), 60000)
    return
  }
  const p = room.seats[g.turn]
  const isBot = !p || !p.ws
  room.timer = setTimeout(() => act(room, g.turn, botAction(g, g.turn)), isBot ? BOT_DELAY_MS : TURN_MS)
}

function act(room: Room, seat: Seat, action: Action) {
  room.game = apply(room.game, seat, action)
  broadcast(room)
  schedule(room)
}

function startRoom(players: Player[]) {
  const room: Room = { game: newGame(), seats: [0, 1, 2, 3].map((i) => players[i] ?? null) }
  for (const p of players) roomOf.set(p.id, room)
  broadcast(room)
  schedule(room)
}

function joinQueue(p: Player) {
  if (queue.some((q) => q.id === p.id)) return
  queue.push(p)
  send(p.ws, { type: 'queued', waiting: queue.length })
  if (queue.length >= 4) {
    clearTimeout(queueTimer)
    queueTimer = undefined
    startRoom(queue.splice(0, 4))
  } else if (!queueTimer) {
    queueTimer = setTimeout(() => {
      queueTimer = undefined
      if (queue.length) startRoom(queue.splice(0, 4))
    }, QUEUE_FILL_MS)
  }
}

function onMessage(ws: WebSocket, state: { player?: Player }, raw: string) {
  let msg: any
  try { msg = JSON.parse(raw) } catch { return send(ws, { type: 'error', message: 'bad json' }) }

  if (msg.type === 'hello') {
    // shortcut: the client-chosen id is a bearer secret; replace with a verified account id once auth lands.
    if (typeof msg.id !== 'string' || msg.id.length < 16) return send(ws, { type: 'error', message: 'bad id' })
    const name = String(msg.name ?? 'Player').slice(0, 20)
    const room = roomOf.get(msg.id)
    const seated = room?.seats.find((p) => p?.id === msg.id)
    const player = seated ?? queue.find((q) => q.id === msg.id) ?? { id: msg.id, name, ws }
    if (player.ws !== ws) player.ws?.close() // a newer connection replaces the old one
    player.ws = ws
    state.player = player
    if (room) { broadcast(room); schedule(room) } else send(ws, { type: 'lobby' })
    return
  }
  const player = state.player
  if (!player) return send(ws, { type: 'error', message: 'say hello first' })

  if (msg.type === 'queue') return joinQueue(player)
  if (msg.type === 'action') {
    const room = roomOf.get(player.id)
    const seat = room?.seats.indexOf(player) as Seat
    if (!room) return send(ws, { type: 'error', message: 'not in a game' })
    try { act(room, seat, msg.action) } catch (e) { send(ws, { type: 'error', message: (e as Error).message }) }
    return
  }
  if (msg.type === 'leave') {
    const room = roomOf.get(player.id)
    if (room?.game.phase === 'gameOver') roomOf.delete(player.id)
    return send(ws, { type: 'lobby' })
  }
}

function onClose(ws: WebSocket, state: { player?: Player }) {
  const p = state.player
  if (!p || p.ws !== ws) return
  p.ws = null
  const qi = queue.indexOf(p)
  if (qi >= 0) queue.splice(qi, 1)
  const room = roomOf.get(p.id)
  if (room) schedule(room) // a bot covers the seat until the player reconnects
}

export function startServer(port: number) {
  const wss = new WebSocketServer({ port, maxPayload: 4096 })
  wss.on('connection', (ws) => {
    const state: { player?: Player } = {}
    ws.on('message', (data) => onMessage(ws, state, data.toString()))
    ws.on('close', () => onClose(ws, state))
  })
  return wss
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080)
  startServer(port)
  console.log(`belote server on ws://localhost:${port}`)
}
