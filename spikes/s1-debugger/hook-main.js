// Main-world state hook. Must run before app scripts.
(() => {
  const registry = { stores: [] };
  Object.defineProperty(globalThis, Symbol.for('eab.state'), { value: registry, configurable: true });
  let real = globalThis.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__;
  Object.defineProperty(globalThis, '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__', {
    configurable: true,
    get() {
      return (options) => (...funcs) => {
        const base = real ? real(options)(...funcs) : funcs.reduce((a, b) => (...x) => a(b(...x)), (x) => x);
        return (createStore) => (...args) => {
          const store = base(createStore)(...args);
          registry.stores.push(store);
          document.documentElement.dataset.storeCaptured = String(registry.stores.length);
          return store;
        };
      };
    },
    set(value) { real = value; }
  });
})();
