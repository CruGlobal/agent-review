'use strict';
const { main } = require('./cli.cjs');
try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
}
