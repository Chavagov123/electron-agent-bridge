require('./eab-register.cjs');            // first line: integrated install
const n = require('./handlers.cjs');
require('./report.cjs')('cjs-integrated', n);
