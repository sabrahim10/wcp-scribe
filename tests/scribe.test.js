// Node runner for the shared spec. Run with:  node --test   (or: npm test)
//
// The test cases themselves live in tests/spec.js so the exact same assertions
// also run in the browser via tests/harness.html (to confirm Safari behaves).

const { test } = require('node:test');
const cases = require('./spec.js');

for (const c of cases) {
  test(c.name, () => { c.fn(); });
}
