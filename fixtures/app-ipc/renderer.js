// Renderer side of the IPC fixture: one scenario that exercises every pattern and returns what the
// page observed, so runs with the bridge off and on can be compared.
(() => {
  const outcome = async (promise) => {
    try {
      return { ok: await promise };
    } catch (error) {
      // Electron prefixes handler errors with the channel; keep the message as the app sees it.
      return { error: String(error && error.message) };
    }
  };
  window.ticks = [];
  window.api.onTick((tick) => window.ticks.push(tick));

  window.scenario = async () => {
    const result = {};
    result.add = await outcome(window.api.add(2, 3));
    result.slow = await outcome(window.api.slow(30));
    result.fail = await outcome(window.api.fail());
    result.reject = await outcome(window.api.reject());
    result.missing = await outcome(window.api.missing());
    window.api.log('first line');
    window.api.log('second line');
    result.sync = window.api.syncGet('answer');
    window.api.oncePing();
    window.api.oncePing();
    result.onceFirst = await outcome(window.api.onceHandle());
    result.onceSecond = await outcome(window.api.onceHandle());
    window.api.removedListener();
    result.replaced = await outcome(window.api.replacedHandler());
    result.pageOnly = await outcome(window.api.pageOnly());
    result.settings = await outcome(window.api.saveSettings({ theme: 'dark', password: 'hunter2' }));
    // Let fire-and-forget messages arrive before main's digest is read.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return result;
  };

  document.getElementById('add').addEventListener('click', async () => {
    document.getElementById('sum').textContent = String(await window.api.add(20, 22));
  });
})();
