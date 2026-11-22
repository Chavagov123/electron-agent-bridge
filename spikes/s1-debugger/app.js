// Plays the role of an app bundle: runs in the main world.
document.documentElement.dataset.appSawHook = String(Boolean(window[Symbol.for('eab.state')]));
document.documentElement.dataset.leak = typeof window.__eabPush;
const composeFactory = window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__;
const compose = composeFactory ? composeFactory({ name: 's1' }) : (f) => f;
const fakeStore = { getState: () => ({ count: 1 }), dispatch: (a) => a };
compose((createStore) => (...args) => createStore(...args))(() => fakeStore)();
for (let i = 0; i < 500; i += 1) {
  const d = document.createElement('div');
  d.textContent = `node ${i}`;
  document.body.appendChild(d);
}
