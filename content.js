// Chat Logger — content-скрипт для claude.ai.
// Берёт диалог из внутреннего API сайта и сохраняет его в markdown:
//   Downloads/ChatLogs/<Название чата>/<Название чата>.md
//   Downloads/ChatLogs/<Название чата>/materials/<файлы из чата>
(() => {
  if (window.__chatLoggerLoaded) return;
  window.__chatLoggerLoaded = true;

  let running = false;

  // Настройки из меню по правому клику на иконке (хранит background.js)
  const DEFAULT_SETTINGS = { saveRawJson: false, showTime: false };
  async function getSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  // ---------- Вспомогательное ----------

  // Имена, которые Windows не даёт использовать для файлов и папок
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

  // Безопасное имя (без расширения): без запрещённых и управляющих символов,
  // без точек/пробелов по краям, не длиннее max символов (эмодзи не режутся).
  function safeName(raw, max, fallback) {
    let s = String(raw || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\/\\:*?"<>|#%&{}~]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    s = Array.from(s).slice(0, max).join('').replace(/^[\s.]+|[\s.]+$/g, '');
    if (RESERVED.test(s)) s = '_' + s;
    return s || fallback;
  }

  // Безопасное имя файла с сохранением расширения
  function safeFileName(raw, max = 80) {
    const s = String(raw || '').trim();
    const dot = s.lastIndexOf('.');
    let base = dot > 0 ? s.slice(0, dot) : s;
    let ext = dot > 0 ? s.slice(dot) : '';
    if (Array.from(ext).length > 12 || /[\s\/\\]/.test(ext)) { base = s; ext = ''; }
    ext = ext.replace(/[^\p{L}\p{N}.]/gu, '');
    return safeName(base, Math.max(1, max - Array.from(ext).length), 'file') + ext;
  }

  // Дата и время сообщения по местному времени: 23.10.2026 09:57
  function formatTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // Заголовки внутри сообщения сдвигаем на 2 уровня (# -> ###), чтобы в оглавлении
  // Obsidian верхний уровень занимали «## Я» / «## Ассистент». Блоки кода не трогаем.
  function demoteHeadings(text) {
    let fenceMark = null;
    return String(text).split('\n').map((line) => {
      const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (f) {
        if (!fenceMark) fenceMark = f[1];
        else if (f[1][0] === fenceMark[0] && f[1].length >= fenceMark.length) fenceMark = null;
        return line;
      }
      if (fenceMark) return line;
      return line.replace(/^( {0,3})(#{1,6})(?=\s|$)/, (m0, sp, h) => sp + '#'.repeat(Math.min(6, h.length + 2)));
    }).join('\n');
  }

  // Раздаёт уникальные имена внутри materials/ одного чата: a.png, a_2.png…
  function nameAllocator() {
    const used = new Set();
    return (raw) => {
      const n = safeFileName(raw);
      const key = (x) => x.toLowerCase();
      if (!used.has(key(n))) { used.add(key(n)); return n; }
      const dot = n.lastIndexOf('.');
      const base = dot > 0 ? n.slice(0, dot) : n;
      const ext = dot > 0 ? n.slice(dot) : '';
      let i = 2;
      while (used.has(key(`${base}_${i}${ext}`))) i++;
      used.add(key(`${base}_${i}${ext}`));
      return `${base}_${i}${ext}`;
    };
  }

  // Путь для markdown-ссылки: кодируем только то, что ломает ссылку
  // (пробелы, скобки), чтобы русские имена оставались читаемыми
  const mdPath = (name) =>
    'materials/' +
    name.replace(/[\s()<>\[\]%]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  const mdLabel = (s) => String(s).replace(/([\[\]\\])/g, '\\$1');
  const isImageName = (n) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(n);

  function badgeMake() {
    const b = document.createElement('div');
    b.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:999999;background:#1a1a1a;color:#fff;' +
      'padding:10px 14px;border-radius:8px;font:13px/1.4 -apple-system,sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.3);max-width:420px';
    b.textContent = 'Собираю диалог…';
    document.body.appendChild(b);
    return b;
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  // Скачивание идёт через фоновый скрипт. url — data: или адрес на claude.ai
  // (тогда браузер качает сам, с вашей сессией и без ограничений по размеру).
  async function download(url, filename) {
    const resp = await chrome.runtime.sendMessage({ cmd: 'download', url, filename });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'неизвестная ошибка');
  }

  async function downloadBlob(blob, filename) {
    return download(await blobToDataUrl(blob), filename);
  }

  // Файл с claude.ai: сначала браузер качает его напрямую (без лимита размера),
  // если не вышло — забираем запросом со страницы, где сессия есть всегда.
  async function downloadFromSite(url, filename) {
    try {
      await download(url, filename);
    } catch (direct) {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error(`сервер ответил ${r.status}`);
      await downloadBlob(await r.blob(), filename);
    }
  }

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`запрос ${url} вернул ${r.status}`);
    return r.json();
  }

  // ---------- Получение данных ----------

  function getConversationId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    if (!m) throw new Error('откройте чат на claude.ai (адрес вида claude.ai/chat/…)');
    return m[1];
  }

  // У аккаунта может быть несколько организаций (личная, рабочая). Чат лежит
  // в одной из них: сначала пробуем ту, что сайт запомнил как текущую
  // (cookie lastActiveOrg), потом остальные по очереди.
  async function findConversation(id) {
    const orgs = await getJson('/api/organizations');
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('не найдена ни одна организация');
    const active = (document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/) || [])[1];
    const hasChat = (o) => (o.capabilities || []).includes('chat');
    const order = [
      ...orgs.filter((o) => o.uuid === active),
      ...orgs.filter((o) => o.uuid !== active && hasChat(o)),
      ...orgs.filter((o) => o.uuid !== active && !hasChat(o)),
    ];
    let lastStatus = 0;
    for (const o of order) {
      const r = await fetch(
        `/api/organizations/${o.uuid}/chat_conversations/${id}` +
          '?tree=True&rendering_mode=messages&render_all_tools=true',
        { credentials: 'include' }
      );
      if (r.ok) return { org: o.uuid, conv: await r.json() };
      lastStatus = r.status;
      // 403/404 — чат не в этой организации, пробуем следующую
      if (r.status !== 403 && r.status !== 404) break;
    }
    throw new Error(`чат не найден ни в одной организации (ответ сервера ${lastStatus})`);
  }

  const fileContentsUrl = (org, fileUuid) =>
    `${location.origin}/api/organizations/${org}/files/${fileUuid}/contents`;

  // ---------- Сборка markdown ----------

  // Экранирует текст, чтобы теги вроде <div> внутри подписей не считались HTML
  const escapeHtml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Размышления. Полный текст сайт обычно скрывает (thinking_hidden) и отдаёт
  // только короткие заголовки-summaries — те, что видны в свёрнутом блоке на сайте.
  // Возвращает строки для блока «Размышления» (может быть пусто)
  function thinkingLines(block) {
    if (block.thinking && !block.thinking_hidden) return [escapeHtml(block.thinking.trim())];
    return (block.summaries || [])
      .map((s) => (s && s.summary ? s.summary.trim() : ''))
      .filter(Boolean)
      .map((s) => '- ' + escapeHtml(s));
  }

  // Сворачиваемая выноска Obsidian (callout): «-» после типа — свёрнута по умолчанию.
  // Каждая строка содержимого получает префикс «> », внутри работает весь markdown.
  function calloutMd(type, title, inner) {
    const body = String(inner).trim().split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
    return `> [!${type}]- ${title.replace(/\s+/g, ' ')}\n${body}\n\n`;
  }

  const detailsMd = (lines) => calloutMd('quote', 'Размышления', lines.join('\n'));

  // Ваши файлы из сообщения: ставим задания на скачивание и возвращаем ссылки.
  //  - attachments: текстовые файлы, сайт отдаёт их содержимое прямо в данных чата;
  //  - files / files_v2: остальные файлы, качаем оригинал по file_uuid.
  function userFilesMd(msg, ctx) {
    let out = '';
    const link = (name, label) =>
      isImageName(name)
        ? `![${mdLabel(label)}](${mdPath(name)})\n\n`
        : `📎 [${mdLabel(label)}](${mdPath(name)})\n\n`;

    for (const a of msg.attachments || []) {
      const label = a.file_name || 'attachment.txt';
      if (typeof a.extracted_content === 'string') {
        const name = ctx.alloc(label);
        ctx.jobs.push({ name, blob: new Blob([a.extracted_content], { type: 'text/plain;charset=utf-8' }) });
        out += link(name, label);
      } else {
        out += `📎 ${mdLabel(label)} *(содержимое недоступно)*\n\n`;
      }
    }

    const seen = new Set();
    for (const f of [].concat(msg.files || [], msg.files_v2 || [])) {
      const uuid = f.file_uuid || f.uuid;
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      const label = f.file_name || (f.file_kind === 'image' ? 'image.png' : 'file');
      const name = ctx.alloc(label);
      ctx.jobs.push({ name, url: fileContentsUrl(ctx.org, uuid) });
      out += link(name, label);
    }
    return out;
  }

  // ---------- Действия Claude (команды, файлы, задачи) ----------

  // Служебные шаги, которые на сайте не показываются
  const HIDDEN_TOOLS = new Set(['prepare_session']);

  const baseName = (p) => String(p || '').split(/[\\/]/).pop() || 'file';

  const LANGS = {
    js: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json', md: 'markdown',
    py: 'python', sh: 'bash', html: 'html', css: 'css', yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'xml',
  };
  const langOf = (path) => LANGS[(String(path).split('.').pop() || '').toLowerCase()] || '';

  // Блок кода, который не ломается, если внутри уже есть ```
  function fence(text, lang = '') {
    const s = String(text == null ? '' : text).replace(/\n+$/, '');
    const longest = Math.max(0, ...(s.match(/`+/g) || []).map((x) => x.length));
    const f = '`'.repeat(Math.max(3, longest + 1));
    return `${f}${lang}\n${s}\n${f}\n\n`;
  }

  // Картинка из данных (скриншот в результате команды, картинка в сообщении):
  // base64 -> файл в materials/, в логе — картинка на своём месте
  const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  function imageMd(block, ctx, base) {
    const src = block.source || {};
    if (src.type === 'base64' && src.data) {
      const bin = atob(src.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const type = src.media_type || 'image/png';
      const saved = ctx.alloc(`${base}.${IMAGE_EXT[type] || 'png'}`);
      ctx.jobs.push({ name: saved, blob: new Blob([bytes], { type }) });
      return `![${mdLabel(base)}](${mdPath(saved)})\n\n`;
    }
    if (src.type === 'url' && src.url) return `![${mdLabel(base)}](${src.url})\n\n`;
    return '';
  }

  // Результат действия: текст — блоком кода, картинки — сохраняем и показываем
  function resultMd(result, ctx) {
    if (!result) return '';
    const texts = [];
    let images = '';
    for (const c of result.content || []) {
      if (c.type === 'text') texts.push(c.text);
      else if (c.type === 'image') images += ctx ? imageMd(c, ctx, 'скриншот') : '';
      else if (c.type === 'tool_reference') texts.push('→ ' + (c.tool_name || c.name || 'инструмент'));
      else texts.push(`[${c.type}]`);
    }
    const text = texts.join('\n').trim();
    if (!text && !images) return '';
    return (result.is_error ? '*Ошибка:*\n\n' : '*Результат:*\n\n') + (text ? fence(text) : '') + images;
  }

  // Число токенов словами: 495 токенов, 1,6 тыс. токенов, 45,4 млн токенов
  function formatTokens(n) {
    const short = (v, decimalsBelow) =>
      v < decimalsBelow ? v.toFixed(1).replace('.', ',').replace(/,0$/, '') : String(Math.round(v));
    if (n >= 1e6) return `${short(n / 1e6, 100)} млн токенов`;
    if (n >= 1e3) return `${short(n / 1e3, 10)} тыс. токенов`;
    const d = n % 10, dd = n % 100;
    const word = d === 1 && dd !== 11 ? 'токен' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'токена' : 'токенов';
    return `${n} ${word}`;
  }

  // Строка под ответом Claude Code: время хода и токены
  function turnLine(turn) {
    const parts = [];
    if (turn.duration_ms) parts.push(`Ход занял ${formatDuration(turn.duration_ms)}`);
    const u = turn.usage;
    if (u) {
      const out = u.output_tokens || 0;
      const cached = u.cache_read_input_tokens || 0;
      const read = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached;
      if (out) parts.push(`Claude написал ${formatTokens(out)}`);
      if (read) parts.push(`прочитал ${formatTokens(read)} (${Math.floor((cached / read) * 100)}% из кэша)`);
    }
    return parts.length ? `*${parts.join(' · ')}*\n\n` : '';
  }

  // Оценка токенов по тексту (для обычных чатов, где сайт их не отдаёт).
  // Коэффициенты откалиброваны по точным данным Claude Code (claude-opus-5-5):
  // русский ~1,5 символа на токен, латиница, цифры и код ~3,1. Погрешность ±20–30%.
  function estimateTokens(text) {
    const s = String(text || '');
    const cyr = (s.match(/[\u0400-\u04FF]/g) || []).length;
    return Math.round(cyr / 1.5 + (s.length - cyr) / 3.1);
  }

  // Весь текст сообщения, который Claude видит в переписке
  function messageText(msg) {
    let t = '';
    for (const b of msg.content || []) {
      if (b.type === 'text') t += b.text || '';
      else if (b.type === 'thinking' && !b.thinking_hidden) t += b.thinking || '';
      else if (b.type === 'tool_use') t += JSON.stringify(b.input || {});
      else if (b.type === 'tool_result') t += (b.content || []).map((c) => c.text || '').join('\n');
    }
    if (!(msg.content || []).length) t += msg.text || '';
    return t;
  }
  const attachmentsText = (msg) => (msg.attachments || []).map((a) => a.extracted_content || '').join('\n');

  // Длительность хода: 45 с, 12 мин, 1 ч 11 мин
  function formatDuration(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} с`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} мин`;
    return `${Math.floor(min / 60)} ч ${min % 60} мин`;
  }

  // Файлы, которые Claude создал/изменил (Write/Edit), сайт хранит снимками в
  // msg.files в том же порядке, что и действия. Берём следующий снимок с тем же именем.
  // Снимки рабочих файлов (созданных и изменённых Claude) — в materials/versions/
  // с номером версии: content v1.js, content v2.js… Счётчик ведётся по имени файла.
  function takeSnapshot(ctx, path) {
    const name = baseName(path);
    const i = ctx.snapshots.findIndex((f) => f.file_name === name);
    if (i < 0) return null;
    const [f] = ctx.snapshots.splice(i, 1);
    const safe = safeFileName(name);
    const dot = safe.lastIndexOf('.');
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    const key = safe.toLowerCase();
    const n = (ctx.versions.get(key) || 0) + 1;
    ctx.versions.set(key, n);
    const saved = `versions/${base} v${n}${ext}`;
    ctx.jobs.push({ name: saved, url: fileContentsUrl(ctx.org, f.file_uuid || f.uuid) });
    return saved;
  }

  const diffText = (oldS, newS) =>
    String(oldS || '').split('\n').map((l) => '- ' + l).join('\n') + '\n' +
    String(newS || '').split('\n').map((l) => '+ ' + l).join('\n');

  // ---------- Артефакты и визуализации ----------

  // Содержимое файлов, которые Claude пишет по ходу чата (путь -> текст).
  // Нужно, чтобы знать, что именно опубликовано как артефакт.
  function replaceText(text, oldS, newS, all) {
    if (text == null || !oldS || !text.includes(oldS)) return text;
    return all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  }
  function trackEdit(ctx, path, oldS, newS, all) {
    if (ctx.files.has(path)) ctx.files.set(path, replaceText(ctx.files.get(path), oldS, newS || '', all));
  }

  const decodeEntities = (s) =>
    String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  // Страница-артефакт — фрагмент HTML без <!doctype> и кодировки; без них
  // браузер может показать русский текст кракозябрами.
  const htmlDoc = (code) =>
    /^\s*<!doctype/i.test(code) ? code : '<!doctype html>\n<meta charset="utf-8">\n' + code;

  // Публикация артефакта (инструмент Artifact): страница = текущее содержимое файла
  function artifactPublish(use, result, ctx) {
    const inp = use.input || {};
    const text = ((result && result.content) || []).map((c) => c.text || '').join('\n');
    const m = text.match(/(https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+)(?:\s*\(Version (\d+))?/);
    const url = m ? m[1] : '';
    const version = m && m[2] ? +m[2] : 0;
    const content = inp.file_path && ctx.files.has(inp.file_path) ? ctx.files.get(inp.file_path) : null;

    // Мелкие правки, переданные прямо в публикацию (edits)
    let page = content;
    if (page != null && Array.isArray(inp.edits)) {
      for (const e of inp.edits) page = replaceText(page, e.old_str, e.new_str || '', false);
      ctx.files.set(inp.file_path, page);
    }

    const known = url && ctx.artifacts.get(url);
    const titleTag = page && page.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title =
      (titleTag && decodeEntities(titleTag[1]).trim()) || (known && known.title) ||
      (inp.title) || baseName(inp.file_path || 'artifact').replace(/\.[^.]+$/, '');
    const description = inp.description || (known && known.description) || '';
    if (url) ctx.artifacts.set(url, { title, description });

    if (result && result.is_error) return { title, version, card: '' };

    let card = '🧩 **';
    if (page != null) {
      const saved = ctx.alloc(`${title}${version > 1 ? ` v${version}` : ''}.html`);
      ctx.jobs.push({ name: saved, blob: new Blob([htmlDoc(page)], { type: 'text/html;charset=utf-8' }) });
      card += `[${mdLabel(title)}](${mdPath(saved)})**`;
    } else {
      card += `${mdLabel(title)}** *(содержимое недоступно)*`;
    }
    if (version) card += ` · версия ${version}`;
    if (description) card += ` — ${escapeHtml(description)}`;
    if (url) card += ` · [открыть на claude.ai](${url})`;
    return { title, version, card: card + '\n\n' };
  }

  // Классические артефакты обычного claude.ai (инструмент artifacts):
  // create/rewrite присылают текст целиком, update — замену old_str -> new_str.
  const ARTIFACT_EXT = {
    'text/html': 'html', 'image/svg+xml': 'svg', 'text/markdown': 'md',
    'application/vnd.ant.react': 'jsx', 'application/vnd.ant.mermaid': 'mmd',
  };
  const CODE_EXT = {
    python: 'py', javascript: 'js', typescript: 'ts', bash: 'sh', shell: 'sh', json: 'json',
    html: 'html', css: 'css', sql: 'sql', java: 'java', go: 'go', rust: 'rs', cpp: 'cpp', c: 'c',
  };
  function classicArtifact(inp, ctx) {
    const id = inp.id || inp.title || 'artifact';
    const st = ctx.classic.get(id) || { title: inp.title || id, type: inp.type, language: inp.language, content: '', n: 0 };
    if (inp.title) st.title = inp.title;
    if (inp.type) st.type = inp.type;
    if (inp.language) st.language = inp.language;
    if (inp.command === 'update') st.content = replaceText(st.content, inp.old_str, inp.new_str || '', false);
    else if (typeof inp.content === 'string') st.content = inp.content;
    st.n++;
    ctx.classic.set(id, st);
    if (!st.content) return '';

    const ext = ARTIFACT_EXT[st.type] ||
      (st.type === 'application/vnd.ant.code' ? CODE_EXT[String(st.language).toLowerCase()] || 'txt' : 'txt');
    let data = st.content;
    if (ext === 'html') data = htmlDoc(data);
    if (ext === 'svg') data = standaloneSvg(data, false);
    const saved = ctx.alloc(`${st.title}${st.n > 1 ? ` v${st.n}` : ''}.${ext}`);
    ctx.jobs.push({ name: saved, blob: new Blob([data], { type: 'text/plain;charset=utf-8' }) });
    return ext === 'svg'
      ? `![${mdLabel(st.title)}](${mdPath(saved)})\n\n`
      : `🧩 **[${mdLabel(st.title)}](${mdPath(saved)})**${st.n > 1 ? ` · версия ${st.n}` : ''}\n\n`;
  }

  // Тема диаграмм claude.ai (тёмная). На сайте стили и CSS-переменные приходят
  // со страницы; в отдельном файле их нет — без них диаграмма превращается
  // в чёрные контуры. Палитра и правила — из инструкции сайта к диаграммам:
  // тёмная тема = заливка 800, обводка 200, заголовок 100, подпись 200.
  // Одни и те же стили годятся и для SVG, и для HTML (:root — корень документа).
  // :not([fill]) / :not([stroke]) — не трогаем элементы, где цвет задан явно.
  const RAMPS = {
    //        100        200        800
    purple: ['#CECBF6', '#AFA9EC', '#3C3489'], teal: ['#9FE1CB', '#5DCAA5', '#085041'],
    coral: ['#F5C4B3', '#F0997B', '#712B13'], pink: ['#F4C0D1', '#ED93B1', '#72243E'],
    gray: ['#D3D1C7', '#B4B2A9', '#444441'], blue: ['#B5D4F4', '#85B7EB', '#0C447C'],
    green: ['#C0DD97', '#97C459', '#27500A'], amber: ['#FAC775', '#EF9F27', '#633806'],
    red: ['#F7C1C1', '#F09595', '#791F1F'],
  };
  const SHAPES = ['rect', 'circle', 'ellipse', 'polygon'];
  const THEME_CSS =
    ':root{--surface-0:#262624;--surface-1:#30302e;--surface-2:#3a3a37;' +
    '--text-primary:#ece9e1;--text-secondary:#c2c0b6;--text-muted:#9c9a92;' +
    '--text-accent:#AFA9EC;--text-danger:#F09595;--text-success:#97C459;--text-warning:#EF9F27;' +
    '--border:rgba(255,255,255,.14);--border-strong:rgba(255,255,255,.28);--border-stronger:rgba(255,255,255,.4);' +
    '--t:#9c9a92;--radius:8px;--font-sans:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;' +
    '--font-voice:Georgia,serif;--font-mono:ui-monospace,Menlo,Consolas,monospace}\n' +
    'svg{font-family:var(--font-sans)}\n' +
    'text:not([fill]){fill:var(--text-primary)}\n' +
    '.t:not([fill]){font-size:14px;fill:var(--text-primary)}\n' +
    '.th:not([fill]){font-size:14px;font-weight:500;fill:var(--text-primary)}\n' +
    '.ts:not([fill]){font-size:12px;fill:var(--text-secondary)}\n' +
    '.arr,.leader,line:not([stroke]),polyline:not([stroke]){stroke:var(--t);fill:none}\n' +
    Object.entries(RAMPS).map(([k, [c100, c200, c800]]) => {
      const shape = SHAPES.map((s) => `.c-${k}>${s}:not([fill]),${s}.c-${k}:not([fill])`).join(',');
      return `${shape}{fill:${c800};stroke:${c200}}\n` +
        `.c-${k}>.th,.c-${k}>.t{fill:${c100}}.c-${k}>.ts{fill:${c200}}`;
    }).join('\n') + '\n';

  // Интерактивная визуализация -> самостоятельная страница: тема, шрифты,
  // скрытая подпись для экранного диктора, заглушки функций сайта.
  const widgetHtmlDoc = (code) =>
    '<!doctype html>\n<html data-mode="dark">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<style>\n' + THEME_CSS +
    'html{background:var(--surface-0);color:var(--text-primary);color-scheme:dark}\n' +
    'body{margin:0;padding:16px 24px;font:16px/1.7 var(--font-sans)}\n' +
    'h1{font-size:22px}h2{font-size:18px}h3{font-size:16px}h1,h2,h3{font-weight:500;color:var(--text-primary)}\n' +
    '.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}\n' +
    'input[type=range]{accent-color:#7F77DD}\n' +
    '</style>\n<script>window.sendPrompt=function(){};window.openLink=function(u){window.open(u,"_blank")};</script>\n' +
    '</head>\n<body>\n' + code + '\n</body>\n</html>\n';

  // SVG-код виджета -> самостоятельный файл: размеры по viewBox, xmlns,
  // стили и фон (если withTheme), без onclick (на сайте он задаёт вопрос в чат)
  function standaloneSvg(code, withTheme) {
    let s = String(code).trim();
    const vb = (s.match(/viewBox\s*=\s*"([^"]+)"/i) || [])[1];
    const [x = 0, y = 0, w = 680, h = 400] = vb ? vb.trim().split(/[\s,]+/).map(Number) : [];
    s = s.replace(/<svg\b([^>]*)>/i, (m0, attrs) => {
      let a = attrs.replace(/\s(width|height)\s*=\s*"[^"]*"/gi, '');
      if (!/\sxmlns\s*=/.test(a)) a += ' xmlns="http://www.w3.org/2000/svg"';
      if (/xlink:/.test(s) && !/\sxmlns:xlink\s*=/.test(a)) a += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
      const extra = withTheme
        ? `\n<style>\n${THEME_CSS}</style>\n<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#262624"/>`
        : '';
      return `<svg${a} width="${w}" height="${h}">${extra}`;
    });
    s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + s;
  }

  // Визуализация прямо в чате (show_widget): SVG — картинкой в логе, HTML — файлом
  function widgetMd(inp, ctx) {
    const code = String(inp.widget_code || '');
    if (!code.trim()) return '';
    const svgTitle = code.match(/<title[^>]*>([^<]*)<\/title>/i);
    const label = (svgTitle && decodeEntities(svgTitle[1]).trim()) || inp.title || 'Визуализация';
    const base = inp.title || 'visual';
    if (/^\s*<svg[\s>]/i.test(code)) {
      const saved = ctx.alloc(base + '.svg');
      ctx.jobs.push({ name: saved, blob: new Blob([standaloneSvg(code, true)], { type: 'image/svg+xml' }) });
      return `![${mdLabel(label)}](${mdPath(saved)})\n\n`;
    }
    // У HTML-виджета описание — в скрытом заголовке для экранного диктора
    const srOnly = code.match(/<h2[^>]*class="[^"]*sr-only[^"]*"[^>]*>([^<]*)<\/h2>/i);
    const htmlLabel = (srOnly && decodeEntities(srOnly[1]).trim().replace(/\.$/, '')) || label;
    const saved = ctx.alloc(base + '.html');
    ctx.jobs.push({ name: saved, blob: new Blob([widgetHtmlDoc(code)], { type: 'text/html;charset=utf-8' }) });
    return `📊 [${mdLabel(htmlLabel)} — интерактивная визуализация, открыть в браузере](${mdPath(saved)})\n\n`;
  }

  const fileRef = (saved, path) =>
    (saved ? `[${mdLabel(baseName(path))}](${mdPath(saved)})` : mdLabel(baseName(path))) +
    ` — \`${String(path).replace(/`/g, '')}\``;

  // Одно действие в markdown. Возвращает { md, kind } — kind для заголовка блока.
  function toolMd(use, result, ctx) {
    const inp = use.input || {};
    const label = escapeHtml;
    switch (use.name) {
      case 'WebSearch':
      case 'web_search':
        return {
          kind: 'Поиск в интернете',
          md: `**Поиск в интернете:** ${label(inp.query || '')}\n\n` + resultMd(result, ctx),
        };
      case 'WebFetch':
      case 'web_fetch':
        return {
          kind: 'Открыто страниц',
          md: `**Открыта страница:** ${inp.url ? `<${String(inp.url).replace(/[<>\s]/g, '')}>` : ''}` +
            (inp.prompt ? `\n\n*Вопрос к странице:* ${label(inp.prompt)}` : '') + '\n\n' + resultMd(result, ctx),
        };
      case 'Glob':
      case 'Grep':
        return {
          kind: 'Поиск файлов',
          md: `**Поиск файлов:** \`${String(inp.pattern || '').replace(/`/g, '')}\`` +
            (inp.path ? ` в \`${String(inp.path).replace(/`/g, '')}\`` : '') + '\n\n' + resultMd(result, ctx),
        };
      case 'Bash':
        return {
          kind: 'Команды',
          md: `**Команда:** ${label(inp.description || 'без описания')}\n\n` +
            fence(inp.command, 'bash') + resultMd(result, ctx),
        };
      case 'Read':
        return {
          kind: 'Прочитано файлов',
          md: `**Прочитан файл:** \`${String(inp.file_path || '').replace(/`/g, '')}\`\n\n` + resultMd(result, ctx),
        };
      case 'Write': {
        if (!(result && result.is_error)) ctx.files.set(inp.file_path, String(inp.content || ''));
        const saved = takeSnapshot(ctx, inp.file_path);
        return {
          kind: 'Создано файлов',
          md: `**Создан файл:** ${fileRef(saved, inp.file_path)}\n\n` +
            fence(inp.content, langOf(inp.file_path)) + (result && result.is_error ? resultMd(result, ctx) : ''),
        };
      }
      case 'Edit': {
        if (!(result && result.is_error)) trackEdit(ctx, inp.file_path, inp.old_string, inp.new_string, inp.replace_all);
        const saved = takeSnapshot(ctx, inp.file_path);
        const diff = diffText(inp.old_string, inp.new_string);
        return {
          kind: 'Изменено файлов',
          md: `**Изменён файл:** ${fileRef(saved, inp.file_path)}` +
            (inp.replace_all ? ' *(все вхождения)*' : '') + '\n\n' +
            fence(diff, 'diff') + (result && result.is_error ? resultMd(result, ctx) : ''),
        };
      }
      case 'TaskCreate':
        return {
          kind: 'Задачи',
          md: `**Задача добавлена:** ${label(inp.subject || '')}\n\n` +
            (inp.description ? label(inp.description) + '\n\n' : ''),
        };
      case 'TaskUpdate':
        return {
          kind: 'Задачи',
          md: `**Задача обновлена:** #${label(inp.taskId || '')}` +
            (inp.status ? ` → ${label(inp.status)}` : '') + '\n\n',
        };
      case 'SendUserFile': {
        // Сами файлы показываем после блока, как карточки на сайте
        const names = (result && result.file_deliveries || []).map((d) => baseName(d.path));
        return {
          kind: 'Передано файлов',
          count: names.length || 1,
          md: `**Передан файл:** ${names.map(mdLabel).join(', ') || '—'}` +
            (inp.caption ? ` — ${label(inp.caption)}` : '') + '\n\n' +
            (result && result.is_error ? resultMd(result, ctx) : ''),
        };
      }
      case 'Skill':
        return { kind: 'Навыки', md: `**Загружен навык:** ${label(inp.skill || '')}\n\n` };
      case 'Artifact': {
        const pub = artifactPublish(use, result, ctx);
        return {
          kind: 'Артефакты',
          md: `**Опубликован артефакт:** ${label(pub.title)}${pub.version ? ` (версия ${pub.version})` : ''}\n\n` +
            fence(JSON.stringify(inp, null, 2), 'json') + resultMd(result, ctx),
          after: pub.card,
        };
      }
      case 'artifacts': {
        const card = classicArtifact(inp, ctx);
        return {
          kind: 'Артефакты',
          md: `**Артефакт** (${label(inp.command || 'create')}): ${label(inp.title || inp.id || '')}\n\n` +
            (inp.command === 'update'
              ? fence(diffText(inp.old_str, inp.new_str), 'diff')
              : fence(inp.content, inp.language || '')) + resultMd(result, ctx),
          after: card,
        };
      }
      case 'Agent':
      case 'Task': {
        // Субагент: задание, его собственная работа вложенным блоком, итог
        const sub = use.__sub ? renderBlocks(use.__sub, ctx).md.trim() : '';
        return {
          kind: 'Субагенты',
          md: `**Субагент:** ${label(inp.description || '')}` +
            (inp.subagent_type ? ` (\`${String(inp.subagent_type).replace(/`/g, '')}\`)` : '') + '\n\n' +
            (inp.prompt ? '*Задание:*\n\n' + fence(inp.prompt) : '') +
            (sub ? calloutMd('example', 'Работа субагента', sub) : '') +
            resultMd(result, ctx),
        };
      }
      default:
        if (/(^|__)(create|merge)_pull_request$/.test(use.name)) {
          return {
            kind: 'GitHub',
            md: `**GitHub:** \`${use.name.replace(/^mcp__github__/, '')}\`\n\n` +
              fence(JSON.stringify(inp, null, 2), 'json') + resultMd(result, ctx),
            after: prLinkMd(use, result),
          };
        }
        if (/(^|__)show_widget$/.test(use.name)) {
          return {
            kind: 'Визуализации',
            md: `**Визуализация:** ${label(inp.title || '')}\n\n` +
              fence(inp.widget_code, /^\s*<svg/i.test(inp.widget_code || '') ? 'xml' : 'html') + resultMd(result, ctx),
            after: widgetMd(inp, ctx),
          };
        }
        return {
          kind: 'Прочие действия',
          md: (use.message ? `**${label(use.message)}** \`${use.name}\`` : `**Инструмент:** \`${use.name}\``) + '\n\n' +
            (Object.keys(inp).length ? fence(JSON.stringify(inp, null, 2), 'json') : '') +
            resultMd(result, ctx),
        };
    }
  }

  // Видимая строка о pull request'е — как карточка на сайте
  function prLinkMd(use, result) {
    if (!result || result.is_error) return '';
    const inp = use.input || {};
    const text = (result.content || []).map((c) => c.text || '').join('\n');
    const url = (text.match(/https:\/\/github\.com\/[^\s"'<>]+\/pull\/\d+/) || [])[0];
    if (/create_pull_request$/.test(use.name)) {
      const t = mdLabel(inp.title || 'Pull request');
      const n = url ? ` #${url.split('/').pop()}` : '';
      return url ? `🔀 [PR${n}: ${t}](${url})\n\n` : `🔀 PR создан: ${t}\n\n`;
    }
    const num = inp.pullNumber || inp.pull_number;
    const link = inp.owner && inp.repo && num ? `https://github.com/${inp.owner}/${inp.repo}/pull/${num}` : url;
    return link ? `✅ [PR #${num || ''} слит](${link})\n\n` : `✅ PR слит\n\n`;
  }

  // Файлы, переданные Claude через SendUserFile — видимые карточки после блока
  function deliveredFilesMd(result, caption, ctx) {
    let out = '';
    for (const d of (result && result.file_deliveries) || []) {
      if (!d.file_uuid) continue;
      const name = baseName(d.path);
      const saved = ctx.alloc(name);
      ctx.jobs.push({ name: saved, url: fileContentsUrl(ctx.org, d.file_uuid) });
      out += (isImageName(saved) ? '!' : '📎 ') + `[${mdLabel(name)}](${mdPath(saved)})` +
        (caption ? ` — ${escapeHtml(caption)}` : '') + '\n\n';
    }
    return out;
  }

  // Группа подряд идущих размышлений и действий между двумя кусками текста.
  // На сайте это один свёрнутый блок — делаем так же.
  function groupMd(entries, ctx) {
    const counts = new Map();
    const add = (k, n = 1) => counts.set(k, (counts.get(k) || 0) + n);
    let inner = '';
    let after = '';
    let hasTools = false;
    for (const e of entries) {
      if (e.kind === 'thinking') {
        if (e.lines.length) inner += '*Размышления:*\n\n' + e.lines.join('\n') + '\n\n';
        continue;
      }
      hasTools = true;
      const t = toolMd(e.use, e.result, ctx);
      add(t.kind, t.count || 1);
      inner += t.md;
      if (t.after) after += t.after; // артефакты и диаграммы на сайте видны вне блока
      if (e.use.name === 'SendUserFile') after += deliveredFilesMd(e.result, e.use.input && e.use.input.caption, ctx);
    }
    if (!inner.trim()) return after;
    if (!hasTools) {
      // Только размышления — прежний компактный вид
      const lines = entries.flatMap((e) => e.lines || []);
      return detailsMd(lines) + after;
    }
    const summary = 'Действия: ' + [...counts].map(([k, n]) => `${k} — ${n}`).join(', ');
    return calloutMd('example', summary, inner) + after;
  }

  // Последовательность блоков -> markdown: текст как есть, размышления и действия
  // подряд — одним свёрнутым блоком, отметка о сжатии контекста — видимой строкой
  function renderBlocks(blocks, ctx) {
    const results = new Map();
    for (const b of blocks) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
    let md = '';
    let text = '';
    let entries = [];
    const flush = () => {
      if (entries.length) md += groupMd(entries, ctx);
      entries = [];
    };
    for (const block of blocks) {
      if (block.type === 'thinking') entries.push({ kind: 'thinking', lines: thinkingLines(block) });
      else if (block.type === 'tool_use' && !HIDDEN_TOOLS.has(block.name) && !block.hidden_in_chat)
        entries.push({ kind: 'tool', use: block, result: results.get(block.id) });
      else if (block.type === 'text' && block.text) {
        flush();
        md += demoteHeadings(block.text) + '\n\n';
        text += block.text;
      } else if (block.type === '__compact') {
        flush();
        const m = block.meta || {};
        const how = m.trigger === 'manual' ? 'вручную' : 'автоматически';
        const tokens = m.pre_tokens ? `, до сжатия ${Math.round(m.pre_tokens / 1000)} тыс. токенов` : '';
        md += `> [!info] Контекст сжат ${how}${tokens}\n\n`;
      }
    }
    flush();
    return { md, text };
  }

  // Возвращает markdown сообщения или '' если показывать нечего
  // (например, служебный шаг «Set up for this session»).
  function messageToMd(msg, ctx) {
    const time = ctx.settings.showTime ? formatTime(msg.created_at) : '';
    const who = (msg.sender === 'human' ? '## Я' : '## Ассистент') + (time ? ` · ${time}` : '');
    let body = '';

    // Файлы, которые вы приложили, на сайте стоят над текстом сообщения
    if (msg.sender === 'human') body += userFilesMd(msg, ctx);

    // Снимки файлов, созданных Claude в этом сообщении
    ctx.snapshots = msg.sender === 'human' ? [] : [].concat(msg.files || []);

    // Картинки, вставленные прямо в ваше сообщение (Ctrl+V)
    if (msg.sender === 'human') {
      for (const b of msg.content || []) if (b.type === 'image') body += imageMd(b, ctx, 'картинка');
    }

    const { md, text } = renderBlocks(msg.content || [], ctx);
    body += md;
    if (!text && msg.text) body += demoteHeadings(msg.text);

    // Сколько длился ход и сколько токенов ушло (Claude Code)
    if (msg.turn) body += turnLine(msg.turn);

    // Обычный чат: оценка объёма ответа и всей переписки к этому моменту
    // Вложения считаем отдельно: большие файлы могут не попадать в память целиком
    if (ctx.estimate) {
      const n = estimateTokens(messageText(msg));
      ctx.chatTokens = (ctx.chatTokens || 0) + n;
      ctx.attachTokens = (ctx.attachTokens || 0) + estimateTokens(attachmentsText(msg));
      if (msg.sender !== 'human' && body.trim()) {
        const att = ctx.attachTokens ? ` + вложения ≈ ${formatTokens(ctx.attachTokens)}` : '';
        body += `*Ответ ≈ ${formatTokens(n)} · вся переписка ≈ ${formatTokens(ctx.chatTokens)}${att}*\n\n`;
      }
    }

    // Снимки, не привязавшиеся к действиям, тоже сохраняем
    for (const f of [...ctx.snapshots]) {
      const saved = takeSnapshot(ctx, f.file_name || 'file');
      if (saved) body += `📎 [${mdLabel(f.file_name || saved)}](${mdPath(saved)})\n\n`;
    }
    ctx.snapshots = [];

    if (!body.trim()) return '';
    return who + '\n\n' + body.trim() + '\n\n---\n\n';
  }

  // API отдаёт дерево: при редактировании вопроса или перегенерации ответа
  // появляются ветки. Берём только ту, что сейчас видна в чате: идём от
  // последнего сообщения (current_leaf_message_uuid) вверх по parent_message_uuid.
  function currentBranch(conv) {
    const all = conv.chat_messages || [];
    const byId = new Map(all.map((m) => [m.uuid, m]));

    let leaf = byId.get(conv.current_leaf_message_uuid);
    if (!leaf) {
      // Запасной вариант: самое позднее сообщение считаем концом ветки
      leaf = all.reduce(
        (a, b) => (!a || new Date(b.created_at) > new Date(a.created_at) ? b : a),
        null
      );
    }

    const chain = [];
    const seen = new Set();
    for (let m = leaf; m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid)) {
      seen.add(m.uuid);
      chain.push(m);
    }
    return chain.reverse();
  }

  function conversationToMd(conv, title, ctx, subtitle) {
    const msgs = currentBranch(conv);
    if (!msgs.length) throw new Error('в чате нет сообщений');
    const parts = msgs.map((m) => messageToMd(m, ctx)).filter(Boolean);
    const head = '# ' + title + '\n\n' + (subtitle ? `*${escapeHtml(subtitle)}*\n\n` : '');
    return { md: head + parts.join(''), count: parts.length };
  }

  // ---------- Главный сценарий ----------

  // Общая часть: собрать markdown, сохранить лог, исходные данные и файлы
  async function writeExport(badge, { conv, org, settings, title, subtitle, raw, estimate }) {
    const ctx = {
      org, settings, estimate, alloc: nameAllocator(), jobs: [],
      files: new Map(), // путь -> текст файлов, которые пишет Claude
      versions: new Map(), // имя рабочего файла -> сколько его версий уже сохранено
      artifacts: new Map(), // url артефакта -> {title, description}
      classic: new Map(), // id классического артефакта -> состояние
    };
    const { md, count } = conversationToMd(conv, title, ctx, subtitle);

    const name = safeName(title, 60, 'dialog');
    const folder = `ChatLogs/${name}`;
    badge.textContent = 'Сохраняю лог…';
    try {
      await downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${folder}/${name}.md`);
    } catch (e) {
      throw new Error('не удалось сохранить лог: ' + e.message);
    }
    if (settings.saveRawJson) {
      for (const [file, data] of raw) {
        await downloadBlob(
          new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }),
          `${folder}/${file}`
        ).catch((e) => console.warn('Chat Logger:', file, e));
      }
    }

    // Файлы — по одному, с прогрессом; ошибка одного не останавливает остальные
    const failed = [];
    for (let i = 0; i < ctx.jobs.length; i++) {
      const job = ctx.jobs[i];
      badge.textContent = `Сохраняю файлы… ${i + 1}/${ctx.jobs.length}`;
      try {
        const target = `${folder}/materials/${job.name}`;
        if (job.blob) await downloadBlob(job.blob, target);
        else await downloadFromSite(job.url, target);
      } catch (e) {
        console.warn('Chat Logger: файл не сохранён', job.name, e);
        failed.push(job.name);
      }
    }

    let summary = `Сохранено сообщений: ${count}`;
    if (ctx.jobs.length) summary += `, файлов: ${ctx.jobs.length - failed.length} из ${ctx.jobs.length}`;
    summary += `. Папка: Downloads/${folder}`;
    if (failed.length) {
      badge.style.background = '#8a5a13';
      summary += `\nНе удалось: ${failed.join(', ')}`;
      badge.style.whiteSpace = 'pre-line';
    }
    badge.textContent = summary;
  }

  // Обычный чат (claude.ai/chat/…)
  async function saveDialog(badge) {
    const id = getConversationId();
    badge.textContent = 'Запрашиваю диалог…';
    const settings = await getSettings();
    const { org, conv } = await findConversation(id);
    await writeExport(badge, {
      conv, org, settings, title: conv.name || 'dialog', raw: [['conversation.json', conv]], estimate: true,
    });
  }

  // ---------- Claude Code (claude.ai/code/session_…) ----------

  // Заголовки, которые страница Claude Code добавляет к своим запросам
  async function codeHeaders() {
    let org = (document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/) || [])[1];
    if (!org) {
      const orgs = await getJson('/api/organizations').catch(() => []);
      const o = (orgs || []).find((x) => (x.capabilities || []).includes('chat')) || (orgs || [])[0];
      org = o && o.uuid;
    }
    const headers = {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'anthropic-client-platform': 'web_claude_ai',
      'anthropic-client-feature': 'ccr',
      'content-type': 'application/json',
    };
    if (org) headers['x-organization-uuid'] = org;
    return { org, headers };
  }

  async function getCodeJson(url, headers) {
    const r = await fetch(url, { credentials: 'include', headers });
    if (!r.ok) throw new Error(`запрос ${url.split('?')[0]} вернул ${r.status}`);
    return r.json();
  }

  // Все события сессии: порциями по 500 с начала, курсор — номер последнего события
  async function loadAllEvents(sessionId, headers, badge) {
    const all = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 400; page++) {
      const url = `/v1/code/sessions/${sessionId}/events?limit=500&sort_order=asc` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await getCodeJson(url, headers);
      const data = Array.isArray(res.data) ? res.data : [];
      // Порции могут перекрываться — повторы по id события не берём
      for (const e of data) {
        const key = e.event_id || e.sequence_num;
        if (!seen.has(key)) { seen.add(key); all.push(e); }
      }
      badge.textContent = `Загружаю сессию… событий: ${all.length}`;
      if (data.length < 500 || !res.next_cursor || res.next_cursor === cursor) break;
      cursor = res.next_cursor;
    }
    return all;
  }

  const blocksOf = (content) =>
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

  // Поток событий Claude Code -> тот же вид, что у обычного чата (chat_messages),
  // чтобы дальше работал общий код: выноски, файлы, время сообщений.
  //  - ваше сообщение: событие user от client (текст, картинки, вложения);
  //  - ответ Claude: подряд идущие события assistant (по одному блоку в каждом)
  //    и результаты инструментов (user от worker с блоками tool_result);
  //  - работа субагента (parent_tool_use_id) прикрепляется к его вызову Agent;
  //  - result — итог хода (длительность), compact_boundary — сжатие контекста;
  //  - остальное служебное (статусы, лимиты, окружение) пропускается.
  function eventsToConversation(events) {
    const msgs = [];
    let current = null;
    const subs = new Map(); // id вызова Agent -> блоки работы субагента
    const uses = []; // все вызовы инструментов, чтобы потом прикрепить работу субагентов
    const push = (m) => {
      m.uuid = 'm' + msgs.length;
      m.parent_message_uuid = msgs.length ? msgs[msgs.length - 1].uuid : null;
      msgs.push(m);
      return m;
    };
    const assistantMsg = (ev) => current || (current = push({ sender: 'assistant', created_at: ev.created_at, content: [] }));
    const normalize = (b, fromAssistant) => {
      if (b.type === 'tool_result') {
        return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: blocksOf(b.content) };
      }
      if (fromAssistant && ['text', 'thinking', 'tool_use'].includes(b.type)) {
        if (b.type === 'tool_use') uses.push(b);
        return b;
      }
      return null;
    };
    const sorted = events.slice().sort((a, b) => Number(a.sequence_num) - Number(b.sequence_num));
    for (const ev of sorted) {
      const p = ev.payload || {};
      if (p.isSynthetic || p.isCompactSummary) continue;

      // Работа субагента — отдельно, по id вызвавшего его инструмента
      if (p.parent_tool_use_id) {
        if (p.type !== 'assistant' && p.type !== 'user') continue;
        const list = subs.get(p.parent_tool_use_id) || [];
        for (const b of blocksOf(p.message && p.message.content)) {
          const n = normalize(b, p.type === 'assistant');
          if (n) list.push(n);
        }
        subs.set(p.parent_tool_use_id, list);
        continue;
      }

      if (p.type === 'user' && ev.source === 'client') {
        current = null;
        const files = (p.file_attachments || []).map((f) => ({
          file_uuid: f.file_uuid, file_name: f.file_name, file_kind: f.is_image ? 'image' : 'blob',
        }));
        push({
          sender: 'human', created_at: ev.created_at, files,
          content: blocksOf(p.message && p.message.content).filter((b) => b.type === 'text' || b.type === 'image'),
        });
      } else if (p.type === 'assistant' || (p.type === 'user' && ev.source === 'worker')) {
        const m = assistantMsg(ev);
        for (const b of blocksOf(p.message && p.message.content)) {
          const n = normalize(b, p.type === 'assistant');
          if (n) m.content.push(n);
        }
      } else if (p.type === 'result' && current) {
        current.turn = { duration_ms: p.duration_ms, usage: p.usage }; // usage — токены только этого хода
      } else if (p.type === 'system' && p.subtype === 'compact_boundary') {
        assistantMsg(ev).content.push({ type: '__compact', meta: p.compact_metadata || {} });
      }
    }
    for (const u of uses) if (subs.has(u.id)) u.__sub = subs.get(u.id);
    return { chat_messages: msgs, current_leaf_message_uuid: msgs.length ? msgs[msgs.length - 1].uuid : null };
  }

  async function saveCodeSession(badge, sessionId) {
    badge.textContent = 'Запрашиваю сессию Claude Code…';
    const settings = await getSettings();
    const { org, headers } = await codeHeaders();
    const session = await getCodeJson(`/v1/code/sessions/${sessionId}`, headers);
    const info = session.response_shape || session;
    const events = await loadAllEvents(sessionId, headers, badge);
    const conv = eventsToConversation(events);

    // Подзаголовок: репозиторий, ветка, модель
    const cfg = info.config || {};
    const repo = ((cfg.sources || [])[0] || {}).url || '';
    const branch = Object.values((info.external_metadata || {}).current_branches || {})[0] || '';
    const cost = ((info.external_metadata || {}).usage || {}).cost_usd;
    const subtitle = [
      'Claude Code', repo.replace(/^https:\/\/github\.com\//, ''), branch && `ветка ${branch}`, cfg.model,
      cost ? `стоимость сессии ≈ $${cost.toFixed(2)} по ценам API` : '',
    ].filter(Boolean).join(' · ');

    await writeExport(badge, {
      conv, org, settings, title: info.title || sessionId, subtitle,
      raw: [['session.json', session], ['events.json', events]],
    });
  }

  async function run() {
    if (running) return;
    running = true;
    const badge = badgeMake();
    try {
      const code = location.pathname.match(/^\/code\/(session_[A-Za-z0-9]+)/);
      if (code) await saveCodeSession(badge, code[1]);
      else await saveDialog(badge);
    } catch (e) {
      console.warn('Chat Logger:', e);
      badge.style.background = '#8a2a1f';
      badge.textContent = 'Chat Logger: ' + (e && e.message ? e.message : e);
    } finally {
      running = false;
      setTimeout(() => badge.remove(), 10000);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.cmd === 'save-dialog') {
      sendResponse({ ok: true }); // сразу подтверждаем приём команды
      run();
    }
  });
})();
