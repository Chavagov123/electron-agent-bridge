const { app } = require('electron');
module.exports = (variant, expected) => app.whenReady().then(() => {
  process.stdout.write(`SPIKE ${JSON.stringify({ variant, expected, wrapped: globalThis.__eabWrapped ?? null,
    install: globalThis.__eabInstall ?? null, triggers: (globalThis.__eabTriggers||[]).slice(0,6), channels: globalThis.__eabChannels, scrubbedNodeOptions: globalThis.__eabScrubbed ?? null,
    pass: globalThis.__eabWrapped === expected })}\n`);
  process.stdout.write('SPIKE_DONE\n');
  app.quit();
});
