import { describe, expect, it } from 'vitest';
import { createHandleAllocator } from '../../src/dxf/handles.js';

describe('createHandleAllocator', () => {
  it('allocates deterministic uppercase hexadecimal handles', () => {
    const handles = createHandleAllocator(9);
    expect(handles.peek()).toBe('9');
    expect(handles.next()).toBe('9');
    expect(handles.next()).toBe('A');
    expect(handles.peek()).toBe('B');
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid start %s', start => {
    expect(() => createHandleAllocator(start)).toThrow(/positive integer/i);
  });
});
