// Module-resolution hook used by register.mjs.
const FAKES = new URL('../fakes/', import.meta.url);
export async function resolve(specifier, context, next) {
  const m = /^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/(firebase-[a-z]+)\.js$/.exec(specifier);
  if (m) return { url: new URL(`${m[1]}.js`, FAKES).href, shortCircuit: true };
  return next(specifier, context);
}
