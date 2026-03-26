// ── STATE ──────────────────────────────────────────────────────────────────
let currentUser = null;
let currentSlug = null;
let chatHistory = [];
let navData = null;
let pwTargetUser = null;   // username being changed in the modal
let pwIsSuperAdmin = false; // which endpoint to call

// ── INIT ───────────────────────────────────────────────────────────────────
// ── THEME ──
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.src = theme === 'light' ? '/vendor/icons/moon.svg' : '/vendor/icons/sun.svg';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(localStorage.getItem('theme') || 'dark');
  marked.setOptions({ gfm: true, breaks: true });
  // Load allowed domain hint for registration form
  try {
    const d = await api('GET', '/api/auth/domain');
    document.getElementById('reg-domain-hint').textContent = `Requires a @${d.domain} email address`;
  } catch {}
  await checkAuth();
  document.body.classList.remove('loading');
});

async function checkAuth() {
  try {
    const r = await api('GET', '/api/auth/me');
    currentUser = r;
    showApp();
  } catch {
    showAuthOverlay();
  }
}

function showApp() {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('user-display').textContent = currentUser.sub;  // email
  document.getElementById('user-role-badge').textContent = currentUser.role;

  const isEditor     = ['editor','admin','superadmin'].includes(currentUser.role);
  const isAdmin      = ['admin','superadmin'].includes(currentUser.role);
  const isSuperAdmin = currentUser.role === 'superadmin';

  document.querySelectorAll('.editor-only').forEach(el => {
    if (isEditor) el.classList.remove('hidden');
  });

  document.getElementById('admin-btn').style.display = '';

  loadPublicSettings();
  loadNav();
  initRightSidebar();
}

function showAuthOverlay() {
  document.getElementById('auth-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

async function loadPublicSettings() {
  try {
    const s = await api('GET', '/api/settings/public');
    document.getElementById('site-name').textContent = s.site_name;
    document.getElementById('site-tagline').textContent = s.site_tagline;
    document.title = s.site_name;
  } catch {}
}

// ── AUTH ───────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('#auth-tabs .tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'));
  });
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
}

async function doLogin(e) {
  e.preventDefault();
  const err = document.getElementById('login-error');
  err.textContent = '';
  try {
    await api('POST', '/api/auth/login', {
      username: document.getElementById('login-user').value.trim().toLowerCase(),
      password: document.getElementById('login-pass').value,
    });
    await checkAuth();
  } catch (ex) {
    err.textContent = ex.message || 'Login failed';
  }
}

async function doRegister(e) {
  e.preventDefault();
  const msg = document.getElementById('reg-msg');
  msg.textContent = '';
  try {
    await api('POST', '/api/auth/register', {
      username: document.getElementById('reg-user').value.trim().toLowerCase(),
      password: document.getElementById('reg-pass').value,
      display_name: document.getElementById('reg-name').value,
    });
    msg.style.color = 'var(--green-light)';
    msg.textContent = 'Request submitted — an admin will approve your account.';
    document.getElementById('register-form').reset();
  } catch (ex) {
    msg.style.color = 'var(--danger)';
    msg.textContent = ex.message || 'Registration failed';
  }
}

async function doLogout() {
  await api('POST', '/api/auth/logout');
  currentUser = null;
  showAuthOverlay();
}

// ── NAV ────────────────────────────────────────────────────────────────────
async function loadNav() {
  try {
    navData = await api('GET', '/api/nav');
    renderNav(navData);
  } catch {}
}

function renderNav(data) {
  const tree = document.getElementById('nav-tree');
  let html = '';

  html += `<div class="nav-link" id="nav-__home__" onclick="showHome()"><img src="/vendor/icons/home.svg" width="18" height="18" alt="">Home</div>`;
  html += `<div class="nav-link dropbox" id="nav-__dropbox__" onclick="showDropbox()"><img src="/vendor/icons/upload.svg" width="18" height="18" alt="">Library File Catalog</div>`;

  const cats = data.categories || [];
  for (const cat of cats) {
    html += `<div class="nav-category">${esc(cat.display_name || cat.name)}</div>`;
    for (const page of (cat.pages || [])) {
      html += `<div class="nav-link" id="nav-${page.slug}" onclick="loadPage('${page.slug}','${esc(cat.display_name||cat.name)}','${esc(page.display_name||page.name)}')">${esc(page.display_name || page.name)}</div>`;
      for (const sub of (page.subpages || [])) {
        html += `<div class="nav-link subpage" id="nav-${sub.slug}" onclick="loadPage('${sub.slug}','${esc(cat.display_name||cat.name)}','${esc(page.display_name||page.name)}','${esc(sub.display_name||sub.name)}')">${esc(sub.display_name || sub.name)}</div>`;
      }
    }
  }

  tree.innerHTML = html;
}

function filterNav(q) {
  q = q.toLowerCase();
  document.querySelectorAll('.nav-link').forEach(el => {
    el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
}

function setActiveNav(slug) {
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
  const el = document.getElementById(`nav-${slug}`);
  if (el) el.classList.add('active');
}

// ── PAGES ──────────────────────────────────────────────────────────────────
async function loadPage(slug, cat, page, sub) {
  currentSlug = slug;
  showView('page');
  setActiveNav(slug);

  let bc = `${esc(cat)} › <span>${esc(page)}</span>`;
  if (sub) bc += ` › <span>${esc(sub)}</span>`;
  document.getElementById('page-breadcrumb').innerHTML = bc;
  document.getElementById('edit-breadcrumb').innerHTML = bc;

  document.getElementById('history-panel').classList.add('hidden');

  const content = document.getElementById('page-content');
  content.innerHTML = '<p style="color:var(--subtext)">Loading…</p>';

  try {
    const data = await api('GET', `/api/pages/${slug}`);
    content.innerHTML = marked.parse(data.content || '');
    renderHistory(slug, data.versions || []);
    const isEditor = ['editor','admin','superadmin'].includes(currentUser?.role);
    document.getElementById('edit-btn').classList.toggle('hidden', !isEditor);
    document.getElementById('history-btn').classList.toggle('hidden', !isEditor || !data.versions?.length);
    loadComments(slug);
  } catch (ex) {
    content.innerHTML = `<p style="color:var(--subtext)">${ex.message === 'Page not found' ? '*(No content yet — click Edit to start writing)*' : 'Error loading page'}</p>`;
    loadComments(slug);
  }
}

function renderHistory(slug, versions) {
  const list = document.getElementById('history-list');
  if (!versions.length) { list.innerHTML = '<div style="color:var(--subtext);font-size:13px">No versions yet</div>'; return; }
  list.innerHTML = versions.map((v, i) => `
    <div class="history-item">
      <span class="history-ts">${fmtDate(v.timestamp)}</span>
      <span class="history-editor">${esc(v.editor)}</span>
      ${i === 0 ? '<span style="font-size:11px;color:var(--green)">current</span>' : `<button class="btn-ghost" style="font-size:12px;padding:4px 10px" onclick="rollback('${slug}','${v.filename}')">Restore</button>`}
    </div>
  `).join('');
}

function toggleHistory() {
  document.getElementById('history-panel').classList.toggle('hidden');
}

async function rollback(slug, filename) {
  if (!confirm('Restore this version? It will become the current version.')) return;
  await api('POST', `/api/pages/${slug}/rollback/${filename}`);
  loadPage(slug, ...currentBreadcrumbParts());
}

// ── EDITOR ─────────────────────────────────────────────────────────────────
function enterEditMode() {
  api('GET', `/api/pages/${currentSlug}`).then(data => {
    document.getElementById('editor').value = data.content || '';
    livePreview();
  }).catch(() => {
    document.getElementById('editor').value = '';
  });
  showView('edit');
}

function cancelEdit() { showView('page'); }

function livePreview() {
  document.getElementById('editor-preview').innerHTML = marked.parse(document.getElementById('editor').value);
}

async function savePage() {
  const content = document.getElementById('editor').value;
  await api('PUT', `/api/pages/${currentSlug}`, { content });
  showView('page');
  loadPage(currentSlug, ...currentBreadcrumbParts());
}

function currentBreadcrumbParts() {
  return document.getElementById('page-breadcrumb').textContent.split('›').map(s => s.trim());
}

// ── UPLOAD ─────────────────────────────────────────────────────────────────
function insertUpload() { document.getElementById('upload-input').click(); }

async function handleUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const editor = document.getElementById('editor');
    let md = file.type.startsWith('image/') ? `\n![${file.name}](${data.url})\n`
           : file.type.startsWith('video/') ? `\n<video controls src="${data.url}"></video>\n`
           : `\n[${file.name}](${data.url})\n`;
    const pos = editor.selectionStart;
    editor.value = editor.value.slice(0, pos) + md + editor.value.slice(pos);
    livePreview();
  } catch (ex) {
    alert('Upload failed: ' + ex.message);
  }
  input.value = '';
}

// ── COMMENTS ───────────────────────────────────────────────────────────────
async function loadComments(slug) {
  const list = document.getElementById('comments-list');
  try {
    const comments = await api('GET', `/api/comments/${slug}`);
    if (!comments.length) {
      list.innerHTML = '<div style="color:var(--subtext);font-size:13px;margin-bottom:12px">No comments yet</div>';
      return;
    }
    const isAdmin = ['admin','superadmin'].includes(currentUser?.role);
    list.innerHTML = comments.map(c => `
      <div class="comment-item">
        <div class="comment-meta">
          <span class="comment-author">${esc(c.author)}</span>
          <span class="comment-date">${fmtDate(c.created_at)}</span>
          ${isAdmin ? `<span class="comment-del" onclick="deleteComment('${slug}','${c.id}')">✕</span>` : ''}
        </div>
        <div class="comment-text">${esc(c.text)}</div>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '';
  }
}

async function submitComment(e) {
  e.preventDefault();
  const input = document.getElementById('comment-input');
  const text = input.value.trim();
  if (!text) return;
  await api('POST', `/api/comments/${currentSlug}`, { text });
  input.value = '';
  loadComments(currentSlug);
}

async function deleteComment(slug, id) {
  if (!confirm('Delete this comment?')) return;
  await api('DELETE', `/api/comments/${slug}/${id}`);
  loadComments(slug);
}

// ── HYPATIA ────────────────────────────────────────────────────────────────
let _hypatiaAvatars = {};
let _hypatiaState = 'idle';
let _listeningTimer = null;
let _hypatiaFonts = [];
let _hypatiaDefaultFont = null;
let _currentHypatiaFont = null;
const FONT_EXPRESSION_KEY = 'hypatia_font_expression';

const _HIDDEN_GREETINGS = [
  "The user just opened the chat. Say something brief and genuine to start — curious, warm, or a little unexpected. One or two sentences. Don't introduce yourself. Don't offer help. Don't reference this instruction.",
  "The user arrived. Open with a short, natural remark — maybe something interesting from the knowledge base, maybe just a thought. Keep it real, not formal. Don't say who you are.",
  "Start the conversation with something brief that feels like picking up where you left off. No intro, no 'how can I help'. Just begin.",
  "The user is here. Say something to kick things off — witty, curious, or warm. Two sentences max. Skip the self-introduction entirely.",
  "Open the chat naturally — like running into someone you know. Something brief, maybe a little dry humor or a sharp observation. Don't introduce yourself.",
  "The user just landed. Lead with something interesting — a thought, an observation, something from the knowledge base. Short. Natural. No formal intro.",
  "Begin. Something brief and genuine. The kind of thing you'd say to start a good conversation, not a help desk ticket.",
  "The user opened Hypatia. Greet them without introducing yourself — something real, short, and a little unexpected. One or two sentences.",
  "Say something to get things started — genuine, brief, maybe a bit playful. Pretend the conversation has already been going for a while.",
  "Open with a short remark that feels natural — not 'Hi I'm Hypatia' and not 'How can I help you today'. Something real. Keep it short.",
  "The user is here. Lead with curiosity or a quick observation. Skip the pleasantries and just begin. One or two sentences max.",
  "Start with something brief that makes the user want to talk. Warm but not sycophantic. Skip all self-introductions.",
  "Say something interesting to open the conversation. Reference something from the knowledge base if relevant, or just a thought. Short and natural.",
  "Open the chat. Not formally — just naturally. Something brief that feels genuine, not scripted.",
  "The user just arrived. Begin the conversation with one or two sentences — something real, a little unexpected, and without introducing yourself.",
];

async function loadHypatiaFonts() {
  try {
    const r = await api('GET', '/api/hypatia/fonts');
    _hypatiaFonts = r.fonts || [];
    _hypatiaDefaultFont = _hypatiaFonts.find(f => f.is_default) || null;
    for (const font of _hypatiaFonts) {
      if (font.url && !document.querySelector(`link[data-hfont="${font.id}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = font.url;
        link.setAttribute('data-hfont', font.id);
        document.head.appendChild(link);
      }
    }
  } catch {}
}

function isFontExpressionEnabled() {
  return localStorage.getItem(FONT_EXPRESSION_KEY) !== 'false';
}

function toggleFontExpression() {
  const next = !isFontExpressionEnabled();
  localStorage.setItem(FONT_EXPRESSION_KEY, next ? 'true' : 'false');
  if (!next) _currentHypatiaFont = null;
  _updateFontToggleBtn();
}

function _updateFontToggleBtn() {
  const btn = document.getElementById('font-toggle-btn');
  if (!btn) return;
  btn.style.display = _hypatiaFonts.length ? '' : 'none';
  const on = isFontExpressionEnabled();
  btn.classList.toggle('active', on);
  btn.title = on ? 'Font expression: on' : 'Font expression: off';
}

function _parseFontPrefix(text) {
  const match = text.match(/^FONT:([^\n]+)\n?/);
  if (!match) return { font: null, text };
  const name = match[1].trim();
  const known = _hypatiaFonts.find(f => f.name.toLowerCase() === name.toLowerCase());
  return { font: known ? known.name : null, text: text.slice(match[0].length).trim() };
}

function initHypatiaAvatar() {
  const wrap = document.getElementById('hypatia-avatar-top');
  if (!wrap) return;
  _hypatiaState = 'idle';
  const file = _hypatiaAvatars['idle'] || '';
  if (file) {
    const img = document.createElement('img');
    img.src = `/static/avatars/${encodeURIComponent(file)}`;
    img.alt = '';
    img.draggable = false;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity 0.7s ease';
    wrap.innerHTML = '';
    wrap.appendChild(img);
    requestAnimationFrame(() => requestAnimationFrame(() => { img.style.opacity = '1'; }));
  } else {
    wrap.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#b06ab3;font-size:26px;font-weight:900">H</div>';
  }
}

function setHypatiaState(state) {
  if (_hypatiaState === state) return;
  const file = _hypatiaAvatars[state] || _hypatiaAvatars['idle'] || '';
  if (!file) return;
  _hypatiaState = state;
  const wrap = document.getElementById('hypatia-avatar-top');
  if (!wrap) return;
  const img = wrap.querySelector('img');
  if (!img) { initHypatiaAvatar(); return; }
  img.style.transition = 'opacity 0.35s ease';
  img.style.opacity = '0';
  setTimeout(() => {
    img.src = `/static/avatars/${encodeURIComponent(file)}`;
    img.style.transition = 'opacity 0.45s ease';
    img.style.opacity = '1';
  }, 370);
}

function onChatInput() {
  setHypatiaState('listening');
  clearTimeout(_listeningTimer);
  _listeningTimer = setTimeout(() => {
    if (_hypatiaState === 'listening') setHypatiaState('idle');
  }, 2000);
}

const HYPATIA_SESSION_KEY = 'hypatia_session';
const HYPATIA_SESSION_TTL = 30 * 60 * 1000;

function _saveHypatiaSession() {
  try {
    sessionStorage.setItem(HYPATIA_SESSION_KEY, JSON.stringify({
      ts: Date.now(),
      history: chatHistory,
      currentFont: _currentHypatiaFont,
    }));
  } catch {}
}

function _loadHypatiaSession() {
  try {
    const raw = sessionStorage.getItem(HYPATIA_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.ts > HYPATIA_SESSION_TTL) {
      sessionStorage.removeItem(HYPATIA_SESSION_KEY);
      return null;
    }
    return data;
  } catch { return null; }
}

function showHome() {
  currentSlug = '__home__';
  showView('home');
  setActiveNav('__home__');
}

async function initRightSidebar() {
  if (!Object.keys(_hypatiaAvatars).length) {
    try {
      const r = await api('GET', '/api/hypatia/avatar');
      _hypatiaAvatars = r.avatars || {};
    } catch {}
  }

  await loadHypatiaFonts();
  initHypatiaAvatar();
  _updateFontToggleBtn();

  const session = _loadHypatiaSession();
  if (session && session.history.length) {
    chatHistory = session.history;
    _currentHypatiaFont = session.currentFont || null;
    const msgs = document.getElementById('chat-messages');
    msgs.innerHTML = '';
    msgs.classList.add('no-anim');
    for (const msg of chatHistory) {
      appendChatMsg(msg.role, msg.content);
    }
    msgs.classList.remove('no-anim');
    msgs.scrollTop = msgs.scrollHeight;
  } else {
    chatHistory = [];
    _currentHypatiaFont = null;
    document.getElementById('chat-messages').innerHTML = '';
    sendHiddenGreeting();
  }
}

async function sendHiddenGreeting() {
  const prompt = _HIDDEN_GREETINGS[Math.floor(Math.random() * _HIDDEN_GREETINGS.length)];
  setHypatiaState('thinking');
  const thinking = appendChatMsg('assistant', '…', 'thinking');
  try {
    const r = await api('POST', '/api/hypatia/chat', {
      messages: [{ role: 'user', content: prompt }],
      font_expression_enabled: isFontExpressionEnabled(),
    });
    await fadeOutMsg(thinking);
    const { font, text: clean } = _parseFontPrefix(r.reply);
    if (font) _currentHypatiaFont = font;
    appendChatMsg('assistant', clean || r.reply);
    chatHistory = [{ role: 'assistant', content: clean || r.reply }];
    _saveHypatiaSession();
    setHypatiaState('idle');
  } catch {
    await fadeOutMsg(thinking);
    appendChatMsg('assistant', "Something's stirring in the knowledge base… ask me anything.");
    setHypatiaState('idle');
  }
}

async function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  clearTimeout(_listeningTimer);
  appendChatMsg('user', text);
  chatHistory.push({ role: 'user', content: text });
  input.value = '';
  setHypatiaState('thinking');
  const thinking = appendChatMsg('assistant', '…', 'thinking');
  document.getElementById('chat-send').disabled = true;
  try {
    const r = await api('POST', '/api/hypatia/chat', {
      messages: chatHistory,
      font_expression_enabled: isFontExpressionEnabled(),
    });
    await fadeOutMsg(thinking);
    const { font, text: clean } = _parseFontPrefix(r.reply);
    if (font) _currentHypatiaFont = font;
    const reply = clean || r.reply;
    appendChatMsg('assistant', reply);
    chatHistory.push({ role: 'assistant', content: reply });
    _saveHypatiaSession();
    setHypatiaState('idle');
  } catch (ex) {
    await fadeOutMsg(thinking);
    appendChatMsg('assistant', '⚠ Could not reach Hypatia: ' + ex.message);
    setHypatiaState('idle');
  }
  document.getElementById('chat-send').disabled = false;
}

function fadeOutMsg(el) {
  return new Promise(resolve => {
    el.style.transition = 'opacity 0.5s ease';
    el.style.opacity = '0';
    setTimeout(() => { el.remove(); resolve(); }, 520);
  });
}

function appendChatMsg(role, text, state = null) {
  const msgs = document.getElementById('chat-messages');
  const isThinking = state === 'thinking';

  // Font
  let fontStyle = '';
  if (role === 'assistant' && !isThinking) {
    const fontName = isFontExpressionEnabled()
      ? (_currentHypatiaFont || _hypatiaDefaultFont?.name)
      : _hypatiaDefaultFont?.name;
    if (fontName) fontStyle = `font-family:'${fontName}',sans-serif;font-size:18px;`;
    else fontStyle = 'font-size:18px;';
  }

  const content = isThinking
    ? `<span class="chat-thinking">${esc(text)}</span>`
    : role === 'assistant' ? marked.parse(text) : `<p>${esc(text)}</p>`;

  const avatarHtml = role === 'assistant'
    ? `<div class="chat-avatar chat-avatar-hyp">HYP</div>`
    : `<div class="chat-avatar">${(currentUser?.sub?.[0] || 'U').toUpperCase()}</div>`;

  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `${avatarHtml}<div class="chat-bubble" style="${fontStyle}">${content}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('chat-form').dispatchEvent(new Event('submit'));
  }
}

// ── ADMIN PANEL ────────────────────────────────────────────────────────────
const ALL_ADMIN_TABS = ['profile','users','nav','sa-users','sa-site','sa-hypatia'];

function showAdminPanel() {
  showView('admin');
  const isAdmin = ['admin','superadmin'].includes(currentUser?.role);
  const isSuperAdmin = currentUser?.role === 'superadmin';
  ['users','nav'].forEach(id => {
    document.getElementById(`admin-tab-${id}`).style.display = isAdmin ? '' : 'none';
  });
  ['sa-users','sa-site','sa-hypatia'].forEach(id => {
    document.getElementById(`admin-tab-${id}`).style.display = isSuperAdmin ? '' : 'none';
  });
  document.getElementById('sa-divider').style.display = isSuperAdmin ? '' : 'none';
  // superadmin can create superadmin accounts
  const createRole = document.getElementById('create-role');
  if (isSuperAdmin && !createRole.querySelector('[value="superadmin"]')) {
    const opt = document.createElement('option');
    opt.value = 'superadmin'; opt.textContent = 'superadmin';
    createRole.appendChild(opt);
  }
  document.getElementById('profile-name').value = currentUser?.display_name || '';
  switchAdminTab('profile');
  if (isAdmin) loadAdminUsers();
}

function switchAdminTab(tab) {
  ALL_ADMIN_TABS.forEach(t => {
    document.getElementById(`admin-tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`admin-${t}`)?.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'nav') populateCategorySelect();
  if (tab === 'users') loadAdminUsers();
  if (tab === 'sa-users') loadSAUsers();
  if (tab === 'sa-site') loadSiteSettings();
  if (tab === 'sa-hypatia') loadHypatiaSettings();
}

async function saveProfile(event) {
  event.preventDefault();
  const name = document.getElementById('profile-name').value.trim();
  const msg = document.getElementById('profile-msg');
  try {
    await api('PATCH', '/api/auth/me', { display_name: name });
    currentUser.display_name = name;
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved';
    setTimeout(() => msg.textContent = '', 2000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Failed';
  }
}

async function changeOwnPassword(event) {
  event.preventDefault();
  const msg = document.getElementById('own-pw-msg');
  const nw = document.getElementById('own-pw-new').value;
  const conf = document.getElementById('own-pw-confirm').value;
  msg.textContent = '';
  if (nw !== conf) { msg.style.color='var(--danger)'; msg.textContent = 'Passwords do not match'; return; }
  try {
    await api('PATCH', '/api/auth/me/password', {
      old_password: document.getElementById('own-pw-current').value,
      new_password: nw
    });
    event.target.reset();
    msg.style.color = 'var(--green)';
    msg.textContent = 'Password changed';
    setTimeout(() => msg.textContent = '', 3000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Failed';
  }
}

async function adminCreateUser(event) {
  event.preventDefault();
  const msg = document.getElementById('create-user-msg');
  msg.textContent = '';
  const isSA = currentUser?.role === 'superadmin';
  const endpoint = isSA ? '/api/auth/superadmin/users/create' : '/api/auth/users/create';
  try {
    await api('POST', endpoint, {
      username: document.getElementById('create-email').value,
      password: document.getElementById('create-pass').value,
      display_name: document.getElementById('create-name').value,
      role: document.getElementById('create-role').value,
    });
    msg.style.color = 'var(--green)';
    msg.textContent = `Account created`;
    event.target.reset();
    loadAdminUsers();
    setTimeout(() => msg.textContent = '', 3000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Failed';
  }
}

async function loadAdminUsers() {
  try {
    const users = await api('GET', '/api/auth/users');
    const pending = users.filter(u => !u.approved);
    const approved = users.filter(u => u.approved);
    renderUserList('pending-users', pending, false, false);
    renderUserList('all-users', approved, true, false);
  } catch {}
}

function renderUserList(containerId, users, showRoleEdit, isSuperAdmin) {
  const el = document.getElementById(containerId);
  const prefix = isSuperAdmin ? 'sa' : 'admin';
  const apiPrefix = isSuperAdmin ? '/api/auth/superadmin' : '/api/auth';
  const isPending = containerId.includes('pending');
  const roles = isSuperAdmin ? ['user','editor','admin','superadmin'] : ['user','editor','admin'];

  if (!users.length) {
    el.innerHTML = `<div style="color:var(--subtext);font-size:13px">${isPending ? 'No pending requests' : 'No users'}</div>`;
    return;
  }

  el.innerHTML = users.map(u => {
    const safeKey = u.username.replace(/[@.]/g, '_');
    const isMe = u.username === currentUser?.sub;
    if (isPending) {
      return `
        <div class="user-row">
          <span class="uname">${esc(u.username)}</span>
          <span class="udisp">${esc(u.display_name)}</span>
          <select id="${prefix}-role-${safeKey}">
            ${roles.map(r => `<option value="${r}">${r}</option>`).join('')}
          </select>
          <button class="btn-approve" onclick="approveUser('${esc(u.username)}',${isSuperAdmin})">Approve</button>
          <button class="btn-danger" onclick="removeUser('${esc(u.username)}',${isSuperAdmin})">Deny</button>
        </div>`;
    }
    return `
      <div class="user-row" id="row-${safeKey}">
        <span class="uname">${esc(u.username)}</span>
        <span class="udisp" id="disp-${safeKey}">${esc(u.display_name)}</span>
        <span class="urole-badge">${esc(u.role)}</span>
        ${isMe ? '<span style="font-size:11px;color:var(--subtext)">you</span>' : ''}
        <button class="btn-ghost" style="font-size:12px;padding:5px 10px;margin-left:auto"
          onclick="toggleUserEdit('${esc(u.username)}','${safeKey}',${isSuperAdmin})">Edit</button>
      </div>
      <div class="user-edit-panel hidden" id="edit-${safeKey}">
        <div class="user-edit-grid">
          <label>Display Name
            <input type="text" id="ename-${safeKey}" value="${esc(u.display_name)}" autocomplete="off">
          </label>
          <label>Role
            <select id="erole-${safeKey}">
              ${roles.map(r => `<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
            </select>
          </label>
          <label>Reset Password
            <input type="password" id="epw-${safeKey}" placeholder="New password (leave blank to keep)">
          </label>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
          <button class="btn-primary" onclick="saveUserEdit('${esc(u.username)}','${safeKey}',${isSuperAdmin})">Save</button>
          <button class="btn-ghost" onclick="toggleUserEdit('${esc(u.username)}','${safeKey}',${isSuperAdmin})">Cancel</button>
          ${!isMe ? `<button class="btn-danger" style="margin-left:auto" onclick="removeUser('${esc(u.username)}',${isSuperAdmin})">Delete</button>` : ''}
          <span class="form-error" id="emsg-${safeKey}"></span>
        </div>
      </div>`;
  }).join('');
}

function toggleUserEdit(username, safeKey, isSuperAdmin) {
  document.getElementById(`edit-${safeKey}`).classList.toggle('hidden');
}

async function saveUserEdit(username, safeKey, isSuperAdmin) {
  const apiPrefix = isSuperAdmin ? '/api/auth/superadmin' : '/api/auth';
  const msg = document.getElementById(`emsg-${safeKey}`);
  msg.textContent = '';
  const enc = encodeURIComponent(username);
  try {
    const name = document.getElementById(`ename-${safeKey}`).value.trim();
    const role = document.getElementById(`erole-${safeKey}`).value;
    const pw   = document.getElementById(`epw-${safeKey}`).value;
    await api('PATCH', `${apiPrefix}/users/${enc}/display_name`, { display_name: name });
    await api('PATCH', `${apiPrefix}/users/${enc}/role`, { role });
    if (pw) await api('PATCH', `${apiPrefix}/users/${enc}/password`, { password: pw });
    isSuperAdmin ? loadSAUsers() : loadAdminUsers();
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Save failed';
  }
}

async function approveUser(username, isSuperAdmin = false) {
  const safeKey = username.replace('@','_');
  const prefix = isSuperAdmin ? 'sa' : 'admin';
  const roleEl = document.getElementById(`${prefix}-role-${safeKey}`);
  const role = roleEl ? roleEl.value : 'user';
  const endpoint = isSuperAdmin ? `/api/auth/superadmin/users/${encodeURIComponent(username)}/approve`
                                : `/api/auth/users/${encodeURIComponent(username)}/approve`;
  await api('POST', endpoint, { role });
  isSuperAdmin ? loadSAUsers() : loadAdminUsers();
}

async function removeUser(username, isSuperAdmin = false) {
  if (!confirm(`Remove user "${username}"?`)) return;
  const endpoint = isSuperAdmin ? `/api/auth/superadmin/users/${encodeURIComponent(username)}`
                                : `/api/auth/users/${encodeURIComponent(username)}`;
  await api('DELETE', endpoint);
  isSuperAdmin ? loadSAUsers() : loadAdminUsers();
}

async function setRole(username, role, isSuperAdmin = false) {
  const endpoint = isSuperAdmin ? `/api/auth/superadmin/users/${encodeURIComponent(username)}/role`
                                : `/api/auth/users/${encodeURIComponent(username)}/role`;
  await api('PATCH', endpoint, { role });
}

// ── SUPER ADMIN ────────────────────────────────────────────────────────────
// NOTE: All SA endpoints are protected server-side with require_role("superadmin").

async function loadSAUsers() {
  try {
    const users = await api('GET', '/api/auth/superadmin/users');
    const pending = users.filter(u => !u.approved);
    const approved = users.filter(u => u.approved);
    renderUserList('sa-pending-users', pending, false, true);
    renderUserList('sa-all-users', approved, true, true);
  } catch {}
}

async function loadSiteSettings() {
  try {
    const s = await api('GET', '/api/settings');
    document.getElementById('site-name-input').value = s.site_name || '';
    document.getElementById('site-tagline-input').value = s.site_tagline || '';
  } catch {}
}

async function saveSiteSettings(e) {
  e.preventDefault();
  await api('PUT', '/api/settings', {
    site_name: document.getElementById('site-name-input').value,
    site_tagline: document.getElementById('site-tagline-input').value,
  });
  loadPublicSettings();
  alert('Site settings saved.');
}

const AVATAR_STATES = [
  { key: 'idle',      label: 'Idle' },
  { key: 'listening', label: 'Listening' },
  { key: 'thinking',  label: 'Thinking' },
  { key: 'talking',   label: 'Talking' },
  { key: 'action',    label: 'Action' },
];
let _selectedAvatars = {};   // {idle:'', listening:'', ...} — admin working copy
let _allAvatarFiles = [];    // full file list for picker grid
let _expandedAvatarState = null; // which state's picker is open

async function loadHypatiaSettings() {
  try {
    const s = await api('GET', '/api/hypatia/settings');
    document.getElementById('system-prompt-input').value = s.system_prompt || '';
    _selectedAvatars = s.avatars || {};
  } catch {}
  try {
    const r = await api('GET', '/api/hypatia/models');
    renderModelCards(r.models || []);
  } catch {}
  try {
    const r = await api('GET', '/api/hypatia/avatars');
    _allAvatarFiles = r.avatars || [];
    _expandedAvatarState = null;
    renderAvatarStates();
  } catch {}
  try {
    const rf = await api('GET', '/api/hypatia/fonts');
    _fontCards = (rf.fonts || []).map(f => ({ ...f }));
    renderFontList();
  } catch {}
}

function renderAvatarStates() {
  const container = document.getElementById('avatar-states-list');
  let html = '';
  for (const { key, label } of AVATAR_STATES) {
    const file = _selectedAvatars[key] || '';
    const isOpen = _expandedAvatarState === key;
    const previewStyle = file ? `background-image:url('/static/avatars/${encodeURIComponent(file)}')` : '';
    html += `<div class="avatar-state-row">
      <div class="avatar-state-preview" style="${previewStyle}">${file ? '' : '?'}</div>
      <span class="avatar-state-label">${label}</span>
      <button class="btn-ghost btn-sm" onclick="toggleAvatarPicker('${key}')">${isOpen ? 'Close ▲' : 'Change ▾'}</button>
    </div>`;
    if (isOpen) {
      html += `<div class="avatar-state-grid">`;
      if (!_allAvatarFiles.length) {
        html += '<span style="color:var(--subtext);font-size:13px">No avatars found.</span>';
      } else {
        html += _allAvatarFiles.map(f => `
          <div class="avatar-option ${f === file ? 'selected' : ''}"
               onclick="selectStateAvatar('${key}','${f}')"
               style="background-image:url('/static/avatars/${encodeURIComponent(f)}')"></div>
        `).join('');
      }
      html += `</div>`;
    }
  }
  container.innerHTML = html;
}

function toggleAvatarPicker(key) {
  _expandedAvatarState = _expandedAvatarState === key ? null : key;
  renderAvatarStates();
}

function selectStateAvatar(key, filename) {
  _selectedAvatars[key] = filename;
  renderAvatarStates();
}

async function saveAvatars() {
  const msg = document.getElementById('avatar-save-msg');
  try {
    await api('PUT', '/api/hypatia/avatar', { avatars: _selectedAvatars });
    Object.assign(_hypatiaAvatars, _selectedAvatars);  // update chat cache
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved';
    setTimeout(() => msg.textContent = '', 2000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Failed';
  }
}

// ── Model Config ────────────────────────────────────────────────────────────

let _modelCards = [];

function renderModelCards(models) {
  _modelCards = models.map(m => ({ ...m }));
  _redrawModelLists();
}

function _redrawModelLists() {
  ['llm','embedding'].forEach(type => {
    const list = document.getElementById(`${type}-model-list`);
    const cards = _modelCards.filter(m => (m.type || 'llm') === type);
    if (!cards.length) {
      list.innerHTML = `<div style="color:var(--subtext);font-size:13px;padding:8px 0">No ${type} models configured.</div>`;
      return;
    }
    list.innerHTML = cards.map((m, i) => _modelCardHtml(m, i, type)).join('');
  });
}

function _modelCardHtml(m, idx, type) {
  const id = m.id || ('new-' + Math.random().toString(36).slice(2));
  if (!m.id) m.id = id;
  const providers = ['hdc','openrouter','pollinations'];
  return `
  <div class="model-card" id="mc-${id}">
    <div class="model-card-row">
      <label class="mc-label">Label
        <input type="text" value="${esc(m.label||'')}" autocomplete="off"
          oninput="_mcSet('${id}','label',this.value)" placeholder="My Model">
      </label>
      <label class="mc-label">Provider
        <select onchange="_mcSet('${id}','provider',this.value)">
          ${providers.map(p => `<option value="${p}" ${m.provider===p?'selected':''}>${p}</option>`).join('')}
        </select>
      </label>
      <label class="mc-label">Type
        <select onchange="_mcSet('${id}','type',this.value);_redrawModelLists()">
          <option value="llm" ${(m.type||'llm')==='llm'?'selected':''}>LLM (chat)</option>
          <option value="embedding" ${m.type==='embedding'?'selected':''}>Embedding</option>
        </select>
      </label>
      <label class="mc-label" style="display:flex;flex-direction:row;align-items:center;gap:6px;padding-top:18px">
        <input type="checkbox" ${m.enabled!==false?'checked':''} onchange="_mcSet('${id}','enabled',this.checked)"> Enabled
      </label>
      <div style="margin-left:auto;display:flex;gap:4px;padding-top:18px">
        <button class="btn-ghost" onclick="_mcMove('${id}',-1)" title="Move up">↑</button>
        <button class="btn-ghost" onclick="_mcMove('${id}',1)" title="Move down">↓</button>
        <button class="btn-danger" onclick="_mcRemove('${id}')">✕</button>
      </div>
    </div>
    <div class="model-card-row">
      <label class="mc-label" style="flex:2">API Endpoint
        <input type="text" value="${esc(m.api_endpoint||'')}" autocomplete="off"
          oninput="_mcSet('${id}','api_endpoint',this.value)" placeholder="https://openrouter.ai/api/v1">
      </label>
      <label class="mc-label" style="flex:2">API Token
        <input type="password" value="${esc(m.api_token||'')}" autocomplete="new-password"
          oninput="_mcSet('${id}','api_token',this.value)" placeholder="sk-… (leave blank if none)">
      </label>
      <label class="mc-label" style="flex:2">Model Name
        <div style="display:flex;gap:4px">
          <select id="mn-${id}" onchange="_mcSet('${id}','model_name',this.value)" style="flex:1">
            ${m.model_name ? `<option value="${esc(m.model_name)}" selected>${esc(m.model_name)}</option>` : '<option value="">— fetch models —</option>'}
          </select>
          <button class="btn-ghost" onclick="_fetchModels('${id}')" title="Fetch available models">⟳</button>
          <button class="btn-ghost" onclick="_testModel('${id}')" id="test-btn-${id}" title="Test connection">Test</button>
        </div>
        <div id="test-msg-${id}" style="font-size:12px;margin-top:4px;min-height:16px"></div>
      </label>
    </div>
  </div>`;
}

function _mcSet(id, key, val) {
  const m = _modelCards.find(m => m.id === id);
  if (m) m[key] = val;
}

function _mcMove(id, dir) {
  const cards = _modelCards;
  const idx = cards.findIndex(m => m.id === id);
  const type = cards[idx].type || 'llm';
  // find next/prev card of same type
  const sameType = cards.map((m,i) => ({m,i})).filter(({m}) => (m.type||'llm') === type);
  const pos = sameType.findIndex(({i}) => i === idx);
  const swapPos = pos + dir;
  if (swapPos < 0 || swapPos >= sameType.length) return;
  const swapIdx = sameType[swapPos].i;
  [cards[idx], cards[swapIdx]] = [cards[swapIdx], cards[idx]];
  _redrawModelLists();
}

function _mcRemove(id) {
  _modelCards = _modelCards.filter(m => m.id !== id);
  _redrawModelLists();
}

function addModelCard(type) {
  _modelCards.push({
    id: 'new-' + Math.random().toString(36).slice(2),
    label: '', api_endpoint: '', api_token: '',
    model_name: '', type, provider: 'hdc', enabled: true
  });
  _redrawModelLists();
}

async function _fetchModels(id) {
  const m = _modelCards.find(m => m.id === id);
  if (!m) return;
  const sel = document.getElementById(`mn-${id}`);
  sel.innerHTML = '<option>Fetching…</option>';
  try {
    const r = await api('POST', '/api/hypatia/fetch-models', {
      provider: m.provider,
      api_endpoint: m.api_endpoint,
      api_token: m.api_token,
    });
    sel.innerHTML = r.models.map(mod =>
      `<option value="${esc(mod.id)}" ${mod.id===m.model_name?'selected':''}>${esc(mod.name)}</option>`
    ).join('');
    if (!m.model_name && r.models.length) {
      m.model_name = r.models[0].id;
      sel.value = m.model_name;
    }
  } catch(e) {
    sel.innerHTML = `<option value="${esc(m.model_name||'')}">Error: ${esc(e.message||'fetch failed')}</option>`;
  }
}

async function _testModel(id) {
  const m = _modelCards.find(m => m.id === id);
  if (!m) return;
  const btn = document.getElementById(`test-btn-${id}`);
  const msg = document.getElementById(`test-msg-${id}`);
  btn.textContent = '…'; btn.disabled = true;
  msg.style.color = 'var(--subtext)'; msg.textContent = 'Testing…';
  try {
    const r = await api('POST', '/api/hypatia/test-model', {
      api_endpoint: m.api_endpoint,
      api_token: m.api_token,
      model_name: m.model_name,
      type: m.type || 'llm',
    });
    msg.style.color = 'var(--green)';
    msg.textContent = r.reply ? `✓ Connected — "${r.reply}"` : '✓ Connected';
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = `✗ ${e.message || 'Connection failed'}`;
  } finally {
    btn.textContent = 'Test'; btn.disabled = false;
  }
}

async function saveModelConfig() {
  const msg = document.getElementById('model-save-msg');
  msg.textContent = '';
  try {
    await api('PUT', '/api/hypatia/models', { models: _modelCards });
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved';
    setTimeout(() => msg.textContent = '', 2000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Save failed';
  }
}

async function saveSystemPrompt(e) {
  e.preventDefault();
  await api('PUT', '/api/hypatia/settings', {
    system_prompt: document.getElementById('system-prompt-input').value,
  });
  alert('System prompt saved.');
}

// ── FONT ADMIN ──────────────────────────────────────────────────────────────
let _fontCards = [];

function renderFontList() {
  const container = document.getElementById('font-list');
  if (!container) return;
  if (!_fontCards.length) {
    container.innerHTML = '<div style="color:var(--subtext);font-size:13px;padding:8px 0">No fonts configured. Add one below.</div>';
    return;
  }
  container.innerHTML = _fontCards.map(f => `
    <div class="font-card">
      <div class="font-preview" style="font-family:'${esc(f.name)}',sans-serif">
        The quick brown fox jumps over the lazy dog — <em>Hypatia</em>
      </div>
      <div class="font-card-row">
        <span class="font-name-label">${esc(f.name)}</span>
        <input class="font-vibe-input" type="text" value="${esc(f.vibe)}" placeholder="vibe (e.g. thoughtful, excited…)" oninput="_fcSetVibe('${f.id}',this.value)">
        <label class="font-default-label"><input type="radio" name="font-default" value="${f.id}" ${f.is_default ? 'checked' : ''} onchange="_fcSetDefault('${f.id}')"> Default</label>
        <button class="btn-ghost btn-sm" onclick="_fcRemove('${f.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

function _fcSetVibe(id, vibe) {
  const f = _fontCards.find(f => f.id === id);
  if (f) f.vibe = vibe;
}

function _fcSetDefault(id) {
  _fontCards.forEach(f => f.is_default = (f.id === id));
}

function _fcRemove(id) {
  _fontCards = _fontCards.filter(f => f.id !== id);
  renderFontList();
}

async function addFontCard() {
  const input = document.getElementById('add-font-input');
  const raw = input.value.trim();
  if (!raw) return;
  let name, url;
  if (raw.startsWith('http')) {
    // fonts.google.com/specimen/Font+Name  (specimen browser page)
    const specimenMatch = raw.match(/fonts\.google\.com\/specimen\/([^?&#]+)/);
    if (specimenMatch) {
      name = decodeURIComponent(specimenMatch[1].replace(/\+/g, ' '));
      url = `https://fonts.googleapis.com/css2?family=${specimenMatch[1]}&display=swap`;
    } else {
      // fonts.googleapis.com/css2?family=Font+Name  (API URL)
      const match = raw.match(/family=([^:&]+)/);
      if (!match) { alert('Could not extract font name from URL'); return; }
      name = decodeURIComponent(match[1].replace(/\+/g, ' '));
      const u = new URL(raw);
      u.searchParams.delete('text');
      u.searchParams.delete('subset');
      if (!u.searchParams.has('display')) u.searchParams.set('display', 'swap');
      url = u.toString();
    }
  } else {
    name = raw;
    url = `https://fonts.googleapis.com/css2?family=${raw.replace(/ /g, '+')}&display=swap`;
  }
  if (_fontCards.find(f => f.name.toLowerCase() === name.toLowerCase())) {
    alert('Font already in list'); return;
  }
  if (!document.querySelector(`link[href="${url}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = url;
    document.head.appendChild(link);
  }
  _fontCards.push({
    id: '_' + Math.random().toString(36).slice(2),
    name, url, vibe: '',
    is_default: _fontCards.length === 0,
  });
  input.value = '';
  renderFontList();
}

async function saveFonts() {
  const msg = document.getElementById('font-save-msg');
  try {
    await api('PUT', '/api/hypatia/fonts', { fonts: _fontCards });
    _hypatiaFonts = [..._fontCards];
    _hypatiaDefaultFont = _fontCards.find(f => f.is_default) || null;
    _updateFontToggleBtn();
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved';
    setTimeout(() => msg.textContent = '', 2000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Failed';
  }
}

// ── PASSWORD MODAL ─────────────────────────────────────────────────────────
function openPasswordModal(username, isSuperAdmin = false) {
  pwTargetUser = username;
  pwIsSuperAdmin = isSuperAdmin;
  document.getElementById('pw-modal-email').textContent = username;
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-confirm').value = '';
  document.getElementById('pw-error').textContent = '';
  document.getElementById('pw-modal').classList.remove('hidden');
}

function closePasswordModal() {
  document.getElementById('pw-modal').classList.add('hidden');
  pwTargetUser = null;
}

async function submitPasswordChange(e) {
  e.preventDefault();
  const pw = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;
  const err = document.getElementById('pw-error');
  err.textContent = '';
  if (pw !== confirm) { err.textContent = 'Passwords do not match'; return; }
  if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }
  try {
    const endpoint = pwIsSuperAdmin
      ? `/api/auth/superadmin/users/${encodeURIComponent(pwTargetUser)}/password`
      : `/api/auth/users/${encodeURIComponent(pwTargetUser)}/password`;
    await api('PATCH', endpoint, { password: pw });
    closePasswordModal();
  } catch (ex) {
    err.textContent = ex.message || 'Failed to update password';
  }
}

// ── NAV ADMIN ──────────────────────────────────────────────────────────────
function populateCategorySelect() {
  if (!navData) return;
  const catSel = document.getElementById('new-page-cat');
  if (!catSel) return;
  catSel.innerHTML = '<option value="">Select category…</option>' +
    (navData.categories || []).map(c =>
      `<option value="${c.slug}">${esc(c.display_name||c.name)}</option>`
    ).join('');
  catSel.onchange = () => populateParentSelect(catSel.value);
}

function populateParentSelect(catSlug) {
  const sel = document.getElementById('new-page-parent');
  if (!sel) return;
  const cat = (navData?.categories || []).find(c => c.slug === catSlug);
  sel.innerHTML = '<option value="">Top-level page (no parent)</option>' +
    (cat?.pages || []).map(p =>
      `<option value="${p.slug}">${esc(p.display_name||p.name)}</option>`
    ).join('');
}

async function addCategory(e) {
  e.preventDefault();
  const name = document.getElementById('new-cat-name').value.trim();
  if (!name) return;
  await api('POST', '/api/nav/category', { name });
  document.getElementById('new-cat-name').value = '';
  await loadNav();
  populateCategorySelect();
}

async function addPage(e) {
  e.preventDefault();
  const name = document.getElementById('new-page-name').value.trim();
  const cat = document.getElementById('new-page-cat').value;
  const parent = document.getElementById('new-page-parent').value;
  if (!name || !cat) return;
  await api('POST', '/api/nav/page', { name, category_slug: cat, parent_slug: parent || null });
  document.getElementById('new-page-name').value = '';
  await loadNav();
  populateCategorySelect();
}

// ── VIEW SWITCHER ──────────────────────────────────────────────────────────
function showView(view) {
  ['page','edit','home','admin','dropbox'].forEach(v => {
    document.getElementById(`${v}-view`).classList.toggle('hidden', v !== view);
  });
  // Hide right sidebar on admin only
  document.getElementById('app').classList.toggle('no-right-sidebar', view === 'admin');
}

function showDropbox() {
  currentSlug = '__dropbox__';
  showView('dropbox');
  setActiveNav('__dropbox__');
  switchDropboxTab('files');
  libraryLoadFiles();
}

function switchDropboxTab(tab) {
  ['files','summaries','search','upload'].forEach(t => {
    document.getElementById(`dtab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`dropbox-tab-${t}`).classList.toggle('hidden', t !== tab);
  });
}

// ── LIBRARY FILE CATALOG ────────────────────────────────────────────────────

const _FILE_ICONS = {
  pdf: '📄', docx: '📝', doc: '📝', pptx: '📊',
  xlsx: '📈', xls: '📈', csv: '📋', odt: '📄', txt: '📃', md: '📃',
};
function _fileIcon(ext) { return _FILE_ICONS[ext?.toLowerCase()] || '📁'; }
function _fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}
function _fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'});
}

// ── Document viewer ──────────────────────────────────────────────────────

function _showLibraryDoc() {
  document.getElementById('library-doc-view').classList.remove('hidden');
  document.getElementById('library-tabbed').classList.add('hidden');
}
function libraryCloseDoc() {
  document.getElementById('library-doc-view').classList.add('hidden');
  document.getElementById('library-tabbed').classList.remove('hidden');
}

async function libraryViewDoc(fileId, filename) {
  document.getElementById('library-doc-nav-title').textContent = filename;
  document.getElementById('library-doc-content').innerHTML =
    '<div class="dropbox-empty">Loading document…</div>';
  _showLibraryDoc();
  try {
    const r = await api('GET', `/api/library/files/${fileId}/markdown`);
    // Clean up page markers to look nicer when rendered
    const cleaned = r.markdown
      .replace(/^### Page (\d+) ###/gm, '---\n*Page $1*')
      .replace(/^### Slide (\d+)(?:: (.+?))? ###/gm, (_, n, t) =>
        `---\n*Slide ${n}${t ? ': ' + t : ''}*`)
      .replace(/^### Sheet: (.+?) ###/gm, '---\n*Sheet: $1*')
      .replace(/^### CSV Data ###/gm, '---\n*CSV Data*');
    document.getElementById('library-doc-content').innerHTML = marked.parse(cleaned);
  } catch(e) {
    document.getElementById('library-doc-content').innerHTML =
      `<div class="dropbox-empty">Could not load document: ${e.message}</div>`;
  }
}

// ── Files tab ────────────────────────────────────────────────────────────

async function libraryLoadFiles() {
  const el = document.getElementById('library-file-list');
  try {
    const r = await api('GET', '/api/library/files');
    const files = r.files || [];
    if (!files.length) {
      el.innerHTML = '<div class="dropbox-empty">No files yet. Upload some documents.</div>';
      return;
    }
    el.innerHTML = `
      <table class="library-table">
        <thead><tr>
          <th>File</th><th>Uploaded By</th><th>File Date</th>
          <th>Upload Date</th><th>Size</th><th>Pages</th><th></th>
        </tr></thead>
        <tbody>
          ${files.map(f => `
            <tr class="library-row">
              <td class="library-filename">
                <span class="library-ext-icon">${_fileIcon(f.extension)}</span>
                <button class="library-filename-link" onclick="libraryViewDoc('${f.id}','${esc(f.original_filename)}')">${esc(f.original_filename)}</button>
              </td>
              <td>${esc(f.uploaded_by || '—')}</td>
              <td>${_fmtDate(f.file_date)}</td>
              <td>${_fmtDate(f.upload_date)}</td>
              <td>${_fmtSize(f.file_size_bytes)}</td>
              <td>${f.page_count || '—'}</td>
              <td class="library-actions">
                <button class="btn-ghost" onclick="libraryViewSummary('${f.id}','${esc(f.original_filename)}')">Summary</button>
                <button class="btn-ghost danger" onclick="libraryDeleteFile('${f.id}','${esc(f.original_filename)}')">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    el.innerHTML = `<div class="dropbox-empty">Error loading files: ${e.message}</div>`;
  }
}

// ── Summary tab ──────────────────────────────────────────────────────────

async function libraryViewSummary(fileId, filename) {
  switchDropboxTab('summaries');
  const el = document.getElementById('library-summaries-list');
  el.innerHTML = '<div class="dropbox-empty">Loading…</div>';
  try {
    const f = await api('GET', `/api/library/files/${fileId}`);

    // Build the report as markdown then render it
    const lines = [
      `# ${f.original_filename}`,
      '',
      `**Uploaded by:** ${f.uploaded_by || '—'} &nbsp;·&nbsp; **Upload date:** ${_fmtDate(f.upload_date)} &nbsp;·&nbsp; **File date:** ${_fmtDate(f.file_date)} &nbsp;·&nbsp; **Pages:** ${f.page_count || 0} &nbsp;·&nbsp; **Size:** ${_fmtSize(f.file_size_bytes)}`,
      '',
      '---',
      '',
      '## Executive Summary',
      '',
      f.summary || '*No summary available.*',
      '',
    ];

    if (f.key_points?.length) {
      lines.push('## Key Points', '');
      f.key_points.forEach(p => lines.push(`- ${p}`));
      lines.push('');
    }

    if (f.claims?.length) {
      lines.push('## Claims & Assertions', '');
      f.claims.forEach(c => lines.push(`- ${c}`));
      lines.push('');
    }

    lines.push(
      '---',
      '',
      `<button class="btn-ghost" onclick="libraryViewDoc('${f.id}','${esc(f.original_filename)}')" style="margin-bottom:24px">View Full Document →</button>`,
      '',
    );

    // Overlaps placeholder — will be filled async below
    const overlapId = `overlaps-${fileId}`;
    lines.push(
      `<div id="${overlapId}" class="library-overlaps-section">` +
      `<div class="library-overlap-checking"><span class="library-overlap-spinner"></span> Checking for related content…</div></div>`
    );

    el.innerHTML = `<div class="library-summary-card markdown-body">${marked.parse(lines.join('\n'))}</div>`;

    // Async overlap check
    _loadOverlaps(fileId, overlapId);
  } catch(e) {
    el.innerHTML = `<div class="dropbox-empty">Error: ${e.message}</div>`;
  }
}

async function _loadOverlaps(fileId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  try {
    const r = await api('GET', `/api/library/files/${fileId}/overlaps`);
    const items = r.library || [];
    if (!items.length) {
      el.innerHTML = '<p class="library-overlap-none">No related content found in the library.</p>';
      return;
    }
    el.innerHTML = `
      <h2>Related Library Files</h2>
      ${items.map(item => `
        <div class="library-overlap-item">
          <div class="library-overlap-header">
            <span class="library-overlap-name">${_fileIcon(item.original_filename?.split('.').pop())}
              <button class="library-filename-link" onclick="libraryViewSummary('${item.file_id}','${esc(item.original_filename)}')">${esc(item.original_filename)}</button>
            </span>
            <span class="library-overlap-score">${Math.round(item.score * 100)}% match</span>
          </div>
          <p class="library-overlap-snippet">${esc(item.snippet)}…</p>
        </div>`).join('')}`;
  } catch(e) {
    el.innerHTML = '<p class="library-overlap-none">Could not check for related content.</p>';
  }
}

async function libraryDeleteFile(fileId, filename) {
  if (!confirm(`Delete "${filename}"? This will remove it from storage and the search index.`)) return;
  try {
    await api('DELETE', `/api/library/files/${fileId}`);
    libraryLoadFiles();
  } catch(e) {
    alert(`Delete failed: ${e.message}`);
  }
}

async function librarySearch(e) {
  e.preventDefault();
  const query = document.getElementById('library-search-input').value.trim();
  if (!query) return;
  const el = document.getElementById('library-search-results');
  el.innerHTML = '<div class="dropbox-empty">Searching…</div>';
  try {
    const r = await api('POST', '/api/library/search', {query, limit: 20});
    const results = r.results || [];
    if (!results.length) {
      el.innerHTML = '<div class="dropbox-empty">No results found.</div>';
      return;
    }
    el.innerHTML = results.map(r => `
      <div class="library-search-result">
        <div class="library-search-result-header">
          <span class="library-search-filename">${esc(r.original_filename)}</span>
          <span class="library-search-page">${r.page_title ? esc(r.page_title) : `Page ${r.page_number}`}</span>
          <span class="library-search-score">${(r.score * 100).toFixed(0)}%</span>
        </div>
        <div class="library-search-snippet">${esc(r.snippet)}</div>
      </div>`).join('');
  } catch(e) {
    el.innerHTML = `<div class="dropbox-empty">Search error: ${e.message}</div>`;
  }
}

// Upload
function libraryDragOver(e) {
  e.preventDefault();
  document.getElementById('library-dropzone').classList.add('drag-over');
}
function libraryDragLeave(e) {
  document.getElementById('library-dropzone').classList.remove('drag-over');
}
function libraryDrop(e) {
  e.preventDefault();
  document.getElementById('library-dropzone').classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (files?.length) libraryUploadFile(files[0]);
}
function libraryFileSelected(input) {
  if (input.files?.length) libraryUploadFile(input.files[0]);
  input.value = '';
}

async function libraryUploadFile(file) {
  const jobsEl = document.getElementById('library-upload-jobs');
  const jobEl = document.createElement('div');
  jobEl.className = 'library-job';
  jobEl.innerHTML = `
    <div class="library-job-name">${_fileIcon(file.name.split('.').pop())} ${esc(file.name)}</div>
    <div class="library-job-stage">Uploading…</div>
    <div class="library-job-bar"><div class="library-job-progress"></div></div>`;
  jobsEl.prepend(jobEl);

  const stageEl = jobEl.querySelector('.library-job-stage');
  const progressEl = jobEl.querySelector('.library-job-progress');

  const stages = {
    pending: [5, 'Queued…'],
    running: [30, null],
    done: [100, 'Complete ✓'],
    failed: [100, null],
  };

  try {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/api/library/upload', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || resp.statusText);
    }
    const {job_id} = await resp.json();
    progressEl.style.width = '15%';

    // Poll job status
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      const job = await api('GET', `/api/library/jobs/${job_id}`);
      const [pct, label] = stages[job.status] || [30, job.stage];
      progressEl.style.width = `${pct}%`;
      stageEl.textContent = label ?? job.stage;

      if (job.status === 'done') {
        jobEl.classList.add('done');
        libraryLoadFiles();
        break;
      }
      if (job.status === 'failed') {
        jobEl.classList.add('failed');
        stageEl.textContent = `Failed: ${job.error || 'unknown error'}`;
        break;
      }
    }
  } catch(e) {
    jobEl.classList.add('failed');
    stageEl.textContent = `Error: ${e.message}`;
    progressEl.style.width = '100%';
  }
}

// ── UTILS ──────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) {
    // Session gone or expired — force back to login
    currentUser = null;
    showAuthOverlay();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}
