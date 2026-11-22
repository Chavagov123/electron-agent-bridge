const n = require('./handlers.cjs');      // unmodified app (Launch mode)
require('./report.cjs')(process.env.SPIKE_VARIANT || 'cjs-plain', n);
