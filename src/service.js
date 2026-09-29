'use strict';
// Owns the latest view of all accounts and serialises every cswap call, so a
// timer refresh never races a switch. Emits 'state' after every change; the
// main process forwards it to the tray and the renderer.

const { EventEmitter } = require('events');
const { Cswap, CswapError, findCswap, isNoAccounts } = require('./cswap');

// phase: loading | ok | no-accounts | missing | too-old | error
const INITIAL_STATE = Object.freeze({
  phase: 'loading',
  cswap: null, // { path, version }
  accounts: [],
  activeAccountNumber: null,
  fetchedAt: null,
  error: null, // { kind, message, errorType? } — with phase 'ok' it is a banner over stale data
  refreshing: false,
  switching: false,
});

function plainError(e) {
  return {
    kind: (e && e.kind) || 'unknown',
    message: (e && e.message) || String(e),
    ...(e && e.errorType ? { errorType: e.errorType } : {}),
  };
}

class AccountService extends EventEmitter {
  constructor({
    getOverride = () => null,
    find = findCswap,
    makeCswap = (binary) => new Cswap({ binary }),
    now = Date.now,
  } = {}) {
    super();
    this.getOverride = getOverride;
    this.find = find;
    this.makeCswap = makeCswap;
    this.now = now;
    this.cswap = null;
    this.state = { ...INITIAL_STATE };
    this.tail = Promise.resolve();
    this.pending = null;
    this.switches = 0;
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  enqueue(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => {});
    return run;
  }

  ageSeconds() {
    const t = Date.parse(this.state.fetchedAt);
    return Number.isFinite(t) ? (this.now() - t) / 1000 : Infinity;
  }

  async connect() {
    const override = this.getOverride() || null;
    const binary = this.find({ override: override || undefined });
    if (!binary) {
      // A configured path that is gone is reported as such: nothing else was searched.
      const cswap = override ? { path: override, version: null, configured: true } : null;
      this.update({ phase: 'missing', cswap, accounts: [], activeAccountNumber: null, error: null });
      return false;
    }
    const cswap = this.makeCswap(binary);
    try {
      const version = await cswap.check();
      this.cswap = cswap;
      this.update({ cswap: { path: binary, version, configured: Boolean(override) } });
      return true;
    } catch (e) {
      const phase = e.kind === 'too-old' ? 'too-old' : e.kind === 'not-installed' ? 'missing' : 'error';
      this.update({
        phase,
        cswap: { path: binary, version: e.version || null, configured: Boolean(override) },
        accounts: [],
        activeAccountNumber: null,
        error: phase === 'missing' ? null : plainError(e),
      });
      return false;
    }
  }

  // Coalesces: a refresh requested while one is queued or running joins it.
  refresh() {
    if (this.pending) return this.pending;
    this.update({ refreshing: true });
    this.pending = this.enqueue(async () => {
      try {
        if (!this.cswap && !(await this.connect())) return this.state;
        this.applyList(await this.cswap.list());
      } catch (e) {
        if (isNoAccounts(e)) {
          this.update({ phase: 'no-accounts', accounts: [], activeAccountNumber: null, error: null, fetchedAt: new Date(this.now()).toISOString() });
        } else if (e.kind === 'not-installed') {
          // Keep naming the configured binary that failed; nothing else was searched.
          const prev = this.state.cswap;
          const cswap = prev && prev.configured ? { path: prev.path, version: null, configured: true } : null;
          this.cswap = null;
          this.update({ phase: 'missing', cswap, accounts: [], activeAccountNumber: null, error: null });
        } else {
          // Keep the last good list on screen and show the error as a banner.
          this.update({ phase: this.state.accounts.length ? 'ok' : 'error', error: plainError(e) });
        }
      } finally {
        this.pending = null;
        this.update({ refreshing: false });
      }
      return this.state;
    });
    return this.pending;
  }

  applyList(list) {
    const accounts = Array.isArray(list.accounts) ? list.accounts : [];
    this.update({
      // An empty install answers with `accounts: []` and exit 0.
      phase: accounts.length ? 'ok' : 'no-accounts',
      accounts,
      activeAccountNumber: list.activeAccountNumber ?? null,
      fetchedAt: new Date(this.now()).toISOString(),
      error: null,
    });
  }

  // Slot numbers can change under the popover (`cswap move`, remove + add),
  // so an account picked from the list is looked up again, by identity, in a
  // fresh list right before switching. Runs inside the queue.
  async resolveAccount({ email, organizationUuid }) {
    const list = await this.cswap.list();
    this.applyList(list);
    const row = (list.accounts || []).find((a) => a.email === email && (a.organizationUuid || '') === (organizationUuid || ''));
    if (!row) throw new CswapError('cli', 'That account is no longer in claude-swap; the list has been refreshed');
    return row.number;
  }

  // Hold an account out of automatic selection, or return it. Same identity
  // lookup as a switch; the list is refreshed afterwards either way.
  async setDisabled(target, disabled) {
    try {
      await this.enqueue(async () => {
        if (!this.cswap && !(await this.connect())) {
          throw new CswapError('not-installed', 'claude-swap is not available');
        }
        const number = await this.resolveAccount(target);
        await this.cswap.setDisabled(number, disabled);
        this.update({ accounts: this.state.accounts.map((a) => (a.number === number ? { ...a, disabled } : a)) });
      });
    } finally {
      this.refresh();
    }
  }

  // Forget the binary and look for it again (after install, upgrade, or a new
  // override). The reset is queued like any call, so work already queued
  // still runs against the old binary instead of finding none.
  async reconnect() {
    await this.enqueue(() => {
      this.cswap = null;
    });
    return this.refresh();
  }

  // target: { strategy: 'best' | 'next-available' }, an account identity
  // { email, organizationUuid } (from the list), or a bare account number.
  // Resolves with cswap's switch payload. The list is refreshed afterwards
  // whether or not the switch succeeded, so the popover shows the real state.
  async switchTo(target) {
    this.switches++;
    this.update({ switching: true });
    try {
      const result = await this.enqueue(async () => {
        if (!this.cswap && !(await this.connect())) {
          throw new CswapError('not-installed', 'claude-swap is not available');
        }
        const identity = target && typeof target === 'object' && !target.strategy;
        return this.cswap.switchTo(identity ? await this.resolveAccount(target) : target);
      });
      if (result && result.switched && result.to) {
        // Show the new active account at once; usage follows with the refresh.
        const { number, email } = result.to;
        const isTarget = (a) => a.number === number && (!email || a.email === email);
        if (this.state.accounts.some(isTarget)) {
          this.update({
            activeAccountNumber: number,
            accounts: this.state.accounts.map((a) => ({ ...a, active: isTarget(a) })),
          });
        }
      }
      return result;
    } finally {
      this.switches--;
      this.update({ switching: this.switches > 0 });
      this.refresh();
    }
  }
}

module.exports = { AccountService, INITIAL_STATE, plainError };
