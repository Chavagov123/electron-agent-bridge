---
'@electron-agent-bridge/core': minor
'@electron-agent-bridge/page-agent': minor
'@electron-agent-bridge/engine': minor
'@electron-agent-bridge/electron': minor
'@electron-agent-bridge/mcp': minor
---

Component state and faster actions. `state.component` (MCP `state action=component ref=…`) reads the
React or Vue 3 component behind an element: props, state hooks or setup state, and the components around
it. Actions take fewer round trips: settling and sampling the page are one call, all but the last input
event of a gesture are posted, and locator lookups are reused while the DOM is unchanged.
