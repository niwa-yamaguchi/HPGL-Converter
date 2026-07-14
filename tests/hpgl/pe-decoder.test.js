import { describe, expect, it } from 'vitest';
import { decodePe } from '../../src/hpgl/pe-decoder.js';

function encodeValue(value, base = 64) {
  let n = value >= 0 ? value * 2 : Math.abs(value) * 2 + 1;
  const bytes = [];
  while (n >= base) {
    bytes.push(63 + (n % base));
    n = Math.floor(n / base);
  }
  bytes.push((base === 64 ? 191 : 95) + n);
  return bytes;
}

const flag = value => value.charCodeAt(0);

describe('decodePe', () => {
  it('decodes relative coordinates, one-shot absolute, pen-up, and pen selection', () => {
    const data = Uint8Array.from([
      ...encodeValue(40), ...encodeValue(0),
      flag('<'), ...encodeValue(0), ...encodeValue(40),
      flag('='), ...encodeValue(80), ...encodeValue(80),
      flag(':'), ...encodeValue(3),
    ]);

    expect(decodePe(data)).toEqual({
      events: [
        { type: 'move', x: 40, y: 0, absolute: false, penDown: true },
        { type: 'move', x: 0, y: 40, absolute: false, penDown: false },
        { type: 'move', x: 80, y: 80, absolute: true, penDown: true },
        { type: 'pen', value: 3 },
      ],
    });
  });

  it('decodes negative and multi-digit coordinates', () => {
    const data = Uint8Array.from([
      ...encodeValue(-80), ...encodeValue(4096),
    ]);

    expect(decodePe(data)).toEqual({
      events: [
        { type: 'move', x: -80, y: 4096, absolute: false, penDown: true },
      ],
    });
  });

  it('keeps base32 active after the 7 flag', () => {
    const data = Uint8Array.from([
      flag('7'),
      ...encodeValue(40, 32), ...encodeValue(-64, 32),
      ...encodeValue(96, 32), ...encodeValue(128, 32),
    ]);

    expect(decodePe(data)).toEqual({
      events: [
        { type: 'move', x: 40, y: -64, absolute: false, penDown: true },
        { type: 'move', x: 96, y: 128, absolute: false, penDown: true },
      ],
    });
  });

  it('applies persistent fractional bits to following coordinates', () => {
    const data = Uint8Array.from([
      flag('>'), ...encodeValue(2),
      ...encodeValue(40), ...encodeValue(-20),
      ...encodeValue(80), ...encodeValue(4),
    ]);

    expect(decodePe(data)).toEqual({
      events: [
        { type: 'move', x: 10, y: -5, absolute: false, penDown: true },
        { type: 'move', x: 20, y: 1, absolute: false, penDown: true },
      ],
    });
  });

  it('accepts an empty PE command as a no-op', () => {
    expect(decodePe(new Uint8Array())).toEqual({ events: [] });
  });

  it.each([
    ['truncated value', Uint8Array.from([63])],
    ['odd coordinate count', Uint8Array.from(encodeValue(40))],
    ['bad byte', Uint8Array.from([127])],
    ['pen flag without a value', Uint8Array.from([flag(':')])],
    ['fraction flag without a value', Uint8Array.from([flag('>')])],
    ['pen-up flag without a pair', Uint8Array.from([flag('<')])],
    ['absolute flag without a pair', Uint8Array.from([flag('=')])],
    ['invalid negative fractional count', Uint8Array.from([
      flag('>'), ...encodeValue(-1), ...encodeValue(0), ...encodeValue(0),
    ])],
    ['invalid excessive fractional count', Uint8Array.from([
      flag('>'), ...encodeValue(31), ...encodeValue(0), ...encodeValue(0),
    ])],
  ])('rejects %s without partial events', (_name, data) => {
    const result = decodePe(data);

    expect(result.events).toEqual([]);
    expect(result.error).toEqual(expect.any(String));
  });
});
