// ── STATE ──────────────────────────────────────────────────────────────────
let currentUser = null;
let currentSlug = null;
let chatHistory = [];
let navData = null;
let pwTargetUser = null;   // username being changed in the modal
let pwIsSuperAdmin = false; // which endpoint to call

// ── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) lucide.createIcons();
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

  if (isAdmin) document.getElementById('admin-btn').style.display = '';
  if (isSuperAdmin) document.getElementById('superadmin-access-btn').classList.remove('hidden');

  loadPublicSettings();
  loadNav();
  if (window.lucide) lucide.createIcons();
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

  html += `<div class="nav-link hypatia" onclick="showHypatia()">🧠 Hypatia</div>`;

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
function showHypatia() {
  currentSlug = '__hypatia__';
  showView('hypatia');
  setActiveNav('__hypatia__');
  if (!chatHistory.length) {
    appendChatMsg('assistant', "Hi — I'm Hypatia. Ask me anything about Synapse6, the product, the team, or any topic in the knowledge base.");
  }
}

async function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  appendChatMsg('user', text);
  chatHistory.push({ role: 'user', content: text });
  input.value = '';
  const thinking = appendChatMsg('assistant', '…', true);
  document.getElementById('chat-send').disabled = true;
  try {
    const r = await api('POST', '/api/hypatia/chat', { messages: chatHistory });
    thinking.remove();
    appendChatMsg('assistant', r.reply);
    chatHistory.push({ role: 'assistant', content: r.reply });
  } catch (ex) {
    thinking.remove();
    appendChatMsg('assistant', '⚠ Could not reach Hypatia: ' + ex.message);
  }
  document.getElementById('chat-send').disabled = false;
}

function appendChatMsg(role, text, thinking = false) {
  const msgs = document.getElementById('chat-messages');
  const initials = role === 'user' ? (currentUser?.sub?.[0] || 'U').toUpperCase() : 'H';
  const content = thinking
    ? `<span class="chat-thinking">${esc(text)}</span>`
    : role === 'assistant' ? marked.parse(text) : `<p>${esc(text)}</p>`;
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `<div class="chat-avatar">${initials}</div><div class="chat-bubble">${content}</div>`;
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
function showAdminPanel(tab = 'users') {
  showView('admin');
  switchAdminTab(tab);
  loadAdminUsers();
  populateCategorySelect();
}

function switchAdminTab(tab) {
  ['users','nav'].forEach(t => {
    document.getElementById(`admin-tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`admin-${t}`)?.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'nav') populateCategorySelect();
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

  if (!users.length) {
    el.innerHTML = `<div style="color:var(--subtext);font-size:13px">${isPending ? 'No pending requests' : 'No users'}</div>`;
    return;
  }

  el.innerHTML = users.map(u => `
    <div class="user-row">
      <span class="uname">${esc(u.username)}</span>
      <span class="udisp">${esc(u.display_name)}</span>
      ${isPending ? `
        <select id="${prefix}-role-${u.username.replace('@','_')}">
          <option value="user">user</option>
          <option value="editor">editor</option>
          <option value="admin">admin</option>
          ${isSuperAdmin ? '<option value="superadmin">superadmin</option>' : ''}
        </select>
        <button class="btn-approve" onclick="approveUser('${esc(u.username)}',${isSuperAdmin})">Approve</button>
        <button class="btn-danger" onclick="removeUser('${esc(u.username)}',${isSuperAdmin})">Deny</button>
      ` : `
        ${showRoleEdit ? `
          <select onchange="setRole('${esc(u.username)}',this.value,${isSuperAdmin})">
            ${['user','editor','admin'].map(r => `<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
            ${isSuperAdmin ? `<option value="superadmin" ${u.role==='superadmin'?'selected':''}>superadmin</option>` : ''}
          </select>
        ` : ''}
        <button class="btn-ghost" style="font-size:12px;padding:5px 10px" onclick="openPasswordModal('${esc(u.username)}',${isSuperAdmin})">🔑 Password</button>
        ${u.username !== currentUser?.sub
          ? `<button class="btn-danger" onclick="removeUser('${esc(u.username)}',${isSuperAdmin})">Remove</button>`
          : '<span style="font-size:11px;color:var(--subtext)">you</span>'}
      `}
    </div>
  `).join('');
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
// The view is only shown if role === 'superadmin', but the protection is in the API.

function switchSATab(tab) {
  ['users','site','hypatia'].forEach(t => {
    document.getElementById(`sa-tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`sa-${t}`)?.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'site') loadSiteSettings();
  if (tab === 'hypatia') loadHypatiaSettings();
}

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

async function loadHypatiaSettings() {
  try {
    const s = await api('GET', '/api/hypatia/settings');
    document.getElementById('system-prompt-input').value = s.system_prompt || '';
  } catch {}
}

async function saveSystemPrompt(e) {
  e.preventDefault();
  await api('PUT', '/api/hypatia/settings', {
    system_prompt: document.getElementById('system-prompt-input').value,
  });
  alert('System prompt saved.');
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
  ['page','edit','hypatia','admin','superadmin'].forEach(v => {
    document.getElementById(`${v}-view`).classList.toggle('hidden', v !== view);
  });
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
