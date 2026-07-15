export function createHandleAllocator(start = 1) {
  if (!Number.isInteger(start) || start < 1) {
    throw new RangeError('DXF handle start must be a positive integer');
  }
  let current = start;
  return {
    next() {
      const handle = current.toString(16).toUpperCase();
      current += 1;
      return handle;
    },
    peek() {
      return current.toString(16).toUpperCase();
    },
  };
}
