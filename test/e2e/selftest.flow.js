'use strict';
// Proves that a failing check fails the run: one check here is wrong on
// purpose, so `E2E_SELFTEST=1 npm run e2e -- selftest` must exit 1. Kept out
// of the default run.

module.exports = {
  description: 'a deliberately wrong check; the run must exit 1',
  selftest: true,
  async run(t) {
    t.equal(t.trayTitle(), ' 20%', 'a right check still passes next to it');
    t.equal(t.trayTitle(), ' 99%', 'self-test: this check is wrong on purpose');
  },
};
