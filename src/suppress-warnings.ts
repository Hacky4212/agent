// Suppress Node's harmless DEP0040 "the punycode module is deprecated" warning.
// It's emitted by a transitive dependency of the OpenAI SDK — not by our code —
// and only looks like a scary error to end users. This module is imported FIRST
// in index.ts so the filter is installed before any dependency can emit it.
// Every other warning passes through untouched.
const originalEmit = process.emit;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.emit as any) = function (
  this: unknown,
  name: string,
  data: { name?: string; message?: string },
  ...rest: unknown[]
): boolean {
  if (
    name === 'warning' &&
    data &&
    data.name === 'DeprecationWarning' &&
    typeof data.message === 'string' &&
    data.message.includes('punycode')
  ) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalEmit as any).call(this, name, data, ...rest);
};
