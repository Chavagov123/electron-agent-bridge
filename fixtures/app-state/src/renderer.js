// Stores of the kinds real apps use, registered the ways real apps would. Bundled by build.mjs.
import { registerState } from '@electron-agent-bridge/electron/renderer';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { observable, runInAction } from 'mobx';
import { devtools } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

const cart = createSlice({
  name: 'cart',
  initialState: { items: [], count: 0 },
  reducers: {
    add: (state, action) => {
      state.items.push(action.payload);
      state.count += 1;
    },
  },
});
// Redux Toolkit with devTools on (its default): found through the devtools shim, when the app enabled it.
const cartStore = configureStore({ reducer: cart.reducer, devTools: { name: 'cart' } });

const session = createSlice({
  name: 'session',
  initialState: { user: null, token: 'tok-123', loggedIn: false },
  reducers: {
    login: (state, action) => {
      state.user = action.payload;
      state.loggedIn = true;
    },
  },
});
// devTools off: only registerState makes it visible.
const sessionStore = configureStore({ reducer: session.reducer, devTools: false });
registerState('session', sessionStore);

// Zustand with its devtools middleware (shim's connect) and a plain vanilla store (registerState).
const ui = createStore(
  devtools((set) => ({ open: false, toggle: () => set((s) => ({ open: !s.open }), false, 'toggle') }), {
    name: 'ui',
  }),
);
const prefs = createStore(() => ({ theme: 'light', fontSize: 14 }));
registerState('prefs', prefs, {
  dispatch: (action) => {
    if (action.type === 'setTheme') prefs.setState({ theme: action.theme });
  },
});

const todos = observable({ items: [{ id: 1, title: 'Write docs', done: false }], apiKey: 'k-999' });
registerState('todos', todos);

const deep = { level1: { level2: { level3: { level4: { level5: { level6: { level7: 'bottom' } } } } } } };
registerState('model', () => ({
  password: 'hunter2',
  deep,
  big: Array.from({ length: 120 }, (_, index) => index),
}));

const count = document.getElementById('count');
cartStore.subscribe(() => {
  count.textContent = String(cartStore.getState().count);
});
// A thunk: the plain action it dispatches reaches the store (and the devtools enhancer).
const addLater = (item) => (dispatch) => {
  setTimeout(() => dispatch(cart.actions.add(item)), 300);
};
document.getElementById('add').addEventListener('click', () => cartStore.dispatch(addLater('apple')));
document.getElementById('toggle').addEventListener('click', () => ui.getState().toggle());
document.getElementById('finish').addEventListener('click', () => {
  setTimeout(() => runInAction(() => (todos.items[0].done = true)), 300);
});
