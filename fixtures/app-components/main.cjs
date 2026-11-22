'use strict';
// First: the bridge (off unless EAB_ENABLE=1). In Launch-mode tests the launcher injects it instead.
if (process.env.EAB_FIXTURE_MODE !== 'launch') require('@electron-agent-bridge/electron').enableAgentBridge();
const path = require('node:path');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

runFixture(async () => {
  const window = await createFixtureWindow({
    file: path.join(__dirname, 'index.html'),
    name: 'app-components',
  });
  const page = (script) => window.webContents.executeJavaScript(script);
  handleCommands({
    'react-text': () => page("document.querySelector('#react-add').textContent"),
  });
});
