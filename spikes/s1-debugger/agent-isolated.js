// Isolated-world page agent stub.
(() => {
  const send = (o) => {
    try { globalThis.__eabPush(JSON.stringify(o)); }
    catch { if (document.documentElement) document.documentElement.dataset.eabNoBinding = '1'; }
  };
  let mutations = 0;
  const start = () => {
    new MutationObserver((records) => { mutations += records.length; })
      .observe(document, { subtree: true, childList: true, attributes: true });
    setTimeout(() => {
      const ds = document.documentElement.dataset;
      send({ type: 'hello', nodes: document.getElementsByTagName('*').length, leak: ds.leak,
        appSawHook: ds.appSawHook, storeCaptured: ds.storeCaptured, href: location.href,
        isTop: window === window.top, mutationsAfterStart: mutations });
    }, 300);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
