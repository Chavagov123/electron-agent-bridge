---
'@eab/core': minor
'@eab/page-agent': minor
'@eab/engine': minor
'@eab/electron': minor
'@eab/mcp': minor
---

Component state and faster actions. `state.component` (MCP `state action=component ref=…`) reads the
React or Vue 3 component behind an element: props, state hooks or setup state, and the components around
it. Actions take fewer round trips: settling and sampling the page are one call, all but the last input
event of a gesture are posted, and locator lookups are reused while the DOM is unchanged.
