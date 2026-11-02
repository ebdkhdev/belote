import { useEffect, useRef, useState } from 'react'
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import Constants from 'expo-constants'
import { randomUUID } from 'expo-crypto'
import { getItem, setItem } from 'expo-secure-store'
import { rankOf, suitOf, SUITS, type Action, type BidValue, type Card, type Seat, type Suit, type View as GameView } from '@belote/engine'

// In dev, the game server runs on the same machine as the Expo dev server.
const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ?? `ws://${(Constants.expoConfig?.hostUri ?? 'localhost').split(':')[0]}:8080`
// shortcut: identity is per device and lost on uninstall; add accounts if players need it across phones.
const PLAYER_ID = getItem('playerId') ?? randomUUID()
setItem('playerId', PLAYER_ID)

const SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' }
const isRed = (s: Suit) => s === 'H' || s === 'D'
const bidLabel = (v: BidValue) => (v === 'capot' ? 'Capot' : String(v))

type Screen = { kind: 'connecting' } | { kind: 'lobby'; waiting?: number } | { kind: 'game'; view: GameView; players: string[] }

function useServer(name: string) {
  const [screen, setScreen] = useState<Screen>({ kind: 'connecting' })
  const [error, setError] = useState('')
  const ws = useRef<WebSocket | null>(null)
  const nameRef = useRef(name)
  nameRef.current = name

  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout>
    const connect = () => {
      const sock = new WebSocket(SERVER_URL)
      ws.current = sock
      sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', id: PLAYER_ID, name: nameRef.current }))
      sock.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.type === 'lobby') setScreen({ kind: 'lobby' })
        else if (m.type === 'queued') setScreen({ kind: 'lobby', waiting: m.waiting })
        else if (m.type === 'state') { setScreen({ kind: 'game', view: m.view, players: m.players }); setError('') }
        else if (m.type === 'error') setError(m.message)
      }
      sock.onclose = () => {
        if (closed) return
        setScreen({ kind: 'connecting' })
        retry = setTimeout(connect, 1500) // the server keeps our seat; hello puts us back in it
      }
    }
    connect()
    return () => { closed = true; clearTimeout(retry); ws.current?.close() }
  }, [])

  const send = (m: object) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m))
  return { screen, error, send }
}

export default function App() {
  const [name, setName] = useState('Player')
  const { screen, error, send } = useServer(name)

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      {screen.kind === 'connecting' && <Text style={s.title}>Connecting…</Text>}
      {screen.kind === 'lobby' && (
        <View style={s.center}>
          <Text style={s.title}>Belote</Text>
          <TextInput style={s.input} value={name} onChangeText={setName} maxLength={20} accessibilityLabel="Your name" />
          {screen.waiting ? (
            <Text style={s.text}>Looking for players… ({screen.waiting}/4). Bots join after 15 s.</Text>
          ) : (
            <Btn label="Find a game" onPress={() => { send({ type: 'hello', id: PLAYER_ID, name }); send({ type: 'queue' }) }} />
          )}
        </View>
      )}
      {screen.kind === 'game' && (
        <Table view={screen.view} players={screen.players} act={(action) => send({ type: 'action', action })} leave={() => send({ type: 'leave' })} />
      )}
      {!!error && <Text style={s.error}>{error}</Text>}
    </SafeAreaView>
  )
}

function Table({ view, players, act, leave }: { view: GameView; players: string[]; act: (a: Action) => void; leave: () => void }) {
  const me = view.seat
  const at = (offset: number) => ((me + offset) % 4) as Seat
  const myTeam = me % 2
  const trickCard = (seat: Seat) => view.trick.find((p) => p.seat === seat)?.card
  const c = view.contract

  const Opponent = ({ seat }: { seat: Seat }) => (
    <View style={s.player}>
      <Text style={[s.text, view.turn === seat && s.turn]}>{players[seat]}</Text>
      <Text style={s.small}>{view.handSizes[seat]} cards</Text>
    </View>
  )

  return (
    <View style={s.table}>
      <View style={s.scoreBar}>
        <Text style={s.text}>Us {view.scores[myTeam]} · Them {view.scores[1 - myTeam]}</Text>
        {c && (
          <Text style={s.text}>
            {players[c.seat]}: {bidLabel(c.value)} {SYMBOL[c.suit]}{c.mult > 1 ? ` ×${c.mult}` : ''}
          </Text>
        )}
      </View>

      <Opponent seat={at(2)} />
      <View style={s.middle}>
        <Opponent seat={at(1)} />
        <View style={s.trick}>
          {[at(2), at(1), at(3), me].map((seat) => {
            const card = trickCard(seat)
            return <View key={seat} style={s.trickSlot}>{card ? <CardView card={card} /> : null}</View>
          })}
        </View>
        <Opponent seat={at(3)} />
      </View>

      {view.lastHand && view.phase === 'bidding' && (
        <Text style={s.small}>
          Last hand: {players[view.lastHand.contract.seat]} {view.lastHand.made ? 'made' : 'failed'} {bidLabel(view.lastHand.contract.value)} — +{view.lastHand.delta[myTeam]} us, +{view.lastHand.delta[1 - myTeam]} them
        </Text>
      )}

      {view.phase === 'gameOver' ? (
        <View style={s.center}>
          <Text style={s.title}>{view.scores[myTeam] > view.scores[1 - myTeam] ? 'You win!' : 'You lose'}</Text>
          <Btn label="Back to lobby" onPress={leave} />
        </View>
      ) : view.phase === 'bidding' && view.turn === me ? (
        <BidPanel bids={view.legalBids} act={act} />
      ) : (
        <Text style={[s.small, s.status]}>{view.turn === me ? 'Your turn' : `Waiting for ${players[view.turn]}…`}</Text>
      )}

      <View style={s.hand}>
        {view.hand.map((card) => {
          const legal = view.legalCards.includes(card)
          return (
            <Pressable key={card} disabled={!legal} onPress={() => act({ type: 'play', card })} accessibilityLabel={`Play ${card}`}>
              <CardView card={card} dim={view.phase === 'playing' && view.turn === me && !legal} />
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

function BidPanel({ bids, act }: { bids: Action[]; act: (a: Action) => void }) {
  const [suit, setSuit] = useState<Suit>('H')
  const values = [...new Set(bids.flatMap((b) => (b.type === 'bid' ? [b.value] : [])))]
  const [index, setIndex] = useState(0)
  const value = values[Math.min(index, values.length - 1)]
  const has = (type: Action['type']) => bids.some((b) => b.type === type)

  return (
    <View style={s.bidPanel}>
      {values.length > 0 && (
        <>
          <View style={s.row}>
            {SUITS.map((x) => (
              <Pressable key={x} onPress={() => setSuit(x)} style={[s.suitBtn, suit === x && s.selected]} accessibilityLabel={`Trump ${x}`}>
                <Text style={[s.suit, isRed(x) && s.red]}>{SYMBOL[x]}</Text>
              </Pressable>
            ))}
          </View>
          <View style={s.row}>
            <Btn label="−" onPress={() => setIndex(Math.max(0, index - 1))} />
            <Text style={s.title}>{bidLabel(value)}</Text>
            <Btn label="+" onPress={() => setIndex(Math.min(values.length - 1, index + 1))} />
            <Btn label="Bid" onPress={() => act({ type: 'bid', value, suit })} />
          </View>
        </>
      )}
      <View style={s.row}>
        <Btn label="Pass" onPress={() => act({ type: 'pass' })} />
        {has('coinche') && <Btn label="Coinche" onPress={() => act({ type: 'coinche' })} />}
        {has('surcoinche') && <Btn label="Surcoinche" onPress={() => act({ type: 'surcoinche' })} />}
      </View>
    </View>
  )
}

function CardView({ card, dim }: { card: Card; dim?: boolean }) {
  const suit = suitOf(card)
  return (
    <View style={[s.card, dim && s.dim]}>
      <Text style={[s.cardText, isRed(suit) && s.red]}>{rankOf(card)}</Text>
      <Text style={[s.cardText, isRed(suit) && s.red]}>{SYMBOL[suit]}</Text>
    </View>
  )
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.btn, pressed && s.selected]} accessibilityRole="button">
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f5132' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', textAlign: 'center', marginHorizontal: 8 },
  text: { color: '#fff', fontSize: 16 },
  small: { color: '#d1e7dd', fontSize: 13, textAlign: 'center' },
  error: { color: '#ffb4b4', textAlign: 'center', padding: 8 },
  input: { backgroundColor: '#fff', borderRadius: 8, padding: 12, width: 220, fontSize: 16 },
  table: { flex: 1, padding: 12, gap: 8 },
  scoreBar: { flexDirection: 'row', justifyContent: 'space-between' },
  player: { alignItems: 'center', padding: 8 },
  turn: { color: '#ffd43b', fontWeight: '700' },
  middle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  trick: { width: 150, height: 170, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' },
  trickSlot: { width: 70, height: 80, alignItems: 'center', justifyContent: 'center' },
  status: { padding: 12 },
  bidPanel: { gap: 8, alignItems: 'center' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  suitBtn: { width: 48, height: 48, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  suit: { fontSize: 26, color: '#000' },
  selected: { opacity: 0.6 },
  btn: { backgroundColor: '#ffd43b', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, minWidth: 44, alignItems: 'center' },
  btnText: { fontSize: 16, fontWeight: '700', color: '#212529' },
  hand: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4, paddingBottom: 8 },
  card: { width: 40, height: 60, backgroundColor: '#fff', borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  cardText: { fontSize: 15, fontWeight: '700', color: '#000' },
  red: { color: '#c92a2a' },
  dim: { opacity: 0.35 },
})
