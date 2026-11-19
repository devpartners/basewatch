import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtAmount, sparkline, truncate, visibleLength, link, makeStyle, stripAnsi } from '../src/format.js'

test('amounts are exact fixed-point, truncated to the shown places', () => {
  assert.equal(fmtAmount(2_201_232n, 6, 6), '2.201232')
  assert.equal(fmtAmount(0n, 18, 8), '0.00000000')
  assert.equal(fmtAmount(1_234_567_000_000n, 6, 6), '1,234,567.000000')
  assert.equal(fmtAmount(-9_000n, 6, 6, { sign: true }), '-0.009000')
  assert.equal(fmtAmount(1_000n, 6, 6, { sign: true }), '+0.001000')
  assert.equal(fmtAmount(0n, 6, 6, { sign: true }), '0.000000')
})

test('a non-zero amount is never shown as zero', () => {
  assert.equal(fmtAmount(21_000n, 18, 8, { sign: true }), '+0.000000000000021')
  assert.equal(fmtAmount(-1n, 18, 8, { sign: true }), '-0.000000000000000001')
})

test('sparkline spans low to high', () => {
  assert.equal(sparkline([0n, 7n]), '▁█')
  assert.equal(sparkline([5n, 5n, 5n]), '▁▁▁')
  assert.equal(sparkline([1n]), '')
})

test('truncate keeps colors and links intact', () => {
  const s = makeStyle(true)
  const line = s.green('abcdef') + ' ' + link('https://x.test', 'linktext', true)
  assert.equal(visibleLength(line), 15)
  const cut = truncate(line, 10)
  assert.equal(visibleLength(cut), 10)
  assert.equal(stripAnsi(cut), 'abcdef li…')
  assert.ok(cut.includes('\x1b]8;;\x1b\\'), 'an open link is closed')
  assert.equal(truncate('short', 10), 'short')
})
