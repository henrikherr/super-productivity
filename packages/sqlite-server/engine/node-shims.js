// Minimal browser globals so app modules can be EVALUATED in Node. Several app
// modules read platform flags at import time (e.g. `!!window.SUPAndroid`,
// `navigator.userAgent`). The engine never renders UI; these shims only make
// such checks resolve to "plain web, no native bridge".
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}
if (typeof globalThis.document === 'undefined') {
  const classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    documentElement: { classList, style: {} },
    body: { classList },
    createElement: () => ({ style: {}, setAttribute() {} }),
    querySelector: () => null,
    hidden: true,
    visibilityState: 'hidden',
  };
}
