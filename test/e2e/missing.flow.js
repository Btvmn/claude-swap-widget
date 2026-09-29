'use strict';
// cswap not found: the install screen, the tray's "!", the copy buttons, and
// "Check again" once cswap is there. CSWAP_PATH points nowhere, so the app
// searches PATH and the usual folders; on a Mac where cswap is installed the
// harness refuses to run it and the app sees it as missing (ENOENT).

const os = require('os');
const path = require('path');

module.exports = {
  description: 'cswap missing: install screen, tray "!", Copy, Check again',
  env: { CSWAP_PATH: path.join(os.tmpdir(), 'csw-e2e-no-such-cswap') },
  async run(t) {
    t.allow('blocked-spawn', /refused to run \S+ --version:/);

    t.section('install screen');
    const s = await t.state();
    t.equal(s.phase, 'missing', 'the app reports cswap missing');
    t.equal(Boolean(s.cswap && s.cswap.configured), false, 'not a configured path');
    await t.expect(() => t.ui.screenTitle(), 'Install claude-swap', 'the install screen is shown');
    t.equal(await t.ui.screenCommands(), ['uv tool install claude-swap', 'pipx install claude-swap'], 'with both install commands');
    t.equal(await t.ui.screenButtons(), ['Check again', 'Choose binary…', 'Install guide'], 'and its actions');
    t.equal(await t.ui.footerVisible(), false, 'no footer');
    await t.expect(t.trayTitle, ' !', 'the tray shows "!"');
    await t.expect(t.trayTooltip, 'claude-swap needs setup', 'and says setup is needed');
    t.equal(t.calls().filter((c) => c !== '--version'), [], 'no cswap command ran');
    await t.snap('install-screen');

    t.section('Copy and Install guide');
    t.ok(await t.ui.clickCopy('uv tool install claude-swap'), 'the uv command has a Copy button');
    await t.waitFor(() => t.clipboard.length, 'the clipboard');
    t.equal(t.clipboard, ['uv tool install claude-swap'], 'Copy puts the command on the clipboard');
    t.ok(await t.ui.clickScreenButton('Install guide'), 'Install guide is there');
    await t.waitFor(() => t.shellCalls.some((c) => c.fn === 'openExternal'), 'the browser');
    t.equal(t.shellCalls.filter((c) => c.fn === 'openExternal').map((c) => c.arg), ['https://github.com/realiti4/claude-swap#installation'], 'it opens the fixed install URL');

    t.section('Check again, now installed');
    process.env.CSWAP_PATH = t.fake; // main's env: the next search finds the fake
    const mark = t.mark();
    t.ok(await t.ui.clickScreenButton('Check again'), 'Check again is there');
    await t.waitFor(() => t.service.state.phase === 'ok', 'the accounts');
    await t.idle();
    t.equal(t.calls(mark), ['--version', 'list --json'], 'version check, then the list');
    await t.expect(() => t.ui.activeNumbers(), [1], 'the accounts are shown, alice active');
    await t.expect(t.trayTitle, ' 20%', 'the tray shows her usage');
  },
};
