// Chat Logger — фоновый скрипт.
// 1) Клик по иконке -> команда content-скрипту на открытой вкладке.
// 2) Правый клик по иконке -> меню с настройками-галочками.
// 3) Приём заданий на скачивание файлов (content-скрипту API downloads недоступен).

// ---------- Настройки в меню по правому клику на иконке ----------

const SETTINGS = [
  { id: 'saveRawJson', title: 'Сохранять conversation.json (исходные данные чата)' },
  { id: 'showTime', title: 'Добавлять дату и время к сообщениям' },
];

// Меню создаём при установке/обновлении и при запуске браузера,
// галочки выставляем по сохранённым значениям (по умолчанию выключены).
async function buildMenu() {
  await chrome.contextMenus.removeAll();
  const saved = await chrome.storage.local.get(Object.fromEntries(SETTINGS.map((s) => [s.id, false])));
  for (const s of SETTINGS) {
    chrome.contextMenus.create({
      id: s.id,
      title: s.title,
      type: 'checkbox',
      checked: !!saved[s.id],
      contexts: ['action'],
    });
  }
}
chrome.runtime.onInstalled.addListener(buildMenu);
chrome.runtime.onStartup.addListener(buildMenu);

chrome.contextMenus.onClicked.addListener((info) => {
  if (SETTINGS.some((s) => s.id === info.menuItemId)) {
    chrome.storage.local.set({ [info.menuItemId]: !!info.checked });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const cmd = { cmd: 'save-dialog' };
  try {
    await chrome.tabs.sendMessage(tab.id, cmd);
  } catch (e) {
    // Вкладка была открыта до установки расширения — content-скрипта в ней ещё нет.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, cmd);
    } catch (e2) {
      // Не claude.ai — расширению здесь делать нечего.
    }
  }
});

// Ждём, пока загрузка завершится: download() сообщает только о старте,
// а ошибка сервера (например, 404) видна лишь по итоговому состоянию.
function waitForDownload(id) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (ok, error) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      // Неудачную попытку убираем из списка загрузок Chrome, чтобы не мусорить
      if (!ok) chrome.downloads.erase({ id }).catch(() => {});
      resolve(ok ? { ok: true, id } : { ok: false, error: error || 'загрузка прервана' });
    };
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') finish(true);
      else if (d.state.current === 'interrupted') finish(false, d.error && d.error.current);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // Маленькие файлы успевают завершиться до подписки — проверяем сразу
    chrome.downloads.search({ id }).then(([item]) => {
      if (!item) return;
      if (item.state === 'complete') finish(true);
      else if (item.state === 'interrupted') finish(false, item.error);
    });
  });
}

// content.js присылает {cmd:'download', url:<dataURL или https://claude.ai/...>, filename}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.cmd !== 'download') return;
  chrome.downloads
    .download({
      url: msg.url,
      filename: msg.filename,
      conflictAction: 'overwrite',
      saveAs: false,
    })
    .then(waitForDownload)
    .then(sendResponse, (e) =>
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) })
    );
  return true; // ответ придёт асинхронно
});
