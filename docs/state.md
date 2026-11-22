# Application state

Agents can read the app's renderer stores (the `state` tool, `state.read` / `state.dispatch`) and wait
for a value (`wait_for` with `kind: "state"`). Nothing is read until someone asks; values are bounded and
secret-looking keys (`token`, `password`, `apiKey`…) are redacted, like IPC values.

## Making stores visible

**`registerState`** works for any store and needs no other setup. Call it from page code (not from a
preload; preloads run in an isolated world):

```js
import { registerState } from '@eab/electron/renderer';

registerState('cart', store);                 // Redux / Redux Toolkit store
registerState('prefs', usePrefs);             // Zustand store or hook
registerState('todos', todoModel);            // MobX observable
registerState('model', () => appModel.toJSON()); // anything: an object or a getter
registerState('prefs', prefsStore, { dispatch: (action) => applyAction(action) }); // make it dispatchable
```

`@eab/electron/renderer` has no dependencies and is safe to ship: without the bridge every call is a
no-op. It returns a function that unregisters the store; registering a name again replaces the store.

**Devtools shim (opt-in).** Stores built with Redux DevTools support register themselves when the app
turns on the shim:

```js
require('@eab/electron').enableAgentBridge({ state: { devtoolsShim: true } });
```

The bridge then defines `__REDUX_DEVTOOLS_EXTENSION__` (with `connect`) and
`__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` in app pages, only where no real extension is installed. That
covers Redux Toolkit (`devTools` is on by default; its `name` becomes the store name), plain Redux with
the enhancer, and Zustand's `devtools` middleware (dispatch `{ "type": "__setState", "state": {…} }` to
set its state). Like the real extension, the enhancer sits below middleware: thunks are not seen, the
plain actions they dispatch are. The shim is off by default because it adds visible globals.

In Launch mode a launcher turns it on for an unmodified app: `launch({ stateShim: true })`,
`eab launch … --state-shim`, or `"stateShim": true` in the MCP `session` launch. It only finds stores
the app connects to DevTools, which production builds often skip: among popular apps tested, only a
library's internal store (react-beautiful-dnd in Mattermost) registered. For an app's own state, the
app calls `registerState`.

## Reading and dispatching

| Kind | Detected by | Read | Dispatch |
|---|---|---|---|
| `redux` | `getState` + `dispatch` + `subscribe` | `getState()` | the store's `dispatch` |
| `zustand` | `getState` + `setState` + `subscribe` | `getState()` | only with a `dispatch` option |
| `mobx` | MobX observable | the observable | only with a `dispatch` option |
| `generic` | anything else | the object, or the getter's result | only with a `dispatch` option |

`actions` in the store list counts updates seen since registration (dispatches for Redux, `setState`
calls for Zustand, `send` calls through the shim).

`wait_for` with `kind: "state"` compares `equals` with the value as `state.read` returns it (redacted,
bounded, key order ignored) and is never met while the page has no stores yet.

Paths: `orders.items[0].id`, `byId["a.b"]`. A missing path fails with `NOT_FOUND` naming the keys that
exist there. Values are cut at depth 6 (`maxDepth` up to 20), 50 keys, 50 items, 1,000 characters per
string; `truncated` says when. Cycles, functions, Maps, Sets, dates and errors are described, not lost.

## How it works

At page creation the bridge registers a small main-world script (9 KB) for every new document of app
pages (windows and views; never `<webview>` guests, never iframes). It runs before the app's scripts,
defines the registry under `Symbol.for('electron-agent-bridge.v1.state')` (not enumerable) and, if
enabled, the devtools shim. Reads run `Runtime.evaluate` in the page's main world on demand.

The same script notes which elements the page listens to for clicks, so snapshots can give plain
`div`s that act as buttons a `clickable` ref: it wraps `EventTarget.prototype.addEventListener` (records
the element, then calls the original unchanged) and also sees `onclick` properties and React click
props. The isolated-world agent asks about an element by dispatching a cancelable
`electron-agent-bridge.v1.clickable` event at it, which the script answers and stops before any page
listener sees it. Elements that only wrap other controls (delegation, close-on-click panels) stay
transparent. Turn it off with `enableAgentBridge({ snapshot: { clickListeners: false } })`.

Limits: a page that loaded before the bridge started has no registry until it reloads (the result says
so). State values come from the page and are returned as untrusted data.

## Component state (1.1)

`state.component { locator, path?, component? }` (MCP: `state action=component ref=e12`) reads the
React or Vue 3 component behind an element, with no registration:

- **React** (16.8+): the components above the element, nearest first (`chain`), each as
  `{ props, hooks }` for function components — the values of its `useState` and `useReducer` hooks in
  call order, `otherHooks` counting the rest (refs, memos, effects) — or `{ props, state }` for class
  components. `children` shows as `[children]`.
- **Vue 3**: the component instances above the element, as `{ props, state }`, where `state` is what
  `setup()` returned plus `data()`.

`component: 1` reads the parent component, `path` reads into the value (`hooks[0]`, `props.label`,
`state.items`). The element is found by the page agent, handed to the page's main world by its DOM
node, and read there by a small reader sent with the call (nothing is installed in the page). Values
are bounded and redacted like store state.

Limits: Vue needs a development build or one with devtools support (production builds do not tag
elements with their component), and state kept only in closures (a `setup()` that returns a render
function) is not visible. React production builds work, but component names may be minified and
hooks have no names.
