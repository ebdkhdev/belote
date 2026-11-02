import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, botAction, cardPoints, deal, legalCards, newGame, scoreHand, SUITS, RANKS } from './index.ts'
import type { Game, Seat } from './index.ts'

const playing = (hands: string[][], trick: { seat: Seat; card: string }[], turn: Seat): Game => ({
  ...newGame(), phase: 'playing', hands, trick, turn, contract: { seat: 0, value: 80, suit: 'H', mult: 1 },
})

test('deck has 32 unique cards worth 152 points plus 10 for the last trick', () => {
  const all = deal().flat()
  assert.equal(new Set(all).size, 32)
  for (const trump of SUITS) assert.equal(all.reduce((s, c) => s + cardPoints(c, trump), 0), 152)
  assert.equal(RANKS.length * SUITS.length, 32)
})

test('must follow suit', () => {
  const g = playing([[], ['7S', 'AS', 'JH'], [], []], [{ seat: 0, card: 'KS' }], 1)
  assert.deepEqual(legalCards(g, 1), ['7S', 'AS'])
})

test('must trump when void, and overtrump when possible', () => {
  const g = playing([[], [], ['7H', 'JH', '7D'], []], [{ seat: 0, card: 'KS' }, { seat: 1, card: '9H' }], 2)
  assert.deepEqual(legalCards(g, 2), ['JH'])
})

test('must still undertrump when unable to overtrump', () => {
  const g = playing([[], [], ['7H', '7D'], []], [{ seat: 0, card: 'KS' }, { seat: 1, card: '9H' }], 2)
  assert.deepEqual(legalCards(g, 2), ['7H'])
})

test('free to discard when partner is winning', () => {
  const g = playing([[], [], ['7H', '7D'], []], [{ seat: 0, card: 'AS' }, { seat: 1, card: '7S' }], 2)
  assert.deepEqual(legalCards(g, 2), ['7H', '7D'])
})

test('trump lead forces a higher trump', () => {
  const g = playing([[], ['7H', 'JH', '7D'], [], []], [{ seat: 0, card: '9H' }], 1)
  assert.deepEqual(legalCards(g, 1), ['JH'])
})

test('scoring: made, failed, coinched, capot, belote', () => {
  const c = { seat: 0 as Seat, value: 100, suit: 'H' as const, mult: 1 as const }
  assert.deepEqual(scoreHand(c, [110, 52], [5, 3], null).delta, [100, 0])
  assert.deepEqual(scoreHand(c, [90, 72], [5, 3], null).delta, [0, 260])
  assert.deepEqual(scoreHand(c, [90, 72], [5, 3], 0).delta, [120, 0]) // belote carries the contract and still scores 20
  assert.deepEqual(scoreHand({ ...c, mult: 2 }, [90, 72], [5, 3], null).delta, [0, 520])
  assert.deepEqual(scoreHand(c, [162, 0], [8, 0], null).delta, [500, 0])
  assert.deepEqual(scoreHand({ ...c, value: 'capot' }, [152, 10], [7, 1], 1).delta, [0, 520])
})

test('coinche then pass starts play with doubled contract', () => {
  let g = newGame()
  g = apply(g, 0, { type: 'bid', value: 90, suit: 'S' })
  g = apply(g, 1, { type: 'coinche' })
  assert.equal(g.turn, 2)
  g = apply(g, 2, { type: 'pass' })
  assert.equal(g.phase, 'playing')
  assert.equal(g.contract!.mult, 2)
  assert.throws(() => apply(g, 2, { type: 'play', card: g.hands[2][0] }), /not your turn/)
})

test('four bots finish a whole game with legal moves only', () => {
  let g = newGame()
  for (let i = 0; i < 20000 && g.phase !== 'gameOver'; i++) g = apply(g, g.turn, botAction(g, g.turn))
  assert.equal(g.phase, 'gameOver')
  assert.ok(Math.max(...g.scores) >= 1000)
})
