// Tunisian Belote rules engine. Pure functions; the server owns the state, clients only render views.

// --- House rules (confirmed with the user unless marked) ---
export const TARGET_SCORE = 1000
export const CAPOT_POINTS = 500
export const BELOTE_POINTS = 20 // assumed: belote-rebelote still counts
export const MIN_BID = 80
export const MAX_BID = 160
export const BID_STEP = 10
export const PARTNER_WINNING_FREE = true // assumed: no forced trump while partner holds the trick

export type Suit = 'S' | 'H' | 'D' | 'C'
export type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
export type Card = string // rank + suit, e.g. "JH", "10S"
export type Seat = 0 | 1 | 2 | 3
export type Team = 0 | 1
export type BidValue = number | 'capot'

export type Action =
  | { type: 'pass' }
  | { type: 'bid'; value: BidValue; suit: Suit }
  | { type: 'coinche' }
  | { type: 'surcoinche' }
  | { type: 'play'; card: Card }

export interface Contract { seat: Seat; value: BidValue; suit: Suit; mult: 1 | 2 | 4 }

export interface HandResult { contract: Contract; points: [number, number]; made: boolean; delta: [number, number] }

export interface Game {
  phase: 'bidding' | 'playing' | 'gameOver'
  dealer: Seat
  turn: Seat
  hands: Card[][]
  contract: Contract | null
  passes: number // consecutive passes in bidding
  coinchedBy: Seat | null
  trick: { seat: Seat; card: Card }[]
  lastTrick: { seat: Seat; card: Card }[]
  points: [number, number] // card points this hand
  tricks: [number, number]
  beloteTeam: Team | null
  scores: [number, number]
  lastHand: HandResult | null
}

export const SUITS: Suit[] = ['S', 'H', 'D', 'C']
export const RANKS: Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const TRUMP_ORDER: Rank[] = ['7', '8', 'Q', 'K', '10', 'A', '9', 'J']
const PLAIN_ORDER: Rank[] = ['7', '8', '9', 'J', 'Q', 'K', '10', 'A']
const TRUMP_POINTS: Record<Rank, number> = { J: 20, '9': 14, A: 11, '10': 10, K: 4, Q: 3, '8': 0, '7': 0 }
const PLAIN_POINTS: Record<Rank, number> = { A: 11, '10': 10, K: 4, Q: 3, J: 2, '9': 0, '8': 0, '7': 0 }

export const suitOf = (c: Card) => c.slice(-1) as Suit
export const rankOf = (c: Card) => c.slice(0, -1) as Rank
export const teamOf = (s: Seat) => (s % 2) as Team
const next = (s: Seat) => ((s + 1) % 4) as Seat
const bidRank = (v: BidValue) => (v === 'capot' ? MAX_BID + BID_STEP : v)

export const cardPoints = (c: Card, trump: Suit) =>
  suitOf(c) === trump ? TRUMP_POINTS[rankOf(c)] : PLAIN_POINTS[rankOf(c)]

const strength = (c: Card, trump: Suit) =>
  suitOf(c) === trump ? 100 + TRUMP_ORDER.indexOf(rankOf(c)) : PLAIN_ORDER.indexOf(rankOf(c))

function cryptoRandom() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32
}

export function deal(rand = cryptoRandom): Card[][] {
  const deck = SUITS.flatMap((s) => RANKS.map((r) => r + s))
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return [0, 1, 2, 3].map((i) => deck.slice(i * 8, i * 8 + 8))
}

function newHand(scores: [number, number], dealer: Seat, rand: () => number, lastHand: HandResult | null): Game {
  return {
    phase: 'bidding', dealer, turn: next(dealer), hands: deal(rand), contract: null, passes: 0, coinchedBy: null,
    trick: [], lastTrick: [], points: [0, 0], tricks: [0, 0], beloteTeam: null, scores, lastHand,
  }
}

export const newGame = (rand = cryptoRandom) => newHand([0, 0], 3, rand, null)

export function winningPlay(trick: { seat: Seat; card: Card }[], trump: Suit) {
  const led = suitOf(trick[0].card)
  return trick.reduce((best, p) => {
    const s = suitOf(p.card)
    if (s !== led && s !== trump) return best
    return strength(p.card, trump) > strength(best.card, trump) ? p : best
  })
}

export function legalCards(g: Game, seat: Seat): Card[] {
  const hand = g.hands[seat]
  if (g.phase !== 'playing' || g.turn !== seat) return []
  if (g.trick.length === 0) return hand
  const trump = g.contract!.suit
  const led = suitOf(g.trick[0].card)
  const trumps = hand.filter((c) => suitOf(c) === trump)
  const best = winningPlay(g.trick, trump)
  const higherTrumps = (cs: Card[]) => {
    const bar = suitOf(best.card) === trump ? strength(best.card, trump) : -1
    const up = cs.filter((c) => strength(c, trump) > bar)
    return up.length ? up : cs
  }
  if (led === trump) return trumps.length ? higherTrumps(trumps) : hand
  const follow = hand.filter((c) => suitOf(c) === led)
  if (follow.length) return follow
  if (PARTNER_WINNING_FREE && teamOf(best.seat) === teamOf(seat)) return hand
  return trumps.length ? higherTrumps(trumps) : hand
}

export function legalBids(g: Game, seat: Seat): Action[] {
  if (g.phase !== 'bidding' || g.turn !== seat) return []
  const c = g.contract
  const out: Action[] = [{ type: 'pass' }]
  if (c && g.coinchedBy !== null) {
    if (teamOf(seat) === teamOf(c.seat) && c.mult === 2) out.push({ type: 'surcoinche' })
    return out
  }
  const floor = c ? bidRank(c.value) + BID_STEP : MIN_BID
  const values: BidValue[] = []
  for (let v = floor; v <= MAX_BID; v += BID_STEP) values.push(v)
  if (!c || c.value !== 'capot') values.push('capot')
  for (const value of values) for (const suit of SUITS) out.push({ type: 'bid', value, suit })
  if (c && teamOf(seat) !== teamOf(c.seat)) out.push({ type: 'coinche' })
  return out
}

function startPlay(g: Game): Game {
  const trump = g.contract!.suit
  const holder = g.hands.findIndex((h) => h.includes('K' + trump) && h.includes('Q' + trump))
  return { ...g, phase: 'playing', turn: next(g.dealer), beloteTeam: holder < 0 ? null : teamOf(holder as Seat) }
}

export function scoreHand(contract: Contract, points: [number, number], tricks: [number, number], beloteTeam: Team | null): HandResult {
  const bidders = teamOf(contract.seat)
  const defenders = (1 - bidders) as Team
  const withBelote = [...points] as [number, number]
  if (beloteTeam !== null) withBelote[beloteTeam] += BELOTE_POINTS
  const capot = tricks[bidders] === 8
  const made = contract.value === 'capot'
    ? capot
    : withBelote[bidders] >= contract.value && withBelote[bidders] > withBelote[defenders]
  const delta: [number, number] = [0, 0]
  // assumed scoring: made = bid (or 500 on capot) x mult; failed = defenders take 160 + bid (500 for a capot bid) x mult
  if (made) delta[bidders] = (capot ? CAPOT_POINTS : (contract.value as number)) * contract.mult
  else delta[defenders] = (contract.value === 'capot' ? CAPOT_POINTS : 160 + contract.value) * contract.mult
  if (beloteTeam !== null) delta[beloteTeam] += BELOTE_POINTS
  return { contract, points, made, delta }
}

function endHand(g: Game, rand: () => number): Game {
  const result = scoreHand(g.contract!, g.points, g.tricks, g.beloteTeam)
  const scores: [number, number] = [g.scores[0] + result.delta[0], g.scores[1] + result.delta[1]]
  const done = Math.max(...scores) >= TARGET_SCORE && scores[0] !== scores[1]
  if (done) return { ...g, phase: 'gameOver', scores, lastHand: result, trick: [] }
  return { ...newHand(scores, next(g.dealer), rand, result), lastTrick: g.lastTrick }
}

const sameAction = (a: any, b: any) => a.type === b.type && a.value === b.value && a.suit === b.suit

// Returns the new state, or throws on an illegal action. `rand` only matters when a new hand is dealt.
export function apply(g: Game, seat: Seat, a: Action, rand = cryptoRandom): Game {
  if (g.turn !== seat) throw new Error('not your turn')

  if (a.type === 'play') {
    if (!legalCards(g, seat).includes(a.card)) throw new Error('illegal card')
    const trump = g.contract!.suit
    const hands = g.hands.map((h, i) => (i === seat ? h.filter((c) => c !== a.card) : h))
    const trick = [...g.trick, { seat, card: a.card }]
    if (trick.length < 4) return { ...g, hands, trick, turn: next(seat) }
    const winner = winningPlay(trick, trump).seat
    const t = teamOf(winner)
    const points = [...g.points] as [number, number]
    const tricks = [...g.tricks] as [number, number]
    points[t] += trick.reduce((sum, p) => sum + cardPoints(p.card, trump), 0) + (hands[0].length === 0 ? 10 : 0)
    tricks[t] += 1
    const after: Game = { ...g, hands, trick: [], lastTrick: trick, points, tricks, turn: winner }
    return hands[0].length === 0 ? endHand(after, rand) : after
  }

  if (!legalBids(g, seat).some((b) => sameAction(b, a))) throw new Error('illegal bid')
  const c = g.contract
  if (a.type === 'bid') return { ...g, contract: { seat, value: a.value, suit: a.suit, mult: 1 }, passes: 0, turn: next(seat) }
  if (a.type === 'coinche') return { ...g, contract: { ...c!, mult: 2 }, coinchedBy: seat, passes: 0, turn: firstBidderAfter(seat, c!.seat) }
  if (a.type === 'surcoinche') return startPlay({ ...g, contract: { ...c!, mult: 4 } })
  // pass
  if (c && g.coinchedBy !== null) return startPlay(g) // bidders declined to surcoinche
  const passes = g.passes + 1
  if (!c && passes === 4) return newHand(g.scores, next(g.dealer), rand, g.lastHand) // everyone passed: redeal
  if (c && passes === 3) return startPlay(g)
  return { ...g, passes, turn: next(seat) }
}

// After a coinche, the next bidding-team player in turn order may surcoinche or pass.
function firstBidderAfter(from: Seat, bidder: Seat): Seat {
  let s = next(from)
  while (teamOf(s) !== teamOf(bidder)) s = next(s)
  return s
}

// What one seat is allowed to see.
export function viewFor(g: Game, seat: Seat) {
  const { hands, ...rest } = g
  return { ...rest, seat, hand: hands[seat], handSizes: hands.map((h) => h.length), legalCards: legalCards(g, seat), legalBids: legalBids(g, seat) }
}
export type View = ReturnType<typeof viewFor>

// Simple bot: bids on a strong trump suit, otherwise plays its weakest legal card (or wins cheaply when it can).
export function botAction(g: Game, seat: Seat): Action {
  if (g.phase === 'bidding') {
    const hand = g.hands[seat]
    let best: { suit: Suit; score: number } = { suit: 'S', score: 0 }
    for (const suit of SUITS) {
      const score = hand.filter((c) => suitOf(c) === suit).reduce((s, c) => s + TRUMP_POINTS[rankOf(c)] + 5, 0)
      if (score > best.score) best = { suit, score }
    }
    const want = Math.min(MAX_BID, Math.floor((best.score + 30) / BID_STEP) * BID_STEP)
    const bid = legalBids(g, seat).find((b) => b.type === 'bid' && b.suit === best.suit && b.value === want)
    return bid ?? { type: 'pass' }
  }
  const trump = g.contract!.suit
  const legal = legalCards(g, seat)
  const byStrength = [...legal].sort((a, b) => strength(a, trump) - strength(b, trump))
  if (g.trick.length) {
    const best = winningPlay(g.trick, trump)
    if (teamOf(best.seat) !== teamOf(seat)) {
      const winner = byStrength.find((c) => winningPlay([...g.trick, { seat, card: c }], trump).seat === seat)
      if (winner) return { type: 'play', card: winner }
    }
  }
  return { type: 'play', card: byStrength[0] }
}
