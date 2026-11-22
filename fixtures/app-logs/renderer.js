'use strict';
// Logged at start-up, long before anyone asks for logs: recovered when capture starts.
console.log('renderer boot', { ready: true, items: [1, 2] });
console.warn('startup warning');

window.logSome = () => {
  console.info('info %s #%d', 'line', 7);
  console.error(new Error('logged error'));
  setTimeout(() => {
    throw new Error('renderer boom');
  });
  return new Promise((resolve) => setTimeout(() => resolve(true), 300));
};

window.fetchAll = async (port, refused) => {
  const base = `http://127.0.0.1:${port}`;
  const urls = [
    `${base}/ok`,
    `${base}/missing`,
    `${base}/error`,
    `${base}/redirect`,
    `${base}/search?q=shoes&token=abc123`,
    `http://127.0.0.1:${refused}/refused`,
  ];
  const outcomes = [];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      await response.text();
      outcomes.push(response.status);
    } catch {
      outcomes.push('failed');
    }
  }
  return outcomes;
};

window.burst = (count) => {
  for (let index = 0; index < count; index++) console.log(`burst ${index} ${'x'.repeat(200)}`);
  return count;
};
