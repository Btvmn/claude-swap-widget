// Adapted from Claude Usage Widget — The Maestro edition
// (github.com/TheMaestr-o/claude-usage-widget @ b79d4b1, src/renderer/i18n.js:5-566, main.js:862-910).
// Copyright (c) 2024 Slavomir Durej; Maestro edition (c) 2026 The Maestro.
// MIT licence; see LICENSE, "Third-party code".
//
// Every visible string of the app in English, Russian, Ukrainian and German,
// plus the date, time, duration and money formatting that goes with them.
// One dictionary serves the main process (menu, tray tooltip, dialogs,
// notifications) and the sandboxed renderer, so it is a tiny UMD module like
// usage.js: `require()` in main, `<script>` in the renderer (exposed as
// `window.I18n`). No DOM and no Node APIs here; i18n-dom.js applies it to
// the page.
//
// Rules for the dictionaries (test/i18n.test.js checks the first two and
// the apostrophe):
// - Every language has exactly the keys of `en`, with the same {placeholders}.
// - No `<` or `>`: strings are set as text, never parsed as HTML.
// - No plurals. Counts use abbreviated units that do not decline ("3 д 4 ч").
// - ru/uk address the user with the formal «вы», de with "du", as Maestro
//   does. Ukrainian writes the apostrophe as ʼ (U+02BC).
// - A percentage is "{p}%" in en/ru/uk and "{p} %" in de.
// - cswap's own words stay English: `message`, `warnings[]` and
//   `error.message` are shown as details only; `reason` and `kind` map to keys.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.I18n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STRINGS = {
    en: {
      // App chrome and header
      'app.title': 'Claude accounts',
      'btn.settings': 'Settings',
      'btn.refresh': 'Refresh',
      'btn.graph': 'Usage graph',
      'btn.close': 'Close',
      'btn.dismiss': 'Dismiss',
      'btn.more': 'More',
      'btn.pin': 'Keep as a desktop widget',
      'btn.unpin': 'Back to the menu bar popover',
      'btn.cancel': 'Cancel',
      'hdr.checkedNow': 'checked just now',
      'hdr.checkedAgo': 'checked {age} ago',
      'hdr.switching': 'switching…',
      'hdr.refreshing': 'refreshing…',
      'banner.refreshFailed': 'Could not refresh: {message}',
      'loading.cswap': 'Looking for claude-swap…',
      'list.empty': 'No accounts',

      // Active account: rings, countdowns, expand rows
      'gauge.session': 'Session · 5 h',
      'gauge.weekly': 'Week · all models',
      'reset.at': 'resets at {time}',
      'reset.on': 'resets {date}',
      'timer.notStarted': 'Not started',
      'timer.notStartedHint': 'Starts with your first message',
      'timer.resetting': 'Resetting…',
      'pace.ahead': 'ahead · {expected}% expected',
      'hero.noActive': 'No active account',
      'hero.noActiveHint': 'Switch to one below',
      'hero.more': 'More limits',
      'model.week': '{name} · week',
      'extra.label': 'Extra usage',
      'spend.monthly': 'Monthly spend',
      'spend.of': '{used} of {limit}',

      // Durations (formatDuration, countdowns) and statistics durations
      'cd.seconds': '{s}s',
      'cd.minutes': '{m}m',
      'cd.hours': '{h}h {m}m',
      'cd.hoursOnly': '{h}h',
      'cd.days': '{d}d {h}h',
      'cd.daysOnly': '{d}d',
      'dur.hm': '{h} h {m} m',
      'dur.h': '{h} h',
      'dur.m': '{m} m',

      // Windows, percentages, rings (aria and tooltips), cards
      'win.5h': '5h',
      'win.7d': '7d',
      'win.pct': '{window} {pct}%',
      'fmt.pct': '{p}%',
      'ring.name.5h': '5-hour usage',
      'ring.name.7d': '7-day usage',
      'ring.aria.noData': '{name}: no data',
      'ring.aria.value': '{name}: {pct}%',
      'ring.aria.resetsIn': '{name}: {pct}%, resets in {time}',
      'ring.aria.hasReset': '{name}: {pct}%, window has reset',
      'ring.aria.outdated': '{text} (outdated)',
      'ring.now': '↻ now',
      'ring.tip.resetsIn': 'Resets in {time}',
      'ring.tip.hasReset': 'This window has reset; new usage arrives with the next refresh',
      'card.accountN': 'Account {n}',
      'card.switchTip': 'Switch Claude Code to {email}',
      'card.extra': 'Extra usage {used} of {limit}',
      'card.team': 'Team',
      'card.noUsage': 'No usage data yet',
      'card.noUsageHint': 'Use Claude Code with this account and its limits will appear here',
      'acct.actions': 'Actions for {name}',

      // Actions (buttons, footer, setup screens)
      'act.switch': 'Switch',
      'act.best': 'Switch to best account',
      'act.bestTip': 'Switch to the account with the most headroom (cswap switch --strategy best)',
      'act.next': 'Next',
      'act.nextTip': 'Next account in order (cswap switch)',
      'act.nextAvailableTip': 'Next account that still has quota left (cswap switch --strategy next-available)',
      'act.disable': 'Disable',
      'act.enable': 'Enable',
      'act.disableTip': 'Hold this account out of automatic switching; you can still switch to it by hand',
      'act.enableTip': 'Put this account back into automatic switching',
      'act.copy': 'Copy',
      'act.copied': 'Copied',
      'act.checkAgain': 'Check again',
      'act.usePath': 'Use cswap from PATH',
      'act.chooseBinary': 'Choose binary…',
      'act.installGuide': 'Install guide',

      // Badges (label and tooltip)
      'badge.active': 'Active',
      'badge.activeTip': 'The account Claude Code uses now',
      'badge.disabled': 'Disabled',
      'badge.disabledTip': 'Held out of auto-rotation',
      'badge.stale': 'Stale',
      'badge.staleAgo': 'Stale · {age} ago',
      'badge.staleTip': 'Showing the last good measurement',
      'badge.aged': '{age} ago',
      'badge.agedTip': 'Measured {age} ago; cswap re-measures each account on its own schedule',
      'badge.token_expired': 'Token expired',
      'badge.tip.token_expired': 'Claude Code refreshes it on next use; cswap retries automatically',
      'badge.relogin_required': 'Re-login',
      'badge.tip.relogin_required': 'Log in again in Claude Code, then run: cswap add',
      'badge.keychain_unavailable': 'Keychain locked',
      'badge.tip.keychain_unavailable': 'macOS Keychain could not be read',
      'badge.foreign_credential': 'Credential mismatch',
      'badge.tip.foreign_credential': 'Switching to this account repairs it',
      'badge.no_credentials': 'No credentials',
      'badge.tip.no_credentials': 'Log in again in Claude Code, then run: cswap add',
      'badge.api_key': 'API key',
      'badge.tip.api_key': 'API-key accounts have no subscription quota',
      'badge.unavailable': 'Usage unavailable',
      'badge.tip.unavailable': 'The usage API did not answer',
      'badge.pace': '7d ahead of pace',
      'badge.tip.pace': 'Used {pct}% — faster than an even pace to the weekly reset',
      'badge.tip.paceExpected': 'Used {pct}%; an even pace would be {expected}% by now',

      // Toasts and switch results (cswap `reason`)
      'toast.switchedTo': 'Switched to {name}',
      'toast.noSwitch': 'No switch needed',
      'toast.listChanged': '{message} — the account list had changed',
      'toast.switchFailed': 'Switch failed',
      'toast.disabled': '{name} is held out of auto-rotation',
      'toast.enabled': '{name} is back in the rotation',
      'toast.actionFailed': 'claude-swap could not do that',
      'toast.historyCleared': 'Usage history cleared',
      'reason.already-active': '{name} is already active',
      'reason.activated': 'Activated {name} from the stored backup',
      'reason.already-best': 'Already on the account with the most headroom',
      'reason.candidates-exhausted': 'All other accounts are at their limit — staying on {name}',
      'reason.no-valid-target': 'No other account has valid stored credentials',
      'reason.only-one-account': 'Only one account is managed — add more to switch',
      'reason.unmanaged-account': 'The active Claude Code login is not in claude-swap — run cswap add',
      'reason.usage-unavailable': 'Usage data is missing — staying on {name}',

      // Setup screens
      'setup.missing.title': 'Install claude-swap',
      'setup.missing.body': 'This app is a front end for claude-swap, which does the actual account switching. Install it with one of:',
      'setup.missing.tried': 'Tried: {path}',
      'setup.missing.searched': 'Searched {dirs}',
      'setup.badPath.title': 'cswap not found at the chosen path',
      'setup.badPath.body': 'The binary picked with “{button}” was moved, uninstalled, or is not an executable file:',
      'setup.tooOld.title': 'Update claude-swap',
      'setup.tooOld.body': 'claude-swap {version} is too old for this app (needs {min} or newer). Upgrade it with the tool you installed it with:',
      'setup.tooOld.bodyUnknown': 'The installed claude-swap is too old for this app. Upgrade it with the tool you installed it with:',
      'setup.noAccounts.title': 'No accounts yet',
      'setup.noAccounts.body': 'Log in to Claude Code with an account, then register it with claude-swap. Repeat for each account:',
      'setup.error.title': 'claude-swap failed',
      'setup.error.unknown': 'Unknown error',

      // Errors (by `error.kind`; cswap's own message goes in the tooltip)
      'err.notAvailable': 'claude-swap is not available',
      'err.spawn': 'cswap could not be started ({code})',
      'err.timeout': 'cswap did not answer in time',
      'err.badOutput': 'cswap returned unexpected output',
      'err.schema': 'This cswap uses a newer format (schemaVersion {v}); update the app',
      'err.stopped': 'cswap was stopped by {signal}',
      'err.exitCode': 'cswap exited with code {code}',
      'err.accountGone': 'That account is no longer in claude-swap; the list has been refreshed',
      'err.invalidTarget': 'Invalid switch target',
      'err.invalidAccount': 'Invalid account',

      // Tray tooltip and menu lines
      'trayTip.loading': 'Claude accounts — loading…',
      'trayTip.setup': 'claude-swap needs setup',
      'trayTip.noAccounts': 'No accounts in claude-swap yet',
      'trayTip.noActive': 'No active account',
      'trayTip.error': 'claude-swap: {message}',
      'trayTip.windowReset': '{window} window has reset, waiting for new data',
      'trayTip.ahead': '(ahead of pace)',
      'trayTip.notUpdatedFor': 'not updated for {age}',
      'trayTip.notUpdated': 'not updated',
      'trayTip.stale': 'stale',
      'trayTip.old': '{age} old',
      'trayTip.session': 'Session: {pct}%',
      'trayTip.week': 'Week: {pct}%',
      'menuLine.reset': '{window} reset',
      'menuLine.ahead': '(ahead)',
      'menuLine.disabled': 'disabled',
      'menuLine.stale': 'stale',
      'menuLine.token_expired': 'token expired',
      'menuLine.relogin_required': 're-login',
      'menuLine.keychain_unavailable': 'keychain locked',
      'menuLine.foreign_credential': 'credential mismatch',
      'menuLine.no_credentials': 'no credentials',
      'menuLine.api_key': 'API key',
      'menuLine.unavailable': 'usage unavailable',

      // Tray menu
      'menu.next': 'Switch to Next',
      'menu.best': 'Switch to Best',
      'menu.nextAvailable': 'Next Available',
      'menu.toggleAccount': 'Disable / Enable Account',
      'menu.add': 'Add Account…',
      'menu.remove': 'Remove Account',
      'menu.log': 'Open cswap Log',
      'menu.stats': 'Statistics…',
      'menu.about': 'About {app}',
      'menu.refreshNow': 'Refresh Now',
      'menu.quit': 'Quit',
      'acct.menu.switch': 'Switch to This Account',
      'acct.menu.inRotation': 'In Rotation',
      'acct.menu.stats': 'Show Statistics',
      'acct.menu.copyEmail': 'Copy Email',
      'acct.menu.remove': 'Remove Account…',

      // Settings submenu
      'settings.title': 'Settings',
      'settings.done': 'Done',
      'settings.disclaimer': 'Unofficial · not by Anthropic',
      'settings.version': 'Version {v}',
      'settings.language': 'Language',
      'lang.system': 'System',
      'settings.theme': 'Appearance',
      'theme.system': 'System',
      'theme.light': 'Light',
      'theme.dark': 'Dark',
      'settings.menuBar': 'Menu Bar',
      'set.menuBar.style': 'Style',
      'tray.classic': 'Classic',
      'tray.ring': 'Ring and Numbers',
      'tray.bars': 'Two Bars',
      'tray.rings': 'Double Ring',
      'tray.ringsText': 'Double Ring and Numbers',
      'set.menuBar.percentage': 'Percentage',
      'set.menuBar.showName': 'Show Account Name',
      'set.showName': 'Show Account Name in Menu Bar',
      'set.titleMode': 'Menu Bar Percentage',
      'set.titleMode.5h': 'Session (5h)',
      'set.titleMode.7d': 'Weekly (7d)',
      'set.titleMode.both': 'Both (5h · 7d)',
      'set.titleMode.max': 'Highest',
      'set.titleMode.off': 'None',
      'settings.rings': 'Rings',
      'rings.side': 'Side by Side',
      'rings.nested': 'Ring in Ring',
      'settings.time': 'Time',
      'time.system': 'System',
      'time.12': '12-hour (3:59 PM)',
      'time.24': '24-hour (15:59)',
      'settings.date': 'Weekly Reset Date',
      'settings.refresh': 'Refresh Every',
      'refresh.30': '30 seconds',
      'refresh.60': '1 minute',
      'refresh.120': '2 minutes',
      'refresh.300': '5 minutes',
      'settings.alerts': 'Notifications',
      'set.recordHistory': 'Keep Usage History',
      'set.clearHistory': 'Clear Usage History…',
      'set.window': 'Window',
      'set.window.popover': 'Menu Bar Popover',
      'set.window.widget': 'Desktop Widget',
      'set.window.onTop': 'Keep Widget on Top',
      'set.launch': 'Open at Login',
      'set.chooseBinary': 'Choose cswap Binary…',
      'settings.stats': 'Statistics',

      // About, dialogs
      'about.credits': 'Design based on Claude Usage Widget by Slavomir Durej and The Maestro',
      'about.cswap': 'Account switching by claude-swap (Onur Cetinkol)',
      'dlg.add.title': 'Add an account',
      'dlg.add.detail': 'Log in to Claude Code with the account, then run this in Terminal:',
      'dlg.remove.title': 'Remove Account-{n}',
      'dlg.remove.detail': 'claude-swap asks for confirmation before it forgets {email}. Run this in Terminal:',
      'dlg.copyCommand': 'Copy Command',
      'dlg.noLog': 'No claude-swap log yet',
      'dlg.chooseTitle': 'Choose the cswap executable',
      'dlg.chooseHint': 'Usually ~/.local/bin/cswap (uv or pipx) or /opt/homebrew/bin/cswap',
      'dlg.notExecutable': 'Not an executable file',
      'dlg.cannotStart': 'Claude accounts cannot start',
      'dlg.cannotStart.detail': 'The settings folder is not writable:\n{dir}\n\n{problem}\n\nFix its ownership (for example: sudo chown -R "$USER" "{dir}") and start the app again.',
      'dlg.clearHistory.title': 'Clear usage history?',
      'dlg.clearHistory.detail': 'The statistics of every account on this Mac will be deleted. This cannot be undone.',
      'dlg.clearHistory.confirm': 'Clear History',

      // Notifications (active account only; the title is app.title)
      'notify.sessionWarn': '{name}: session at {p}% — running low',
      'notify.sessionDanger': '{name}: session at {p}% — almost out',
      'notify.weeklyWarn': '{name}: week at {p}% — running low',
      'notify.weeklyDanger': '{name}: week at {p}% — almost out',
      'notify.sessionReached': '{name}: session limit reached',
      'notify.sessionReachedBody': 'Resets at {time}.',
      'notify.weeklyReached': '{name}: weekly limit reached',
      'notify.weeklyReachedBody': 'Resets {date} at {time}.',
      'notify.available': '{name} is available again',
      'notify.roomElsewhere': 'More headroom on {other} ({p}% used)',
      'notify.allExhausted': 'All accounts are at their limit',
      'notify.allExhaustedBody': 'Earliest reset: {name}, {when}',

      // Statistics
      'chart.session': 'Session',
      'chart.weekly': 'Week',
      'statsStyle.line': 'Line',
      'statsStyle.bars': 'Bars',
      'statsStyle.summary': 'Summary',
      'stats.day': 'Today',
      'stats.week': 'Week',
      'stats.month': 'Month',
      'stats.title.day': 'Today, by hour',
      'stats.title.week': 'Last 7 days',
      'stats.title.month': 'Last 30 days',
      'stats.peak': 'Peak',
      'stats.average': 'Average',
      'stats.nearLimit': 'Near limit',
      'stats.nearLimitTip': 'Time with the session limit at {pct}% or more',
      'stats.spend': 'Spend',
      'stats.inUse': 'In use',
      'stats.inUseTip': 'Time with usage rising on this account, from any machine',
      'stats.coverage': 'Recorded',
      'stats.coverageTip': 'Time covered by measurements; cswap measures each account every few minutes',
      'stats.busiestHour': 'Busiest hour',
      'stats.busiestDay': 'Busiest day',
      'stats.byHour': 'by hour',
      'stats.byDay': 'by day',
      'stats.noData': 'No data',
      'stats.empty': 'No data for this period yet',
      'stats.recording': 'History is recorded while the app runs',
      'stats.recordingSince': 'History is recorded while the app runs · since {date}',
      'stats.off': 'Usage history is turned off',
      'stats.account': 'Account',
      'stats.account.follow': 'Active account — {label}',
      'stats.account.gone': 'No longer in claude-swap',
    },
    ru: {
      // App chrome and header
      'app.title': 'Аккаунты Claude',
      'btn.settings': 'Настройки',
      'btn.refresh': 'Обновить',
      'btn.graph': 'График',
      'btn.close': 'Закрыть',
      'btn.dismiss': 'Скрыть',
      'btn.more': 'Ещё',
      'btn.pin': 'Оставить виджетом на рабочем столе',
      'btn.unpin': 'Вернуть в окно под строкой меню',
      'btn.cancel': 'Отменить',
      'hdr.checkedNow': 'обновлено только что',
      'hdr.checkedAgo': 'обновлено {age} назад',
      'hdr.switching': 'переключаю…',
      'hdr.refreshing': 'обновляю…',
      'banner.refreshFailed': 'Не удалось обновить: {message}',
      'loading.cswap': 'Ищу claude-swap…',
      'list.empty': 'Аккаунтов нет',

      // Active account: rings, countdowns, expand rows
      'gauge.session': 'Сессия · 5 ч',
      'gauge.weekly': 'Неделя · все модели',
      'reset.at': 'обновится в {time}',
      'reset.on': 'обновится {date}',
      'timer.notStarted': 'Не начата',
      'timer.notStartedHint': 'Начнётся с первого сообщения',
      'timer.resetting': 'Обновляется…',
      'pace.ahead': 'опережает · ожидалось {expected}%',
      'hero.noActive': 'Нет активного аккаунта',
      'hero.noActiveHint': 'Переключитесь на один из аккаунтов ниже',
      'hero.more': 'Другие лимиты',
      'model.week': '{name} · неделя',
      'extra.label': 'Сверх лимита',
      'spend.monthly': 'Расходы за месяц',
      'spend.of': '{used} из {limit}',

      // Durations (formatDuration, countdowns) and statistics durations
      'cd.seconds': '{s} с',
      'cd.minutes': '{m} мин',
      'cd.hours': '{h} ч {m} мин',
      'cd.hoursOnly': '{h} ч',
      'cd.days': '{d} д {h} ч',
      'cd.daysOnly': '{d} д',
      'dur.hm': '{h} ч {m} мин',
      'dur.h': '{h} ч',
      'dur.m': '{m} мин',

      // Windows, percentages, rings (aria and tooltips), cards
      'win.5h': '5 ч',
      'win.7d': '7 дн',
      'win.pct': '{window} {pct}%',
      'fmt.pct': '{p}%',
      'ring.name.5h': 'Пятичасовой лимит',
      'ring.name.7d': 'Недельный лимит',
      'ring.aria.noData': '{name}: нет данных',
      'ring.aria.value': '{name}: {pct}%',
      'ring.aria.resetsIn': '{name}: {pct}%, обновится через {time}',
      'ring.aria.hasReset': '{name}: {pct}%, лимит уже обновился',
      'ring.aria.outdated': '{text} (устарело)',
      'ring.now': '↻ сейчас',
      'ring.tip.resetsIn': 'Обновится через {time}',
      'ring.tip.hasReset': 'Лимит уже обновился; новые цифры придут со следующей проверкой',
      'card.accountN': 'Аккаунт {n}',
      'card.switchTip': 'Переключить Claude Code на {email}',
      'card.extra': 'Сверх лимита: {used} из {limit}',
      'card.team': 'Команда',
      'card.noUsage': 'Данных о лимитах пока нет',
      'card.noUsageHint': 'Поработайте в Claude Code под этим аккаунтом — и здесь появятся лимиты',
      'acct.actions': 'Действия с аккаунтом {name}',

      // Actions (buttons, footer, setup screens)
      'act.switch': 'Переключиться',
      'act.best': 'На лучший аккаунт',
      'act.bestTip': 'Переключиться на аккаунт с наибольшим запасом лимита (cswap switch --strategy best)',
      'act.next': 'Следующий',
      'act.nextTip': 'Следующий по порядку аккаунт (cswap switch)',
      'act.nextAvailableTip': 'Следующий аккаунт, у которого ещё остался лимит (cswap switch --strategy next-available)',
      'act.disable': 'Отключить',
      'act.enable': 'Включить',
      'act.disableTip': 'Не выбирать этот аккаунт при автоматическом переключении; вручную на него по-прежнему можно переключиться',
      'act.enableTip': 'Снова учитывать этот аккаунт при автоматическом переключении',
      'act.copy': 'Копировать',
      'act.copied': 'Скопировано',
      'act.checkAgain': 'Проверить снова',
      'act.usePath': 'Использовать cswap из PATH',
      'act.chooseBinary': 'Выбрать файл…',
      'act.installGuide': 'Инструкция по установке',

      // Badges (label and tooltip)
      'badge.active': 'Активный',
      'badge.activeTip': 'Этот аккаунт сейчас использует Claude Code',
      'badge.disabled': 'Отключён',
      'badge.disabledTip': 'Не участвует в автопереключении',
      'badge.stale': 'Устарело',
      'badge.staleAgo': 'Устарело · {age} назад',
      'badge.staleTip': 'Показаны последние удачные данные',
      'badge.aged': '{age} назад',
      'badge.agedTip': 'Замер {age} назад: cswap обновляет каждый аккаунт по своему расписанию',
      'badge.token_expired': 'Токен истёк',
      'badge.tip.token_expired': 'Claude Code обновит его при следующем использовании, cswap повторит попытку сам',
      'badge.relogin_required': 'Нужен вход',
      'badge.tip.relogin_required': 'Войдите заново в Claude Code, затем выполните: cswap add',
      'badge.keychain_unavailable': 'Связка ключей недоступна',
      'badge.tip.keychain_unavailable': 'Не удалось прочитать связку ключей macOS',
      'badge.foreign_credential': 'Чужие данные входа',
      'badge.tip.foreign_credential': 'Текущие данные входа принадлежат другому аккаунту; переключение на этот аккаунт это исправит',
      'badge.no_credentials': 'Нет данных входа',
      'badge.tip.no_credentials': 'Войдите заново в Claude Code, затем выполните: cswap add',
      'badge.api_key': 'API-ключ',
      'badge.tip.api_key': 'У аккаунтов с API-ключом нет лимитов подписки',
      'badge.unavailable': 'Нет данных о лимитах',
      'badge.tip.unavailable': 'Сервер лимитов не ответил',
      'badge.pace': 'Неделя: опережает график',
      'badge.tip.pace': 'Израсходовано {pct}% — быстрее, чем при равномерном расходе до конца недели',
      'badge.tip.paceExpected': 'Израсходовано {pct}%, а при равномерном расходе было бы {expected}%',

      // Toasts and switch results (cswap `reason`)
      'toast.switchedTo': 'Переключено на {name}',
      'toast.noSwitch': 'Переключаться не нужно',
      'toast.listChanged': '{message} — список аккаунтов успел измениться',
      'toast.switchFailed': 'Не удалось переключиться',
      'toast.disabled': 'Аккаунт {name} исключён из автопереключения',
      'toast.enabled': 'Аккаунт {name} снова участвует в автопереключении',
      'toast.actionFailed': 'claude-swap не смог это выполнить',
      'toast.historyCleared': 'История лимитов очищена',
      'reason.already-active': '{name} — уже активный аккаунт',
      'reason.activated': 'Аккаунт {name} восстановлен из сохранённой копии',
      'reason.already-best': 'Вы уже на аккаунте с наибольшим запасом',
      'reason.candidates-exhausted': 'У всех остальных аккаунтов лимит исчерпан — остаёмся на {name}',
      'reason.no-valid-target': 'Ни у одного другого аккаунта нет рабочих данных входа',
      'reason.only-one-account': 'В claude-swap только один аккаунт — добавьте ещё, чтобы переключаться',
      'reason.unmanaged-account': 'Текущий вход в Claude Code не добавлен в claude-swap — выполните cswap add',
      'reason.usage-unavailable': 'Нет данных о лимитах — остаёмся на {name}',

      // Setup screens
      'setup.missing.title': 'Установите claude-swap',
      'setup.missing.body': 'Это приложение — оболочка для claude-swap: аккаунты переключает именно он. Установите его одной из команд:',
      'setup.missing.tried': 'Проверено: {path}',
      'setup.missing.searched': 'Где искали: {dirs}',
      'setup.badPath.title': 'cswap не найден по выбранному пути',
      'setup.badPath.body': 'Файл, выбранный кнопкой «{button}», перемещён, удалён или не является исполняемым:',
      'setup.tooOld.title': 'Обновите claude-swap',
      'setup.tooOld.body': 'Версия claude-swap {version} слишком старая для этого приложения (нужна {min} или новее). Обновите её тем же инструментом, которым устанавливали:',
      'setup.tooOld.bodyUnknown': 'Установленный claude-swap слишком старый для этого приложения. Обновите его тем же инструментом, которым устанавливали:',
      'setup.noAccounts.title': 'Аккаунтов пока нет',
      'setup.noAccounts.body': 'Войдите в Claude Code под нужным аккаунтом и добавьте его в claude-swap. Повторите для каждого аккаунта:',
      'setup.error.title': 'claude-swap завершился с ошибкой',
      'setup.error.unknown': 'Неизвестная ошибка',

      // Errors (by `error.kind`; cswap's own message goes in the tooltip)
      'err.notAvailable': 'claude-swap недоступен',
      'err.spawn': 'Не удалось запустить cswap ({code})',
      'err.timeout': 'cswap не ответил вовремя',
      'err.badOutput': 'cswap вернул непонятный ответ',
      'err.schema': 'Этот cswap отвечает в новом формате (schemaVersion {v}) — обновите приложение',
      'err.stopped': 'cswap остановлен сигналом {signal}',
      'err.exitCode': 'cswap завершился с кодом {code}',
      'err.accountGone': 'Этого аккаунта больше нет в claude-swap; список обновлён',
      'err.invalidTarget': 'Неверная цель переключения',
      'err.invalidAccount': 'Неверный аккаунт',

      // Tray tooltip and menu lines
      'trayTip.loading': 'Аккаунты Claude — загрузка…',
      'trayTip.setup': 'claude-swap нужно настроить',
      'trayTip.noAccounts': 'В claude-swap пока нет аккаунтов',
      'trayTip.noActive': 'Нет активного аккаунта',
      'trayTip.error': 'claude-swap: {message}',
      'trayTip.windowReset': '{window}: лимит обновился, ждём свежих данных',
      'trayTip.ahead': '(опережает график)',
      'trayTip.notUpdatedFor': 'не обновлялось {age}',
      'trayTip.notUpdated': 'не обновлено',
      'trayTip.stale': 'устарело',
      'trayTip.old': 'замер {age} назад',
      'trayTip.session': 'Сессия: {pct}%',
      'trayTip.week': 'Неделя: {pct}%',
      'menuLine.reset': '{window}: обновлён',
      'menuLine.ahead': '(опережает)',
      'menuLine.disabled': 'отключён',
      'menuLine.stale': 'устарело',
      'menuLine.token_expired': 'токен истёк',
      'menuLine.relogin_required': 'нужен вход',
      'menuLine.keychain_unavailable': 'связка ключей недоступна',
      'menuLine.foreign_credential': 'чужие данные входа',
      'menuLine.no_credentials': 'нет данных входа',
      'menuLine.api_key': 'API-ключ',
      'menuLine.unavailable': 'нет данных о лимитах',

      // Tray menu
      'menu.next': 'Следующий аккаунт',
      'menu.best': 'Лучший аккаунт',
      'menu.nextAvailable': 'Следующий свободный',
      'menu.toggleAccount': 'Отключить / включить аккаунт',
      'menu.add': 'Добавить аккаунт…',
      'menu.remove': 'Удалить аккаунт',
      'menu.log': 'Открыть журнал cswap',
      'menu.stats': 'Статистика…',
      'menu.about': 'О программе {app}',
      'menu.refreshNow': 'Обновить сейчас',
      'menu.quit': 'Завершить',
      'acct.menu.switch': 'Переключиться на этот аккаунт',
      'acct.menu.inRotation': 'Участвует в автопереключении',
      'acct.menu.stats': 'Показать статистику',
      'acct.menu.copyEmail': 'Скопировать email',
      'acct.menu.remove': 'Удалить аккаунт…',

      // Settings submenu
      'settings.title': 'Настройки',
      'settings.done': 'Готово',
      'settings.disclaimer': 'Неофициально · не от Anthropic',
      'settings.version': 'Версия {v}',
      'settings.language': 'Язык',
      'lang.system': 'Как в системе',
      'settings.theme': 'Тема',
      'theme.system': 'Как в системе',
      'theme.light': 'Светлая',
      'theme.dark': 'Тёмная',
      'settings.menuBar': 'Строка меню',
      'set.menuBar.style': 'Вид',
      'tray.classic': 'Классический',
      'tray.ring': 'Кольцо и цифры',
      'tray.bars': 'Две полоски',
      'tray.rings': 'Двойное кольцо',
      'tray.ringsText': 'Двойное кольцо и цифры',
      'set.menuBar.percentage': 'Процент',
      'set.menuBar.showName': 'Показывать имя аккаунта',
      'set.showName': 'Имя аккаунта в строке меню',
      'set.titleMode': 'Процент в строке меню',
      'set.titleMode.5h': 'Сессия (5 ч)',
      'set.titleMode.7d': 'Неделя (7 дн)',
      'set.titleMode.both': 'Оба (5 ч · 7 дн)',
      'set.titleMode.max': 'Наибольший',
      'set.titleMode.off': 'Не показывать',
      'settings.rings': 'Кольца',
      'rings.side': 'Рядом',
      'rings.nested': 'Кольцо в кольце',
      'settings.time': 'Время',
      'time.system': 'Как в системе',
      'time.12': '12 ч (3:59 PM)',
      'time.24': '24 ч (15:59)',
      'settings.date': 'Формат даты',
      'settings.refresh': 'Обновлять',
      'refresh.30': 'Каждые 30 с',
      'refresh.60': 'Каждую минуту',
      'refresh.120': 'Каждые 2 мин',
      'refresh.300': 'Каждые 5 мин',
      'settings.alerts': 'Уведомления',
      'set.recordHistory': 'Сохранять историю лимитов',
      'set.clearHistory': 'Очистить историю лимитов…',
      'set.window': 'Окно',
      'set.window.popover': 'Окно под строкой меню',
      'set.window.widget': 'Виджет на рабочем столе',
      'set.window.onTop': 'Виджет поверх других окон',
      'set.launch': 'Открывать при входе',
      'set.chooseBinary': 'Выбрать файл cswap…',
      'settings.stats': 'Статистика',

      // About, dialogs
      'about.credits': 'Дизайн на основе Claude Usage Widget Славомира Дурея и The Maestro',
      'about.cswap': 'Переключение аккаунтов — claude-swap (Onur Cetinkol)',
      'dlg.add.title': 'Добавление аккаунта',
      'dlg.add.detail': 'Войдите в Claude Code под этим аккаунтом, затем выполните в Терминале:',
      'dlg.remove.title': 'Удалить Account-{n}',
      'dlg.remove.detail': 'Перед тем как забыть {email}, claude-swap попросит подтверждение. Выполните в Терминале:',
      'dlg.copyCommand': 'Скопировать команду',
      'dlg.noLog': 'Журнала claude-swap пока нет',
      'dlg.chooseTitle': 'Выберите исполняемый файл cswap',
      'dlg.chooseHint': 'Обычно это ~/.local/bin/cswap (uv или pipx) или /opt/homebrew/bin/cswap',
      'dlg.notExecutable': 'Это не исполняемый файл',
      'dlg.cannotStart': 'Не удаётся запустить «Аккаунты Claude»',
      'dlg.cannotStart.detail': 'Папка настроек недоступна для записи:\n{dir}\n\n{problem}\n\nИсправьте владельца (например: sudo chown -R "$USER" "{dir}") и запустите приложение снова.',
      'dlg.clearHistory.title': 'Очистить историю лимитов?',
      'dlg.clearHistory.detail': 'Статистика всех аккаунтов на этом Mac будет удалена. Это действие нельзя отменить.',
      'dlg.clearHistory.confirm': 'Очистить',

      // Notifications (active account only; the title is app.title)
      'notify.sessionWarn': '{name}: сессия {p}% — лимит подходит к концу',
      'notify.sessionDanger': '{name}: сессия {p}% — лимит почти исчерпан',
      'notify.weeklyWarn': '{name}: неделя {p}% — лимит подходит к концу',
      'notify.weeklyDanger': '{name}: неделя {p}% — лимит почти исчерпан',
      'notify.sessionReached': '{name}: лимит сессии исчерпан',
      'notify.sessionReachedBody': 'Обновится в {time}.',
      'notify.weeklyReached': '{name}: недельный лимит исчерпан',
      'notify.weeklyReachedBody': 'Обновится {date} в {time}.',
      'notify.available': 'Аккаунт {name} снова доступен',
      'notify.roomElsewhere': 'Больше запаса у {other} (израсходовано {p}%)',
      'notify.allExhausted': 'У всех аккаунтов лимит исчерпан',
      'notify.allExhaustedBody': 'Раньше всех освободится {name}: {when}',

      // Statistics
      'chart.session': 'Сессия',
      'chart.weekly': 'Неделя',
      'statsStyle.line': 'Линия',
      'statsStyle.bars': 'Столбики',
      'statsStyle.summary': 'Сводка',
      'stats.day': 'Сегодня',
      'stats.week': 'Неделя',
      'stats.month': 'Месяц',
      'stats.title.day': 'Сегодня по часам',
      'stats.title.week': 'Последние 7 дней',
      'stats.title.month': 'Последние 30 дней',
      'stats.peak': 'Пик',
      'stats.average': 'Среднее',
      'stats.nearLimit': 'У лимита',
      'stats.nearLimitTip': 'Время, когда лимит сессии был израсходован на {pct}% и больше',
      'stats.spend': 'Расходы',
      'stats.inUse': 'В работе',
      'stats.inUseTip': 'Время, когда расход на этом аккаунте рос (с любого компьютера)',
      'stats.coverage': 'Записано',
      'stats.coverageTip': 'Время, покрытое замерами; cswap замеряет каждый аккаунт раз в несколько минут',
      'stats.busiestHour': 'Самый активный час',
      'stats.busiestDay': 'Самый активный день',
      'stats.byHour': 'по часам',
      'stats.byDay': 'по дням',
      'stats.noData': 'Нет данных',
      'stats.empty': 'Пока нет данных за этот период',
      'stats.recording': 'История записывается, пока приложение работает',
      'stats.recordingSince': 'История записывается, пока приложение работает · с {date}',
      'stats.off': 'История лимитов отключена',
      'stats.account': 'Аккаунт',
      'stats.account.follow': 'Активный аккаунт — {label}',
      'stats.account.gone': 'Больше нет в claude-swap',
    },
    uk: {
      // App chrome and header
      'app.title': 'Акаунти Claude',
      'btn.settings': 'Налаштування',
      'btn.refresh': 'Оновити',
      'btn.graph': 'Графік',
      'btn.close': 'Закрити',
      'btn.dismiss': 'Сховати',
      'btn.more': 'Більше',
      'btn.pin': 'Залишити віджетом на робочому столі',
      'btn.unpin': 'Повернути у вікно під рядком меню',
      'btn.cancel': 'Скасувати',
      'hdr.checkedNow': 'оновлено щойно',
      'hdr.checkedAgo': 'оновлено {age} тому',
      'hdr.switching': 'перемикаю…',
      'hdr.refreshing': 'оновлюю…',
      'banner.refreshFailed': 'Не вдалося оновити: {message}',
      'loading.cswap': 'Шукаю claude-swap…',
      'list.empty': 'Акаунтів немає',

      // Active account: rings, countdowns, expand rows
      'gauge.session': 'Сесія · 5 год',
      'gauge.weekly': 'Тиждень · усі моделі',
      'reset.at': 'оновиться о {time}',
      'reset.on': 'оновиться {date}',
      'timer.notStarted': 'Не розпочато',
      'timer.notStartedHint': 'Почнеться з першого повідомлення',
      'timer.resetting': 'Оновлюється…',
      'pace.ahead': 'випереджає · очікувалося {expected}%',
      'hero.noActive': 'Немає активного акаунта',
      'hero.noActiveHint': 'Перемкніться на один з акаунтів нижче',
      'hero.more': 'Інші ліміти',
      'model.week': '{name} · тиждень',
      'extra.label': 'Понад ліміт',
      'spend.monthly': 'Витрати за місяць',
      'spend.of': '{used} з {limit}',

      // Durations (formatDuration, countdowns) and statistics durations
      'cd.seconds': '{s} с',
      'cd.minutes': '{m} хв',
      'cd.hours': '{h} год {m} хв',
      'cd.hoursOnly': '{h} год',
      'cd.days': '{d} д {h} год',
      'cd.daysOnly': '{d} д',
      'dur.hm': '{h} год {m} хв',
      'dur.h': '{h} год',
      'dur.m': '{m} хв',

      // Windows, percentages, rings (aria and tooltips), cards
      'win.5h': '5 год',
      'win.7d': '7 дн',
      'win.pct': '{window} {pct}%',
      'fmt.pct': '{p}%',
      'ring.name.5h': 'Пʼятигодинний ліміт',
      'ring.name.7d': 'Тижневий ліміт',
      'ring.aria.noData': '{name}: немає даних',
      'ring.aria.value': '{name}: {pct}%',
      'ring.aria.resetsIn': '{name}: {pct}%, оновиться через {time}',
      'ring.aria.hasReset': '{name}: {pct}%, ліміт уже оновився',
      'ring.aria.outdated': '{text} (застаріло)',
      'ring.now': '↻ зараз',
      'ring.tip.resetsIn': 'Оновиться через {time}',
      'ring.tip.hasReset': 'Ліміт уже оновився; нові цифри прийдуть із наступною перевіркою',
      'card.accountN': 'Акаунт {n}',
      'card.switchTip': 'Перемкнути Claude Code на {email}',
      'card.extra': 'Понад ліміт: {used} з {limit}',
      'card.team': 'Команда',
      'card.noUsage': 'Даних про ліміти поки немає',
      'card.noUsageHint': 'Попрацюйте в Claude Code під цим акаунтом — і тут зʼявляться ліміти',
      'acct.actions': 'Дії з акаунтом {name}',

      // Actions (buttons, footer, setup screens)
      'act.switch': 'Перемкнутися',
      'act.best': 'На найкращий акаунт',
      'act.bestTip': 'Перемкнутися на акаунт із найбільшим запасом ліміту (cswap switch --strategy best)',
      'act.next': 'Наступний',
      'act.nextTip': 'Наступний за порядком акаунт (cswap switch)',
      'act.nextAvailableTip': 'Наступний акаунт, у якого ще лишився ліміт (cswap switch --strategy next-available)',
      'act.disable': 'Вимкнути',
      'act.enable': 'Увімкнути',
      'act.disableTip': 'Не вибирати цей акаунт під час автоматичного перемикання; вручну на нього, як і раніше, можна перемкнутися',
      'act.enableTip': 'Знову враховувати цей акаунт під час автоматичного перемикання',
      'act.copy': 'Копіювати',
      'act.copied': 'Скопійовано',
      'act.checkAgain': 'Перевірити ще раз',
      'act.usePath': 'Використовувати cswap із PATH',
      'act.chooseBinary': 'Вибрати файл…',
      'act.installGuide': 'Інструкція зі встановлення',

      // Badges (label and tooltip)
      'badge.active': 'Активний',
      'badge.activeTip': 'Цей акаунт зараз використовує Claude Code',
      'badge.disabled': 'Вимкнений',
      'badge.disabledTip': 'Не бере участі в автоперемиканні',
      'badge.stale': 'Застаріло',
      'badge.staleAgo': 'Застаріло · {age} тому',
      'badge.staleTip': 'Показано останні вдалі дані',
      'badge.aged': '{age} тому',
      'badge.agedTip': 'Виміряно {age} тому: cswap оновлює кожен акаунт за власним розкладом',
      'badge.token_expired': 'Токен прострочено',
      'badge.tip.token_expired': 'Claude Code оновить його під час наступного використання, cswap повторить спробу сам',
      'badge.relogin_required': 'Потрібен вхід',
      'badge.tip.relogin_required': 'Увійдіть знову в Claude Code, потім виконайте: cswap add',
      'badge.keychain_unavailable': 'Звʼязка ключів недоступна',
      'badge.tip.keychain_unavailable': 'Не вдалося прочитати звʼязку ключів macOS',
      'badge.foreign_credential': 'Чужі дані входу',
      'badge.tip.foreign_credential': 'Поточні дані входу належать іншому акаунту; перемикання на цей акаунт це виправить',
      'badge.no_credentials': 'Немає даних входу',
      'badge.tip.no_credentials': 'Увійдіть знову в Claude Code, потім виконайте: cswap add',
      'badge.api_key': 'API-ключ',
      'badge.tip.api_key': 'Акаунти з API-ключем не мають лімітів підписки',
      'badge.unavailable': 'Немає даних про ліміти',
      'badge.tip.unavailable': 'Сервер лімітів не відповів',
      'badge.pace': 'Тиждень: випереджає графік',
      'badge.tip.pace': 'Використано {pct}% — швидше, ніж за рівномірних витрат до кінця тижня',
      'badge.tip.paceExpected': 'Використано {pct}%, а за рівномірних витрат було б {expected}%',

      // Toasts and switch results (cswap `reason`)
      'toast.switchedTo': 'Перемкнуто на {name}',
      'toast.noSwitch': 'Перемикатися не потрібно',
      'toast.listChanged': '{message} — список акаунтів устиг змінитися',
      'toast.switchFailed': 'Не вдалося перемкнутися',
      'toast.disabled': 'Акаунт {name} виключено з автоперемикання',
      'toast.enabled': 'Акаунт {name} знову бере участь в автоперемиканні',
      'toast.actionFailed': 'claude-swap не зміг цього виконати',
      'toast.historyCleared': 'Історію лімітів очищено',
      'reason.already-active': '{name} — уже активний акаунт',
      'reason.activated': 'Акаунт {name} відновлено зі збереженої копії',
      'reason.already-best': 'Ви вже на акаунті з найбільшим запасом',
      'reason.candidates-exhausted': 'В усіх інших акаунтів ліміт вичерпано — лишаємося на {name}',
      'reason.no-valid-target': 'Жоден інший акаунт не має робочих даних входу',
      'reason.only-one-account': 'У claude-swap лише один акаунт — додайте ще, щоб перемикатися',
      'reason.unmanaged-account': 'Поточний вхід у Claude Code не додано до claude-swap — виконайте cswap add',
      'reason.usage-unavailable': 'Немає даних про ліміти — лишаємося на {name}',

      // Setup screens
      'setup.missing.title': 'Встановіть claude-swap',
      'setup.missing.body': 'Цей застосунок — оболонка для claude-swap: акаунти перемикає саме він. Встановіть його однією з команд:',
      'setup.missing.tried': 'Перевірено: {path}',
      'setup.missing.searched': 'Де шукали: {dirs}',
      'setup.badPath.title': 'cswap не знайдено за вибраним шляхом',
      'setup.badPath.body': 'Файл, вибраний кнопкою «{button}», переміщено, видалено або він не є виконуваним:',
      'setup.tooOld.title': 'Оновіть claude-swap',
      'setup.tooOld.body': 'Версія claude-swap {version} застара для цього застосунку (потрібна {min} або новіша). Оновіть її тим самим інструментом, яким встановлювали:',
      'setup.tooOld.bodyUnknown': 'Встановлений claude-swap застарий для цього застосунку. Оновіть його тим самим інструментом, яким встановлювали:',
      'setup.noAccounts.title': 'Акаунтів поки немає',
      'setup.noAccounts.body': 'Увійдіть у Claude Code під потрібним акаунтом і додайте його до claude-swap. Повторіть для кожного акаунта:',
      'setup.error.title': 'claude-swap завершився з помилкою',
      'setup.error.unknown': 'Невідома помилка',

      // Errors (by `error.kind`; cswap's own message goes in the tooltip)
      'err.notAvailable': 'claude-swap недоступний',
      'err.spawn': 'Не вдалося запустити cswap ({code})',
      'err.timeout': 'cswap не відповів вчасно',
      'err.badOutput': 'cswap повернув незрозумілу відповідь',
      'err.schema': 'Цей cswap відповідає в новому форматі (schemaVersion {v}) — оновіть застосунок',
      'err.stopped': 'cswap зупинено сигналом {signal}',
      'err.exitCode': 'cswap завершився з кодом {code}',
      'err.accountGone': 'Цього акаунта вже немає в claude-swap; список оновлено',
      'err.invalidTarget': 'Неправильна ціль перемикання',
      'err.invalidAccount': 'Неправильний акаунт',

      // Tray tooltip and menu lines
      'trayTip.loading': 'Акаунти Claude — завантаження…',
      'trayTip.setup': 'claude-swap потрібно налаштувати',
      'trayTip.noAccounts': 'У claude-swap поки немає акаунтів',
      'trayTip.noActive': 'Немає активного акаунта',
      'trayTip.error': 'claude-swap: {message}',
      'trayTip.windowReset': '{window}: ліміт оновився, чекаємо свіжих даних',
      'trayTip.ahead': '(випереджає графік)',
      'trayTip.notUpdatedFor': 'не оновлювалося {age}',
      'trayTip.notUpdated': 'не оновлено',
      'trayTip.stale': 'застаріло',
      'trayTip.old': 'вимір {age} тому',
      'trayTip.session': 'Сесія: {pct}%',
      'trayTip.week': 'Тиждень: {pct}%',
      'menuLine.reset': '{window}: оновлено',
      'menuLine.ahead': '(випереджає)',
      'menuLine.disabled': 'вимкнений',
      'menuLine.stale': 'застаріло',
      'menuLine.token_expired': 'токен прострочено',
      'menuLine.relogin_required': 'потрібен вхід',
      'menuLine.keychain_unavailable': 'звʼязка ключів недоступна',
      'menuLine.foreign_credential': 'чужі дані входу',
      'menuLine.no_credentials': 'немає даних входу',
      'menuLine.api_key': 'API-ключ',
      'menuLine.unavailable': 'немає даних про ліміти',

      // Tray menu
      'menu.next': 'Наступний акаунт',
      'menu.best': 'Найкращий акаунт',
      'menu.nextAvailable': 'Наступний вільний',
      'menu.toggleAccount': 'Вимкнути / увімкнути акаунт',
      'menu.add': 'Додати акаунт…',
      'menu.remove': 'Видалити акаунт',
      'menu.log': 'Відкрити журнал cswap',
      'menu.stats': 'Статистика…',
      'menu.about': 'Про {app}',
      'menu.refreshNow': 'Оновити зараз',
      'menu.quit': 'Вийти',
      'acct.menu.switch': 'Перемкнутися на цей акаунт',
      'acct.menu.inRotation': 'Бере участь в автоперемиканні',
      'acct.menu.stats': 'Показати статистику',
      'acct.menu.copyEmail': 'Скопіювати email',
      'acct.menu.remove': 'Видалити акаунт…',

      // Settings submenu
      'settings.title': 'Налаштування',
      'settings.done': 'Готово',
      'settings.disclaimer': 'Неофіційно · не від Anthropic',
      'settings.version': 'Версія {v}',
      'settings.language': 'Мова',
      'lang.system': 'Як у системі',
      'settings.theme': 'Тема',
      'theme.system': 'Як у системі',
      'theme.light': 'Світла',
      'theme.dark': 'Темна',
      'settings.menuBar': 'Рядок меню',
      'set.menuBar.style': 'Вигляд',
      'tray.classic': 'Класичний',
      'tray.ring': 'Кільце і цифри',
      'tray.bars': 'Дві смужки',
      'tray.rings': 'Подвійне кільце',
      'tray.ringsText': 'Подвійне кільце і цифри',
      'set.menuBar.percentage': 'Відсоток',
      'set.menuBar.showName': 'Показувати імʼя акаунта',
      'set.showName': 'Імʼя акаунта в рядку меню',
      'set.titleMode': 'Відсоток у рядку меню',
      'set.titleMode.5h': 'Сесія (5 год)',
      'set.titleMode.7d': 'Тиждень (7 дн)',
      'set.titleMode.both': 'Обидва (5 год · 7 дн)',
      'set.titleMode.max': 'Найбільший',
      'set.titleMode.off': 'Не показувати',
      'settings.rings': 'Кільця',
      'rings.side': 'Поруч',
      'rings.nested': 'Кільце в кільці',
      'settings.time': 'Час',
      'time.system': 'Як у системі',
      'time.12': '12 год (3:59 PM)',
      'time.24': '24 год (15:59)',
      'settings.date': 'Формат дати',
      'settings.refresh': 'Оновлювати',
      'refresh.30': 'Кожні 30 с',
      'refresh.60': 'Щохвилини',
      'refresh.120': 'Кожні 2 хв',
      'refresh.300': 'Кожні 5 хв',
      'settings.alerts': 'Сповіщення',
      'set.recordHistory': 'Зберігати історію лімітів',
      'set.clearHistory': 'Очистити історію лімітів…',
      'set.window': 'Вікно',
      'set.window.popover': 'Вікно під рядком меню',
      'set.window.widget': 'Віджет на робочому столі',
      'set.window.onTop': 'Віджет поверх інших вікон',
      'set.launch': 'Відкривати під час входу',
      'set.chooseBinary': 'Вибрати файл cswap…',
      'settings.stats': 'Статистика',

      // About, dialogs
      'about.credits': 'Дизайн на основі Claude Usage Widget Славомира Дурея та The Maestro',
      'about.cswap': 'Перемикання акаунтів — claude-swap (Onur Cetinkol)',
      'dlg.add.title': 'Додавання акаунта',
      'dlg.add.detail': 'Увійдіть у Claude Code під цим акаунтом, потім виконайте в Терміналі:',
      'dlg.remove.title': 'Видалити Account-{n}',
      'dlg.remove.detail': 'Перш ніж забути {email}, claude-swap попросить підтвердження. Виконайте в Терміналі:',
      'dlg.copyCommand': 'Скопіювати команду',
      'dlg.noLog': 'Журналу claude-swap поки немає',
      'dlg.chooseTitle': 'Виберіть виконуваний файл cswap',
      'dlg.chooseHint': 'Зазвичай це ~/.local/bin/cswap (uv або pipx) чи /opt/homebrew/bin/cswap',
      'dlg.notExecutable': 'Це не виконуваний файл',
      'dlg.cannotStart': 'Не вдається запустити «Акаунти Claude»',
      'dlg.cannotStart.detail': 'Тека налаштувань недоступна для запису:\n{dir}\n\n{problem}\n\nВиправте власника (наприклад: sudo chown -R "$USER" "{dir}") і запустіть застосунок знову.',
      'dlg.clearHistory.title': 'Очистити історію лімітів?',
      'dlg.clearHistory.detail': 'Статистику всіх акаунтів на цьому Mac буде видалено. Цю дію не можна скасувати.',
      'dlg.clearHistory.confirm': 'Очистити',

      // Notifications (active account only; the title is app.title)
      'notify.sessionWarn': '{name}: сесія {p}% — ліміт закінчується',
      'notify.sessionDanger': '{name}: сесія {p}% — ліміт майже вичерпано',
      'notify.weeklyWarn': '{name}: тиждень {p}% — ліміт закінчується',
      'notify.weeklyDanger': '{name}: тиждень {p}% — ліміт майже вичерпано',
      'notify.sessionReached': '{name}: ліміт сесії вичерпано',
      'notify.sessionReachedBody': 'Оновиться о {time}.',
      'notify.weeklyReached': '{name}: тижневий ліміт вичерпано',
      'notify.weeklyReachedBody': 'Оновиться {date} о {time}.',
      'notify.available': 'Акаунт {name} знову доступний',
      'notify.roomElsewhere': 'Більше запасу в {other} (використано {p}%)',
      'notify.allExhausted': 'В усіх акаунтів ліміт вичерпано',
      'notify.allExhaustedBody': 'Найраніше звільниться {name}: {when}',

      // Statistics
      'chart.session': 'Сесія',
      'chart.weekly': 'Тиждень',
      'statsStyle.line': 'Лінія',
      'statsStyle.bars': 'Стовпчики',
      'statsStyle.summary': 'Зведення',
      'stats.day': 'Сьогодні',
      'stats.week': 'Тиждень',
      'stats.month': 'Місяць',
      'stats.title.day': 'Сьогодні по годинах',
      'stats.title.week': 'Останні 7 днів',
      'stats.title.month': 'Останні 30 днів',
      'stats.peak': 'Пік',
      'stats.average': 'Середнє',
      'stats.nearLimit': 'Біля ліміту',
      'stats.nearLimitTip': 'Час, коли ліміт сесії було використано на {pct}% і більше',
      'stats.spend': 'Витрати',
      'stats.inUse': 'У роботі',
      'stats.inUseTip': 'Час, коли витрати на цьому акаунті зростали (з будь-якого компʼютера)',
      'stats.coverage': 'Записано',
      'stats.coverageTip': 'Час, охоплений вимірами; cswap вимірює кожен акаунт раз на кілька хвилин',
      'stats.busiestHour': 'Найактивніша година',
      'stats.busiestDay': 'Найактивніший день',
      'stats.byHour': 'по годинах',
      'stats.byDay': 'по днях',
      'stats.noData': 'Немає даних',
      'stats.empty': 'Поки немає даних за цей період',
      'stats.recording': 'Історія записується, поки працює застосунок',
      'stats.recordingSince': 'Історія записується, поки працює застосунок · з {date}',
      'stats.off': 'Історію лімітів вимкнено',
      'stats.account': 'Акаунт',
      'stats.account.follow': 'Активний акаунт — {label}',
      'stats.account.gone': 'Більше немає в claude-swap',
    },
    de: {
      // App chrome and header
      'app.title': 'Claude-Konten',
      'btn.settings': 'Einstellungen',
      'btn.refresh': 'Aktualisieren',
      'btn.graph': 'Verlauf',
      'btn.close': 'Schließen',
      'btn.dismiss': 'Ausblenden',
      'btn.more': 'Mehr',
      'btn.pin': 'Als Schreibtisch-Widget behalten',
      'btn.unpin': 'Zurück ins Fenster unter der Menüleiste',
      'btn.cancel': 'Abbrechen',
      'hdr.checkedNow': 'gerade aktualisiert',
      'hdr.checkedAgo': 'aktualisiert vor {age}',
      'hdr.switching': 'wechsle…',
      'hdr.refreshing': 'aktualisiere…',
      'banner.refreshFailed': 'Aktualisierung fehlgeschlagen: {message}',
      'loading.cswap': 'Suche claude-swap…',
      'list.empty': 'Keine Konten',

      // Active account: rings, countdowns, expand rows
      'gauge.session': 'Sitzung · 5 Std.',
      'gauge.weekly': 'Woche · alle Modelle',
      'reset.at': 'Reset um {time}',
      'reset.on': 'Reset {date}',
      'timer.notStarted': 'Nicht gestartet',
      'timer.notStartedHint': 'Beginnt mit deiner ersten Nachricht',
      'timer.resetting': 'Wird zurückgesetzt…',
      'pace.ahead': 'über Plan · erwartet {expected} %',
      'hero.noActive': 'Kein aktives Konto',
      'hero.noActiveHint': 'Wechsle unten zu einem Konto',
      'hero.more': 'Weitere Limits',
      'model.week': '{name} · Woche',
      'extra.label': 'Zusatznutzung',
      'spend.monthly': 'Ausgaben im Monat',
      'spend.of': '{used} von {limit}',

      // Durations (formatDuration, countdowns) and statistics durations
      'cd.seconds': '{s} Sek.',
      'cd.minutes': '{m} Min.',
      'cd.hours': '{h} Std. {m} Min.',
      'cd.hoursOnly': '{h} Std.',
      'cd.days': '{d} T {h} Std.',
      'cd.daysOnly': '{d} T',
      'dur.hm': '{h} Std. {m} Min.',
      'dur.h': '{h} Std.',
      'dur.m': '{m} Min.',

      // Windows, percentages, rings (aria and tooltips), cards
      'win.5h': '5 Std.',
      'win.7d': '7 T',
      'win.pct': '{window} {pct} %',
      'fmt.pct': '{p} %',
      'ring.name.5h': '5-Stunden-Limit',
      'ring.name.7d': 'Wochenlimit',
      'ring.aria.noData': '{name}: keine Daten',
      'ring.aria.value': '{name}: {pct} %',
      'ring.aria.resetsIn': '{name}: {pct} %, Reset in {time}',
      'ring.aria.hasReset': '{name}: {pct} %, Limit bereits zurückgesetzt',
      'ring.aria.outdated': '{text} (veraltet)',
      'ring.now': '↻ jetzt',
      'ring.tip.resetsIn': 'Reset in {time}',
      'ring.tip.hasReset': 'Das Limit wurde bereits zurückgesetzt; neue Werte kommen mit der nächsten Abfrage',
      'card.accountN': 'Konto {n}',
      'card.switchTip': 'Claude Code auf {email} umstellen',
      'card.extra': 'Zusatznutzung: {used} von {limit}',
      'card.team': 'Team',
      'card.noUsage': 'Noch keine Nutzungsdaten',
      'card.noUsageHint': 'Nutze Claude Code mit diesem Konto – dann erscheinen hier seine Limits',
      'acct.actions': 'Aktionen für {name}',

      // Actions (buttons, footer, setup screens)
      'act.switch': 'Wechseln',
      'act.best': 'Zum besten Konto wechseln',
      'act.bestTip': 'Zum Konto mit dem meisten Spielraum wechseln (cswap switch --strategy best)',
      'act.next': 'Nächstes',
      'act.nextTip': 'Nächstes Konto der Reihe nach (cswap switch)',
      'act.nextAvailableTip': 'Nächstes Konto mit freiem Kontingent (cswap switch --strategy next-available)',
      'act.disable': 'Deaktivieren',
      'act.enable': 'Aktivieren',
      'act.disableTip': 'Dieses Konto beim automatischen Wechseln auslassen; manuell geht es weiterhin',
      'act.enableTip': 'Dieses Konto wieder automatisch berücksichtigen',
      'act.copy': 'Kopieren',
      'act.copied': 'Kopiert',
      'act.checkAgain': 'Erneut prüfen',
      'act.usePath': 'cswap aus PATH verwenden',
      'act.chooseBinary': 'Programm wählen…',
      'act.installGuide': 'Installationsanleitung',

      // Badges (label and tooltip)
      'badge.active': 'Aktiv',
      'badge.activeTip': 'Dieses Konto nutzt Claude Code gerade',
      'badge.disabled': 'Deaktiviert',
      'badge.disabledTip': 'Vom automatischen Wechsel ausgenommen',
      'badge.stale': 'Veraltet',
      'badge.staleAgo': 'Veraltet · vor {age}',
      'badge.staleTip': 'Letzte gültige Messung wird angezeigt',
      'badge.aged': 'vor {age}',
      'badge.agedTip': 'Vor {age} gemessen; cswap misst jedes Konto nach eigenem Zeitplan neu',
      'badge.token_expired': 'Token abgelaufen',
      'badge.tip.token_expired': 'Claude Code erneuert es bei der nächsten Nutzung; cswap versucht es selbst erneut',
      'badge.relogin_required': 'Anmeldung nötig',
      'badge.tip.relogin_required': 'Melde dich in Claude Code neu an und führe dann aus: cswap add',
      'badge.keychain_unavailable': 'Schlüsselbund gesperrt',
      'badge.tip.keychain_unavailable': 'Der macOS-Schlüsselbund konnte nicht gelesen werden',
      'badge.foreign_credential': 'Fremde Anmeldedaten',
      'badge.tip.foreign_credential': 'Die aktuellen Anmeldedaten gehören zu einem anderen Konto; ein Wechsel zu diesem Konto behebt das',
      'badge.no_credentials': 'Keine Anmeldedaten',
      'badge.tip.no_credentials': 'Melde dich in Claude Code neu an und führe dann aus: cswap add',
      'badge.api_key': 'API-Schlüssel',
      'badge.tip.api_key': 'Konten mit API-Schlüssel haben kein Abo-Kontingent',
      'badge.unavailable': 'Keine Nutzungsdaten',
      'badge.tip.unavailable': 'Die Nutzungs-API hat nicht geantwortet',
      'badge.pace': 'Woche: über Plan',
      'badge.tip.pace': '{pct} % verbraucht – schneller als bei gleichmäßiger Nutzung bis zum Wochen-Reset',
      'badge.tip.paceExpected': '{pct} % verbraucht; bei gleichmäßiger Nutzung wären es jetzt {expected} %',

      // Toasts and switch results (cswap `reason`)
      'toast.switchedTo': 'Gewechselt zu {name}',
      'toast.noSwitch': 'Kein Wechsel nötig',
      'toast.listChanged': '{message} – die Kontenliste hatte sich geändert',
      'toast.switchFailed': 'Wechsel fehlgeschlagen',
      'toast.disabled': 'Konto {name} ist vom automatischen Wechsel ausgenommen',
      'toast.enabled': 'Konto {name} ist wieder in der Rotation',
      'toast.actionFailed': 'claude-swap konnte das nicht ausführen',
      'toast.historyCleared': 'Nutzungsverlauf gelöscht',
      'reason.already-active': '{name} ist bereits aktiv',
      'reason.activated': '{name} aus der gespeicherten Kopie aktiviert',
      'reason.already-best': 'Du bist bereits auf dem Konto mit dem meisten Spielraum',
      'reason.candidates-exhausted': 'Alle anderen Konten sind am Limit – {name} bleibt aktiv',
      'reason.no-valid-target': 'Kein anderes Konto hat gültige gespeicherte Anmeldedaten',
      'reason.only-one-account': 'claude-swap verwaltet nur ein Konto – füge weitere hinzu, um zu wechseln',
      'reason.unmanaged-account': 'Die aktive Claude-Code-Anmeldung ist nicht in claude-swap – führe cswap add aus',
      'reason.usage-unavailable': 'Keine Nutzungsdaten – {name} bleibt aktiv',

      // Setup screens
      'setup.missing.title': 'claude-swap installieren',
      'setup.missing.body': 'Diese App ist eine Oberfläche für claude-swap, das die Konten tatsächlich wechselt. Installiere es mit einem dieser Befehle:',
      'setup.missing.tried': 'Geprüft: {path}',
      'setup.missing.searched': 'Gesucht in: {dirs}',
      'setup.badPath.title': 'cswap am gewählten Pfad nicht gefunden',
      'setup.badPath.body': 'Die mit „{button}“ gewählte Datei wurde verschoben, deinstalliert oder ist nicht ausführbar:',
      'setup.tooOld.title': 'claude-swap aktualisieren',
      'setup.tooOld.body': 'claude-swap {version} ist für diese App zu alt (benötigt {min} oder neuer). Aktualisiere es mit dem Werkzeug, mit dem du es installiert hast:',
      'setup.tooOld.bodyUnknown': 'Das installierte claude-swap ist für diese App zu alt. Aktualisiere es mit dem Werkzeug, mit dem du es installiert hast:',
      'setup.noAccounts.title': 'Noch keine Konten',
      'setup.noAccounts.body': 'Melde dich in Claude Code mit einem Konto an und registriere es dann bei claude-swap. Wiederhole das für jedes Konto:',
      'setup.error.title': 'claude-swap ist fehlgeschlagen',
      'setup.error.unknown': 'Unbekannter Fehler',

      // Errors (by `error.kind`; cswap's own message goes in the tooltip)
      'err.notAvailable': 'claude-swap ist nicht verfügbar',
      'err.spawn': 'cswap konnte nicht gestartet werden ({code})',
      'err.timeout': 'cswap hat nicht rechtzeitig geantwortet',
      'err.badOutput': 'cswap hat eine unerwartete Antwort geliefert',
      'err.schema': 'Dieses cswap nutzt ein neueres Format (schemaVersion {v}) – bitte die App aktualisieren',
      'err.stopped': 'cswap wurde durch {signal} beendet',
      'err.exitCode': 'cswap wurde mit Code {code} beendet',
      'err.accountGone': 'Dieses Konto ist nicht mehr in claude-swap; die Liste wurde aktualisiert',
      'err.invalidTarget': 'Ungültiges Wechselziel',
      'err.invalidAccount': 'Ungültiges Konto',

      // Tray tooltip and menu lines
      'trayTip.loading': 'Claude-Konten – wird geladen…',
      'trayTip.setup': 'claude-swap muss eingerichtet werden',
      'trayTip.noAccounts': 'Noch keine Konten in claude-swap',
      'trayTip.noActive': 'Kein aktives Konto',
      'trayTip.error': 'claude-swap: {message}',
      'trayTip.windowReset': '{window}: Limit zurückgesetzt, warte auf neue Daten',
      'trayTip.ahead': '(über Plan)',
      'trayTip.notUpdatedFor': 'seit {age} nicht aktualisiert',
      'trayTip.notUpdated': 'nicht aktualisiert',
      'trayTip.stale': 'veraltet',
      'trayTip.old': 'vor {age} gemessen',
      'trayTip.session': 'Sitzung: {pct} %',
      'trayTip.week': 'Woche: {pct} %',
      'menuLine.reset': '{window}: zurückgesetzt',
      'menuLine.ahead': '(über Plan)',
      'menuLine.disabled': 'deaktiviert',
      'menuLine.stale': 'veraltet',
      'menuLine.token_expired': 'Token abgelaufen',
      'menuLine.relogin_required': 'Anmeldung nötig',
      'menuLine.keychain_unavailable': 'Schlüsselbund gesperrt',
      'menuLine.foreign_credential': 'fremde Anmeldedaten',
      'menuLine.no_credentials': 'keine Anmeldedaten',
      'menuLine.api_key': 'API-Schlüssel',
      'menuLine.unavailable': 'keine Nutzungsdaten',

      // Tray menu
      'menu.next': 'Zum nächsten Konto',
      'menu.best': 'Zum besten Konto',
      'menu.nextAvailable': 'Zum nächsten freien Konto',
      'menu.toggleAccount': 'Konto deaktivieren / aktivieren',
      'menu.add': 'Konto hinzufügen…',
      'menu.remove': 'Konto entfernen',
      'menu.log': 'cswap-Protokoll öffnen',
      'menu.stats': 'Statistik…',
      'menu.about': 'Über {app}',
      'menu.refreshNow': 'Jetzt aktualisieren',
      'menu.quit': 'Beenden',
      'acct.menu.switch': 'Zu diesem Konto wechseln',
      'acct.menu.inRotation': 'In der Rotation',
      'acct.menu.stats': 'Statistik anzeigen',
      'acct.menu.copyEmail': 'E-Mail kopieren',
      'acct.menu.remove': 'Konto entfernen…',

      // Settings submenu
      'settings.title': 'Einstellungen',
      'settings.done': 'Fertig',
      'settings.disclaimer': 'Inoffiziell · nicht von Anthropic',
      'settings.version': 'Version {v}',
      'settings.language': 'Sprache',
      'lang.system': 'Systemsprache',
      'settings.theme': 'Darstellung',
      'theme.system': 'Wie im System',
      'theme.light': 'Hell',
      'theme.dark': 'Dunkel',
      'settings.menuBar': 'Menüleiste',
      'set.menuBar.style': 'Stil',
      'tray.classic': 'Klassisch',
      'tray.ring': 'Ring und Zahlen',
      'tray.bars': 'Zwei Balken',
      'tray.rings': 'Doppelring',
      'tray.ringsText': 'Doppelring und Zahlen',
      'set.menuBar.percentage': 'Prozentwert',
      'set.menuBar.showName': 'Kontonamen anzeigen',
      'set.showName': 'Kontoname in der Menüleiste',
      'set.titleMode': 'Prozent in der Menüleiste',
      'set.titleMode.5h': 'Sitzung (5 Std.)',
      'set.titleMode.7d': 'Woche (7 T)',
      'set.titleMode.both': 'Beide (5 Std. · 7 T)',
      'set.titleMode.max': 'Höchster Wert',
      'set.titleMode.off': 'Aus',
      'settings.rings': 'Ringe',
      'rings.side': 'Nebeneinander',
      'rings.nested': 'Ring im Ring',
      'settings.time': 'Uhrzeit',
      'time.system': 'Wie im System',
      'time.12': '12 Std. (3:59 PM)',
      'time.24': '24 Std. (15:59)',
      'settings.date': 'Datumsformat',
      'settings.refresh': 'Aktualisieren',
      'refresh.30': 'Alle 30 s',
      'refresh.60': 'Jede Minute',
      'refresh.120': 'Alle 2 Min.',
      'refresh.300': 'Alle 5 Min.',
      'settings.alerts': 'Mitteilungen',
      'set.recordHistory': 'Nutzungsverlauf speichern',
      'set.clearHistory': 'Nutzungsverlauf löschen…',
      'set.window': 'Fenster',
      'set.window.popover': 'Fenster unter der Menüleiste',
      'set.window.widget': 'Schreibtisch-Widget',
      'set.window.onTop': 'Widget immer im Vordergrund',
      'set.launch': 'Beim Anmelden öffnen',
      'set.chooseBinary': 'cswap-Programm wählen…',
      'settings.stats': 'Statistik',

      // About, dialogs
      'about.credits': 'Design nach dem Claude Usage Widget von Slavomir Durej und The Maestro',
      'about.cswap': 'Kontowechsel: claude-swap von Onur Cetinkol',
      'dlg.add.title': 'Konto hinzufügen',
      'dlg.add.detail': 'Melde dich mit dem Konto in Claude Code an und führe dann im Terminal aus:',
      'dlg.remove.title': 'Account-{n} entfernen',
      'dlg.remove.detail': 'claude-swap fragt nach, bevor es {email} vergisst. Führe im Terminal aus:',
      'dlg.copyCommand': 'Befehl kopieren',
      'dlg.noLog': 'Noch kein claude-swap-Protokoll',
      'dlg.chooseTitle': 'cswap-Programmdatei auswählen',
      'dlg.chooseHint': 'Meist ~/.local/bin/cswap (uv oder pipx) oder /opt/homebrew/bin/cswap',
      'dlg.notExecutable': 'Keine ausführbare Datei',
      'dlg.cannotStart': '„Claude-Konten“ kann nicht starten',
      'dlg.cannotStart.detail': 'Der Einstellungsordner ist nicht beschreibbar:\n{dir}\n\n{problem}\n\nKorrigiere den Eigentümer (z. B.: sudo chown -R "$USER" "{dir}") und starte die App erneut.',
      'dlg.clearHistory.title': 'Nutzungsverlauf löschen?',
      'dlg.clearHistory.detail': 'Die Statistik aller Konten auf diesem Mac wird gelöscht. Das lässt sich nicht rückgängig machen.',
      'dlg.clearHistory.confirm': 'Löschen',

      // Notifications (active account only; the title is app.title)
      'notify.sessionWarn': '{name}: Sitzung bei {p} % – wird knapp',
      'notify.sessionDanger': '{name}: Sitzung bei {p} % – fast aufgebraucht',
      'notify.weeklyWarn': '{name}: Woche bei {p} % – wird knapp',
      'notify.weeklyDanger': '{name}: Woche bei {p} % – fast aufgebraucht',
      'notify.sessionReached': '{name}: Sitzungslimit erreicht',
      'notify.sessionReachedBody': 'Reset um {time}.',
      'notify.weeklyReached': '{name}: Wochenlimit erreicht',
      'notify.weeklyReachedBody': 'Reset am {date} um {time}.',
      'notify.available': '{name} ist wieder verfügbar',
      'notify.roomElsewhere': 'Mehr Spielraum bei {other} ({p} % verbraucht)',
      'notify.allExhausted': 'Alle Konten sind am Limit',
      'notify.allExhaustedBody': 'Als Erstes wieder frei: {name}, {when}',

      // Statistics
      'chart.session': 'Sitzung',
      'chart.weekly': 'Woche',
      'statsStyle.line': 'Linie',
      'statsStyle.bars': 'Balken',
      'statsStyle.summary': 'Übersicht',
      'stats.day': 'Heute',
      'stats.week': 'Woche',
      'stats.month': 'Monat',
      'stats.title.day': 'Heute, nach Stunden',
      'stats.title.week': 'Letzte 7 Tage',
      'stats.title.month': 'Letzte 30 Tage',
      'stats.peak': 'Spitze',
      'stats.average': 'Durchschnitt',
      'stats.nearLimit': 'Am Limit',
      'stats.nearLimitTip': 'Zeit, in der das Sitzungslimit bei {pct} % oder mehr lag',
      'stats.spend': 'Ausgaben',
      'stats.inUse': 'In Nutzung',
      'stats.inUseTip': 'Zeit, in der die Nutzung dieses Kontos stieg (von jedem Rechner aus)',
      'stats.coverage': 'Erfasst',
      'stats.coverageTip': 'Von Messungen abgedeckte Zeit; cswap misst jedes Konto alle paar Minuten',
      'stats.busiestHour': 'Aktivste Stunde',
      'stats.busiestDay': 'Aktivster Tag',
      'stats.byHour': 'nach Stunden',
      'stats.byDay': 'nach Tagen',
      'stats.noData': 'Keine Daten',
      'stats.empty': 'Für diesen Zeitraum gibt es noch keine Daten',
      'stats.recording': 'Der Verlauf wird aufgezeichnet, solange die App läuft',
      'stats.recordingSince': 'Der Verlauf wird aufgezeichnet, solange die App läuft · seit {date}',
      'stats.off': 'Der Nutzungsverlauf ist ausgeschaltet',
      'stats.account': 'Konto',
      'stats.account.follow': 'Aktives Konto – {label}',
      'stats.account.gone': 'Nicht mehr in claude-swap',
    },
  };

  const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'ru', name: 'Русский' },
    { code: 'uk', name: 'Українська' },
    { code: 'de', name: 'Deutsch' },
  ];
  const CODES = LANGUAGES.map((l) => l.code);
  // Formatting locale for a language when the system offers no better one.
  const LOCALES = { en: 'en-US', ru: 'ru-RU', uk: 'uk-UA', de: 'de-DE' };

  for (const code of CODES) Object.freeze(STRINGS[code]);
  Object.freeze(STRINGS);

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // t(key, vars) for one language: the string in that language, else in
  // English, else the key itself, so a missing string never shows up blank.
  // `{name}` is replaced by vars.name ('' when it is missing).
  const translators = {};
  function translator(lang) {
    const code = CODES.includes(lang) ? lang : 'en';
    if (translators[code]) return translators[code];
    const dict = STRINGS[code];
    const t = function (key, vars) {
      if (typeof key !== 'string') return '';
      const text = has(dict, key) ? dict[key] : has(STRINGS.en, key) ? STRINGS.en[key] : key;
      return vars ? text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? '')) : text;
    };
    t.lang = code;
    translators[code] = t;
    return t;
  }

  // "de-CH" → "de"; macOS may also hand over "en_US" or "de_CH@rg=chzzzz".
  function baseOf(tag) {
    return typeof tag === 'string' ? tag.trim().toLowerCase().split(/[-_@.]/)[0] : '';
  }

  function tagList(tags) {
    return (Array.isArray(tags) ? tags : [tags]).filter((tag) => typeof tag === 'string' && tag.trim());
  }

  // The UI language: an explicit choice wins; 'system' (or anything unknown)
  // takes the first preferred system language we have, else English.
  // systemTags: app.getPreferredSystemLanguages(), or [app.getLocale()].
  function resolveLanguage(pref, systemTags) {
    if (CODES.includes(pref)) return pref;
    for (const tag of tagList(systemTags)) {
      const base = baseOf(tag);
      if (CODES.includes(base)) return base;
    }
    return 'en';
  }

  // The locale that dates, times and money are formatted in: the system's
  // own tag when it is in the UI language (en-GB gives "2 Oct" and 24-hour
  // time), else the language's default (en → en-US).
  function resolveLocale(lang, systemTags) {
    const code = CODES.includes(lang) ? lang : 'en';
    for (const tag of tagList(systemTags)) {
      if (baseOf(tag) !== code) continue;
      const locale = canonicalLocale(tag);
      if (locale) return locale;
    }
    return LOCALES[code];
  }

  function canonicalLocale(tag) {
    try {
      const [locale] = Intl.getCanonicalLocales(tag.trim().replace(/@.*$/, '').replace(/_/g, '-'));
      return locale && Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : null;
    } catch {
      return null;
    }
  }

  // Intl formatters are slow to build and the UI asks for the same few again
  // and again (the 1 s countdown tick, every render), so keep them. A locale
  // Intl rejects falls back to en-US instead of throwing.
  const formatters = new Map();
  function dateFormat(locale, options) {
    const id = `${locale}|${JSON.stringify(options)}`;
    let f = formatters.get(id);
    if (!f) {
      try {
        f = new Intl.DateTimeFormat(locale, options);
      } catch {
        f = new Intl.DateTimeFormat(LOCALES.en, options);
      }
      formatters.set(id, f);
    }
    return f;
  }

  // 12-hour clock or not. timeFormat '12h' / '24h' is the user's choice;
  // 'system' (the default) asks the locale: en-US → 12 h, en-GB, ru, uk, de → 24 h.
  function hour12For(locale, timeFormat = 'system') {
    if (timeFormat === '12h') return true;
    if (timeFormat === '24h') return false;
    const o = dateFormat(locale, { hour: 'numeric' }).resolvedOptions();
    return o.hourCycle ? o.hourCycle === 'h11' || o.hourCycle === 'h12' : Boolean(o.hour12);
  }

  // hourCycle rather than hour12:false, which some ICU versions render as
  // "24:05" after midnight. 24-hour times are zero-padded ("09:05"), as
  // Maestro writes them and as ru/uk/de write times.
  function clockOptions(hour12) {
    return hour12
      ? { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  }

  function toDate(when) {
    const ms = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }

  // Time of day in local time: "15:59", "3:59 PM". `when` is an ISO string
  // (cswap's resetsAt, microseconds and all), epoch ms or a Date. hour12
  // undefined means the locale's habit. '' for anything unreadable.
  function formatClock(locale, when, hour12) {
    const d = toDate(when);
    if (!d) return '';
    return dateFormat(locale, clockOptions(typeof hour12 === 'boolean' ? hour12 : hour12For(locale))).format(d);
  }

  // A day as the language writes it, for the weekly reset (weeklyDateFormat):
  //   'date'          Oct 2            2 окт.            2. Okt.
  //   'date-day'      Fri, Oct 2       пт, 2 окт.        Fr., 2. Okt.
  //   'date-day-time' Fri, Oct 2, 3:59 PM   пт, 2 окт., 15:59   Fr., 2. Okt., 15:59
  // The weekday stays lowercase in ru/uk, which is right mid-sentence
  // ("обновится пт, 2 окт.").
  const DAY_OPTIONS = {
    date: { day: 'numeric', month: 'short' },
    'date-day': { weekday: 'short', day: 'numeric', month: 'short' },
  };
  function formatDay(locale, when, fmt = 'date', hour12) {
    const d = toDate(when);
    if (!d) return '';
    if (fmt === 'date-day-time') {
      const h12 = typeof hour12 === 'boolean' ? hour12 : hour12For(locale);
      return dateFormat(locale, { ...DAY_OPTIONS['date-day'], ...clockOptions(h12) }).format(d);
    }
    return dateFormat(locale, has(DAY_OPTIONS, fmt) ? DAY_OPTIONS[fmt] : DAY_OPTIONS.date).format(d);
  }

  // 45s, 12m, 2h 13m, 2h, 3d 4h, 3d — and "1 ч 30 мин", "1 год 30 хв",
  // "1 Std. 30 Min.". The English output is exactly Usage.formatDuration's.
  // `t` is a translator or a language code (English when left out).
  function formatDuration(t, seconds) {
    const tr = typeof t === 'function' ? t : translator(t);
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
    const s = Math.round(seconds);
    if (s < 60) return tr('cd.seconds', { s });
    const m = Math.floor(s / 60);
    if (m < 60) return tr('cd.minutes', { m });
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? tr('cd.hours', { h, m: m % 60 }) : tr('cd.hoursOnly', { h });
    const d = Math.floor(h / 24);
    return h % 24 ? tr('cd.days', { d, h: h % 24 }) : tr('cd.daysOnly', { d });
  }

  // cswap reports spend in currency units (12.4 = $12.40), not cents. Whole
  // amounts drop the decimals, so a limit reads "$50" next to "$12.40".
  // A currency code Intl does not know is written after the amount.
  function formatMoney(locale, amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
    const code = typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : 'USD';
    const whole = Number.isInteger(amount);
    const options = { style: 'currency', currency: code };
    if (whole) Object.assign(options, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    for (const loc of [locale, LOCALES.en]) {
      try {
        return new Intl.NumberFormat(loc, options).format(amount);
      } catch {
        // an unknown locale: try en-US; an unknown currency fails there too
      }
    }
    return `${whole ? amount : amount.toFixed(2)} ${code}`;
  }

  return {
    STRINGS,
    LANGUAGES,
    CODES,
    LOCALES,
    translator,
    resolveLanguage,
    resolveLocale,
    hour12For,
    formatClock,
    formatDay,
    formatDuration,
    formatMoney,
  };
});
