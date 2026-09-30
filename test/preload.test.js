'use strict';
// The page's whole reach into the app: src/preload.js (PLAN §7, §8 item 17).
// It runs here in a vm with a stub `electron`, and the test pins the exact
// names on window.api, the channel and kind (invoke / send / subscription)
// behind each, what each passes on, and that a subscriber never sees the
// IPC event. The window's webPreferences and navigation guards are pinned
// statically, since moving main.js into src/main/ must not lose them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');
const PRELOAD_SRC = fs.readFileSync(PRELOAD, 'utf8');

// PLAN §7. [name on window.api, channel, arguments the test passes]
const INVOKE = [
  ['info', 'app:info', []],
  ['getState', 'accounts:get', []],
  ['refresh', 'accounts:refresh', []],
  ['switchTo', 'accounts:switch', [{ strategy: 'best' }]],
  ['setDisabled', 'accounts:set-disabled', [{ email: 'bob@example.com', organizationUuid: '' }, true]],
  ['recheck', 'app:recheck', []],
  ['chooseBinary', 'app:choose-binary', []],
  ['usePath', 'app:use-path', []],
  ['copy', 'app:copy', ['uv tool install claude-swap']],
  ['getSettings', 'settings:get', []],
  ['setSettings', 'settings:set', [{ statsPeriod: 'week' }]],
  ['history.accounts', 'history:accounts', []],
  ['history.get', 'history:get', ['0123456789ab', 7]],
];
const SEND = [
  ['openDocs', 'app:open-docs', []],
  ['showMenu', 'app:menu', []],
  ['resize', 'ui:resize', [517]],
  ['setWindowMode', 'ui:set-window-mode', ['widget']],
  ['showAccountMenu', 'accounts:menu', [{ email: 'bob@example.com', organizationUuid: 'org-bob' }]],
  ['sendTrayImage', 'tray:image', [3, 'data:image/png;base64,iVBORw0KGgo=', true]],
];
const SUBSCRIBE = [
  ['onToast', 'ui:toast'],
  ['onState', 'accounts:state'],
  ['onSettings', 'settings:changed'],
  ['onTrayDraw', 'tray:draw'],
  ['onOpen', 'ui:open'],
  ['history.onChanged', 'history:changed'],
];

// A stub of what a sandboxed preload may use from electron, recording every call.
function load() {
  const calls = [];
  const listeners = new Map(); // channel → Set of listener functions
  const exposed = [];
  const ipcRenderer = {
    invoke: (channel, ...args) => {
      calls.push({ kind: 'invoke', channel, args });
      return Promise.resolve({ channel });
    },
    send: (channel, ...args) => {
      calls.push({ kind: 'send', channel, args });
    },
    on: (channel, fn) => {
      calls.push({ kind: 'on', channel });
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
      return ipcRenderer;
    },
    removeListener: (channel, fn) => {
      calls.push({ kind: 'removeListener', channel });
      if (listeners.has(channel)) listeners.get(channel).delete(fn);
      return ipcRenderer;
    },
  };
  const contextBridge = { exposeInMainWorld: (name, value) => exposed.push({ name, value }) };
  const required = [];
  const requireStub = (name) => {
    required.push(name);
    if (name === 'electron') return { contextBridge, ipcRenderer };
    throw new Error(`the sandboxed preload cannot require ${name}`);
  };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) {${PRELOAD_SRC}\n})`, { filename: PRELOAD });
  const mod = { exports: {} };
  wrapper(requireStub, mod, mod.exports);
  const emit = (channel, ...args) => {
    for (const fn of listeners.get(channel) || []) fn(...args);
  };
  return { calls, listeners, exposed, required, emit, api: exposed.length ? exposed[0].value : null };
}

const pick = (api, name) => name.split('.').reduce((o, k) => o[k], api);

test('the preload requires only electron and exposes one global, window.api', () => {
  const { exposed, required, calls } = load();
  assert.deepEqual(required, ['electron']);
  assert.deepEqual(
    exposed.map((e) => e.name),
    ['api'],
  );
  assert.deepEqual(calls, [], 'nothing is sent or subscribed at load time');
});

test('window.api has exactly the PLAN §7 names', () => {
  const { api } = load();
  const top = [...INVOKE, ...SEND, ...SUBSCRIBE].map(([name]) => name.split('.')[0]);
  assert.deepEqual(Object.keys(api).sort(), [...new Set(top)].sort());
  assert.deepEqual(Object.keys(api.history).sort(), ['accounts', 'get', 'onChanged']);
  for (const [name] of [...INVOKE, ...SEND, ...SUBSCRIBE]) {
    assert.equal(typeof pick(api, name), 'function', name);
  }
});

test('invoke calls: channel and arguments exactly as given, the promise returned', async () => {
  for (const [name, channel, args] of INVOKE) {
    const { api, calls } = load();
    const result = pick(api, name)(...args);
    assert.ok(result instanceof Promise, `${name} returns the invoke promise`);
    assert.deepEqual(await result, { channel });
    assert.deepEqual(calls, [{ kind: 'invoke', channel, args }], name);
  }
});

test('extra arguments from the page are not passed on', () => {
  for (const [name, channel, args] of [...INVOKE, ...SEND]) {
    const { api, calls } = load();
    pick(api, name)(...args, 'extra', { more: true });
    assert.deepEqual(calls[0].channel, channel);
    assert.deepEqual(calls[0].args, args, `${name} passes only its own arguments`);
  }
});

test('send calls: fire and forget on their channel', () => {
  for (const [name, channel, args] of SEND) {
    const { api, calls } = load();
    assert.equal(pick(api, name)(...args), undefined, `${name} returns nothing`);
    assert.deepEqual(calls, [{ kind: 'send', channel, args }], name);
  }
});

test('subscriptions: the payload only, never the IPC event; the return value unsubscribes', () => {
  for (const [name, channel] of SUBSCRIBE) {
    const { api, listeners, emit } = load();
    const got = [];
    const other = [];
    const off = pick(api, name)((...args) => got.push(args));
    pick(api, name)((...args) => other.push(args));
    assert.equal(listeners.get(channel).size, 2, `${name} listens on ${channel}`);
    const event = { sender: { send() {} }, senderFrame: {}, ports: [] };
    emit(channel, event, { n: 1 }, 'ignored');
    assert.deepEqual(got, [[{ n: 1 }]], `${name} hands over the payload alone`);
    assert.equal(typeof off, 'function', `${name} returns an unsubscribe function`);
    off();
    assert.equal(listeners.get(channel).size, 1, `${name}: unsubscribing removes only that listener`);
    emit(channel, event, { n: 2 });
    assert.deepEqual(got, [[{ n: 1 }]]);
    assert.deepEqual(other, [[{ n: 1 }], [{ n: 2 }]]);
  }
});

test('every channel named in the preload is one of the PLAN §7 channels', () => {
  const expected = [...INVOKE, ...SEND, ...SUBSCRIBE].map(([, channel]) => channel).sort();
  const named = [...PRELOAD_SRC.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(named, expected);
});

// ── the window that loads it ─────────────────────────────────────────────────

const MAIN_FILES = ['main.js', ...fs.readdirSync(path.join(ROOT, 'src', 'main')).map((f) => path.join('src', 'main', f))].filter((f) => f.endsWith('.js'));
const mainSrc = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the popover window keeps its webPreferences: isolated, no Node, sandboxed, no spellcheck', () => {
  const src = mainSrc(path.join('src', 'main', 'window.js'));
  const prefs = /webPreferences:\s*\{([^}]*)\}/.exec(src);
  assert.ok(prefs, 'window.js sets webPreferences');
  const body = prefs[1];
  assert.match(body, /preload:\s*path\.join\(ROOT, 'src', 'preload\.js'\)/);
  assert.match(body, /contextIsolation:\s*true/);
  assert.match(body, /nodeIntegration:\s*false/);
  assert.match(body, /sandbox:\s*true/);
  assert.match(body, /spellcheck:\s*false/);
});

test('no main-process file weakens the renderer', () => {
  const weak = /contextIsolation:\s*false|nodeIntegration\w*:\s*true|sandbox:\s*false|webSecurity:\s*false|allowRunningInsecureContent:\s*true|enableRemoteModule|experimentalFeatures:\s*true|webviewTag:\s*true/;
  for (const file of MAIN_FILES) assert.doesNotMatch(mainSrc(file), weak, file);
});

test('navigation is blocked and new windows are denied', () => {
  const src = mainSrc(path.join('src', 'main', 'window.js'));
  assert.match(src, /on\('will-navigate', \(e\) => e\.preventDefault\(\)\)/);
  assert.match(src, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
});
