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

const IS_POPOUT = new URLSearchParams(window.location.search).has('popout');

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(localStorage.getItem('theme') || 'dark');
  marked.setOptions({ gfm: true, breaks: true });
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
  if (IS_POPOUT) {
    document.body.classList.add('chat-popout');
    document.title = 'Hypatia';
  } else {
    // Load allowed domain hint for registration form
    try {
      const d = await api('GET', '/api/auth/domain');
      document.getElementById('reg-domain-hint').textContent = `Requires a @${d.domain} email address`;
    } catch {}
  }
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

  if (IS_POPOUT) {
    initRightSidebar();
    return;
  }
  loadPublicSettings();
  loadNav();
  initRightSidebar();
  showHome();
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

let _searchDebounce = null;

function filterNav(q) {
  // Instant client-side nav filter
  const lq = q.toLowerCase();
  document.querySelectorAll('.nav-link').forEach(el => {
    el.style.display = (!lq || el.textContent.toLowerCase().includes(lq)) ? '' : 'none';
  });
  // Debounced Qdrant search
  clearTimeout(_searchDebounce);
  const panel = document.getElementById('search-results-panel');
  if (q.length < 2) { panel.classList.add('hidden'); return; }
  _searchDebounce = setTimeout(() => _runSearch(q), 380);
}

function searchKeydown(e) {
  if (e.key === 'Escape') {
    document.getElementById('search-results-panel').classList.add('hidden');
    document.getElementById('search').value = '';
    filterNav('');
  }
}

async function _runSearch(q) {
  const panel = document.getElementById('search-results-panel');
  panel.innerHTML = '<div class="search-result-loading">Searching…</div>';
  panel.classList.remove('hidden');
  try {
    const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=8`);
    if (!r.results || r.results.length === 0) {
      panel.innerHTML = '<div class="search-result-empty">No pages found</div>';
      return;
    }
    panel.innerHTML = r.results.map(res => {
      const sub = res.heading && res.heading !== res.title
        ? `<span class="sr-heading"> › ${esc(res.heading)}</span>` : '';
      const snippet = res.snippet ? `<div class="sr-snippet">${esc(res.snippet)}</div>` : '';
      return `<div class="search-result-item" onclick="_searchNav('${esc(res.slug)}')">
        <div class="sr-title">${esc(res.title)}${sub}</div>
        ${snippet}
      </div>`;
    }).join('');
  } catch {
    panel.innerHTML = '<div class="search-result-empty">Search unavailable</div>';
  }
}

function _searchNav(slug) {
  document.getElementById('search-results-panel').classList.add('hidden');
  document.getElementById('search').value = '';
  filterNav('');
  // Find the nav entry and click it if present, otherwise navigate directly
  const navEl = document.getElementById(`nav-${slug}`);
  if (navEl) {
    navEl.click();
  } else {
    loadPage(slug, '', slug);
  }
}

function setActiveNav(slug) {
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
  const el = document.getElementById(`nav-${slug}`);
  if (el) el.classList.add('active');
}

// ── QUICK CREATE ────────────────────────────────────────────────────────────
function closeQuickModals() {
  document.getElementById('qp-modal').classList.add('hidden');
  document.getElementById('qc-modal').classList.add('hidden');
}

function openQuickPage() {
  const cats = (navData?.categories || []);
  const catSel = document.getElementById('qp-category');
  const parentSel = document.getElementById('qp-parent');
  catSel.innerHTML = cats.map(c => `<option value="${esc(c.slug)}">${esc(c.display_name || c.name)}</option>`).join('');
  parentSel.innerHTML = '<option value="">— none —</option>';
  // populate parent options from selected category
  function refreshParents() {
    const slug = catSel.value;
    const cat = cats.find(c => c.slug === slug);
    const pages = cat?.pages || [];
    parentSel.innerHTML = '<option value="">— none —</option>' +
      pages.map(p => `<option value="${esc(p.slug)}">${esc(p.display_name || p.name)}</option>`).join('');
  }
  catSel.onchange = refreshParents;
  refreshParents();
  document.getElementById('qp-name').value = '';
  document.getElementById('qp-err').textContent = '';
  document.getElementById('qp-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('qp-name').focus(), 50);
}

function openQuickCategory() {
  document.getElementById('qc-name').value = '';
  document.getElementById('qc-err').textContent = '';
  document.getElementById('qc-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('qc-name').focus(), 50);
}

async function submitQuickPage(e) {
  e.preventDefault();
  const err = document.getElementById('qp-err');
  err.textContent = '';
  const name = document.getElementById('qp-name').value.trim();
  const category_slug = document.getElementById('qp-category').value;
  const parent_slug = document.getElementById('qp-parent').value || null;
  try {
    const r = await api('POST', '/api/nav/page', { name, category_slug, ...(parent_slug ? { parent_slug } : {}) });
    closeQuickModals();
    await loadNav();
    // Open the new page directly in edit mode
    const cat = (navData?.categories || []).find(c => c.slug === category_slug);
    loadPage(r.slug, cat?.display_name || cat?.name || '', name);
    setTimeout(enterEditMode, 300);
  } catch (ex) {
    err.textContent = ex.message || 'Failed to create page';
  }
}

async function submitQuickCategory(e) {
  e.preventDefault();
  const err = document.getElementById('qc-err');
  err.textContent = '';
  const name = document.getElementById('qc-name').value.trim();
  try {
    await api('POST', '/api/nav/category', { name });
    closeQuickModals();
    await loadNav();
  } catch (ex) {
    err.textContent = ex.message || 'Failed to create category';
  }
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
    renderMermaid(content);
    renderHistory(slug, data.versions || []);
    renderPageMeta(data.current_version);
    const isEditor = ['editor','admin','superadmin'].includes(currentUser?.role);
    document.getElementById('edit-btn').classList.toggle('hidden', !isEditor);
    document.getElementById('history-btn').classList.toggle('hidden', !isEditor || !data.versions?.length);
    loadComments(slug);
  } catch (ex) {
    document.getElementById('page-meta').textContent = '';
    content.innerHTML = `<p style="color:var(--subtext)">${ex.message === 'Page not found' ? '*(No content yet — click Edit to start writing)*' : 'Error loading page'}</p>`;
    loadComments(slug);
  }
}

function renderPageMeta(version) {
  const el = document.getElementById('page-meta');
  if (!version || !version.timestamp) { el.textContent = ''; return; }
  const date = new Date(version.timestamp * 1000).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });
  const editor = version.editor || 'unknown';
  el.innerHTML = `Last edited on: <span>${date}</span> by <span>${esc(editor)}</span>`;
}

function renderHistory(slug, versions) {
  const list = document.getElementById('history-list');
  if (!versions.length) { list.innerHTML = '<div style="color:var(--subtext);font-size:13px">No versions yet</div>'; return; }
  const isSA = currentUser?.role === 'superadmin';
  list.innerHTML = versions.map((v, i) => `
    <div class="history-item">
      <span class="history-ts">${fmtDate(v.timestamp)}</span>
      <span class="history-editor">${esc(v.editor)}</span>
      <span class="history-actions">
        ${i === 0
          ? `<span style="font-size:11px;color:var(--green)">current</span>
             ${isSA ? `<button class="btn-ghost btn-ghost danger" style="font-size:12px;padding:4px 10px" onclick="deleteVersion('${slug}','${v.filename}',${i})">Delete</button>` : ''}`
          : `<button class="btn-ghost" style="font-size:12px;padding:4px 10px" onclick="showDiff('${slug}','${v.filename}','${esc(fmtDate(v.timestamp))}')">Diff</button>
             <button class="btn-ghost" style="font-size:12px;padding:4px 10px" onclick="rollback('${slug}','${v.filename}')">Restore</button>
             ${isSA ? `<button class="btn-ghost btn-ghost danger" style="font-size:12px;padding:4px 10px" onclick="deleteVersion('${slug}','${v.filename}',${i})">Delete</button>` : ''}`
        }
      </span>
    </div>
  `).join('');
}

function closeDiffModal() {
  document.getElementById('diff-modal').classList.add('hidden');
}

async function showDiff(slug, filename, label) {
  document.getElementById('diff-modal-title').textContent = `Diff — ${label}`;
  document.getElementById('diff-output').innerHTML = '<div style="color:var(--subtext);padding:16px 0">Loading…</div>';
  document.getElementById('diff-modal').classList.remove('hidden');
  try {
    const [current, old] = await Promise.all([
      api('GET', `/api/pages/${slug}`),
      api('GET', `/api/pages/${slug}/version/${filename}`),
    ]);
    const ops = _lineDiff(old.content || '', current.content || '');
    // Only render lines with changes + 3 lines of context around them
    const lines = _diffWithContext(ops, 3);
    if (!lines.length) {
      document.getElementById('diff-output').innerHTML = '<div style="color:var(--subtext);padding:16px 0">No differences found.</div>';
      return;
    }
    document.getElementById('diff-output').innerHTML =
      '<pre class="diff-pre">' + lines.map(l => {
        if (l === null) return '<span class="diff-sep">…</span>';
        const cls = l.type === 'add' ? 'diff-add' : l.type === 'del' ? 'diff-del' : 'diff-eq';
        const prefix = l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  ';
        return `<span class="${cls}">${esc(prefix + l.text)}</span>`;
      }).join('\n') + '</pre>';
  } catch(e) {
    document.getElementById('diff-output').innerHTML = `<div style="color:var(--danger);padding:16px 0">Error: ${e.message}</div>`;
  }
}

function _lineDiff(oldText, newText) {
  const a = oldText.split('\n'), b = newText.split('\n');
  const m = a.length, n = b.length;
  // LCS table
  const dp = Array.from({length: m + 1}, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  // Traceback
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      ops.push({type:'eq',  text: a[i-1]}); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.push({type:'add', text: b[j-1]}); j--;
    } else {
      ops.push({type:'del', text: a[i-1]}); i--;
    }
  }
  return ops.reverse();
}

function _diffWithContext(ops, ctx) {
  // Mark which lines are near a change
  const near = new Uint8Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'eq') {
      for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++)
        near[k] = 1;
    }
  }
  const out = [];
  let skipping = false;
  for (let i = 0; i < ops.length; i++) {
    if (near[i]) { skipping = false; out.push(ops[i]); }
    else if (!skipping) { skipping = true; out.push(null); } // separator
  }
  return out;
}

function toggleHistory() {
  document.getElementById('history-panel').classList.toggle('hidden');
}

async function rollback(slug, filename) {
  if (!confirm('Restore this version? It will become the current version.')) return;
  await api('POST', `/api/pages/${slug}/rollback/${filename}`);
  loadPage(slug, ...currentBreadcrumbParts());
}

async function deleteVersion(slug, filename, index) {
  const label = index === 0 ? 'current version' : 'this version';
  const extra = index === 0 ? '\n\nThis is the CURRENT version — the previous version will become current and be re-indexed.' : '';
  if (!confirm(`Permanently delete ${label}? This cannot be undone.${extra}`)) return;
  await api('DELETE', `/api/pages/${slug}/version/${filename}`);
  loadPage(slug, ...currentBreadcrumbParts());
}

// ── EDITOR ─────────────────────────────────────────────────────────────────
let _editorInPreview = false;

function enterEditMode() {
  // Reset to edit pane
  _editorInPreview = false;
  document.getElementById('editor-pane').classList.remove('hidden');
  document.getElementById('preview-pane').classList.add('hidden');
  const btn = document.getElementById('preview-toggle-btn');
  if (btn) btn.textContent = 'Preview';

  api('GET', `/api/pages/${currentSlug}`).then(data => {
    document.getElementById('editor').value = data.content || '';
    livePreview();
  }).catch(() => {
    document.getElementById('editor').value = '';
  });

  // Populate page properties bar
  _populatePageProperties();

  showView('edit');
}

function _populatePageProperties() {
  const cats = navData?.categories || [];
  const catSel = document.getElementById('ep-category');
  catSel.innerHTML = cats.map(c =>
    `<option value="${esc(c.slug)}">${esc(c.display_name || c.name)}</option>`
  ).join('');

  // Find which category this page belongs to and set name
  let foundName = currentSlug;
  for (const cat of cats) {
    for (const pg of (cat.pages || [])) {
      if (pg.slug === currentSlug) {
        foundName = pg.display_name || pg.name || currentSlug;
        catSel.value = cat.slug;
        break;
      }
    }
  }
  document.getElementById('ep-name').value = foundName;
  document.getElementById('ep-msg').textContent = '';
}

async function savePageProperties() {
  const newName = document.getElementById('ep-name').value.trim();
  const newCat  = document.getElementById('ep-category').value;
  const msg     = document.getElementById('ep-msg');
  const btn     = document.getElementById('ep-save-btn');
  if (!newName) return;
  msg.textContent = '';
  btn.disabled = true;

  // Find current category
  const cats = navData?.categories || [];
  let currentCat = null;
  let currentName = null;
  for (const cat of cats) {
    for (const pg of (cat.pages || [])) {
      if (pg.slug === currentSlug) { currentCat = cat.slug; currentName = pg.name; break; }
    }
    if (currentCat) break;
  }

  try {
    if (newCat !== currentCat) {
      // Move (also renames in one call)
      await api('PATCH', `/api/nav/page/${currentSlug}/move`, { category_slug: newCat, name: newName });
    } else if (newName !== currentName) {
      await api('PATCH', `/api/nav/page/${currentSlug}/rename`, { name: newName });
    }
    await loadNav();
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved';
    setTimeout(() => msg.textContent = '', 2000);
  } catch (ex) {
    msg.style.color = 'var(--danger)';
    msg.textContent = ex.message || 'Failed';
  } finally {
    btn.disabled = false;
  }
}

function cancelEdit() { showView('page'); }

function livePreview() {
  const el = document.getElementById('editor-preview');
  el.innerHTML = marked.parse(document.getElementById('editor').value);
  renderMermaid(el);
}

function toggleEditorPreview() {
  _editorInPreview = !_editorInPreview;
  document.getElementById('editor-pane').classList.toggle('hidden', _editorInPreview);
  document.getElementById('preview-pane').classList.toggle('hidden', !_editorInPreview);
  document.getElementById('preview-toggle-btn').textContent = _editorInPreview ? 'Edit' : 'Preview';
  if (_editorInPreview) livePreview();
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

// ── EDITOR TOOLBAR ─────────────────────────────────────────────────────────

function tbInsert(prefix, suffix, placeholder) {
  const ta = document.getElementById('editor');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end) || placeholder;
  ta.value = ta.value.substring(0, start) + prefix + selected + suffix + ta.value.substring(end);
  ta.selectionStart = start + prefix.length;
  ta.selectionEnd = start + prefix.length + selected.length;
  ta.focus();
  livePreview();
}

function tbLine(prefix) {
  const ta = document.getElementById('editor');
  const start = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
  ta.value = ta.value.substring(0, lineStart) + prefix + ta.value.substring(lineStart);
  ta.selectionStart = ta.selectionEnd = lineStart + prefix.length;
  ta.focus();
  livePreview();
}

function tbLink() {
  const ta = document.getElementById('editor');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end) || 'link text';
  const insert = `[${selected}](url)`;
  ta.value = ta.value.substring(0, start) + insert + ta.value.substring(end);
  const urlStart = start + 1 + selected.length + 2;  // after [text](
  ta.selectionStart = urlStart;
  ta.selectionEnd = urlStart + 3;  // select "url"
  ta.focus();
  livePreview();
}

function tbCodeBlock() {
  const ta = document.getElementById('editor');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end) || 'code here';
  const insert = '\n```\n' + selected + '\n```\n';
  ta.value = ta.value.substring(0, start) + insert + ta.value.substring(end);
  ta.selectionStart = start + 5;
  ta.selectionEnd = start + 5 + selected.length;
  ta.focus();
  livePreview();
}

function tbTable() {
  const ta = document.getElementById('editor');
  const start = ta.selectionStart;
  const tbl = '\n| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n| Cell     | Cell     | Cell     |\n';
  ta.value = ta.value.substring(0, start) + tbl + ta.value.substring(start);
  ta.selectionStart = ta.selectionEnd = start + tbl.length;
  ta.focus();
  livePreview();
}

function tbMermaid() {
  document.getElementById('mermaid-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('mermaid-input').focus(), 50);
}

function closeMermaidModal() {
  document.getElementById('mermaid-modal').classList.add('hidden');
}

function insertMermaidChart() {
  const code = document.getElementById('mermaid-input').value.trim();
  if (!code) { closeMermaidModal(); return; }
  const ta = document.getElementById('editor');
  const start = ta.selectionStart;
  const insert = '\n\n```mermaid\n' + code + '\n```\n\n';
  ta.value = ta.value.substring(0, start) + insert + ta.value.substring(start);
  ta.selectionStart = ta.selectionEnd = start + insert.length;
  closeMermaidModal();
  ta.focus();
  livePreview();
}

async function renderMermaid(container) {
  const blocks = container.querySelectorAll('pre > code.language-mermaid');
  for (const block of blocks) {
    const pre = block.parentElement;
    const code = block.textContent;
    const id = 'mm-' + Math.random().toString(36).slice(2, 9);
    try {
      const { svg } = await mermaid.render(id, code);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-wrap';
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (e) {
      // Leave as code block if diagram fails to parse
    }
  }
}

function tbHr() {
  const ta = document.getElementById('editor');
  const start = ta.selectionStart;
  const insert = '\n\n---\n\n';
  ta.value = ta.value.substring(0, start) + insert + ta.value.substring(start);
  ta.selectionStart = ta.selectionEnd = start + insert.length;
  ta.focus();
  livePreview();
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

function _clearHypatiaSession() {
  try { sessionStorage.removeItem(HYPATIA_SESSION_KEY); } catch {}
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
  loadDashboard();
}

async function loadDashboard() {
  document.getElementById('dash-loading').classList.remove('hidden');
  document.getElementById('dash-content').classList.add('hidden');
  try {
    const d = await api('GET', '/api/dashboard');
    _renderDashStats(d.stats);
    _renderDashComments(d.recent_comments || []);
    _renderDashPages(d.recent_pages || []);
    _renderDashFiles(d.recent_files || []);
    _renderDashTeam(d.team || []);
    _renderDashCustomers(d.customers || []);
    document.getElementById('dash-loading').classList.add('hidden');
    document.getElementById('dash-content').classList.remove('hidden');
  } catch (ex) {
    document.getElementById('dash-loading').textContent = 'Failed to load dashboard.';
  }
}

function _renderDashStats(stats) {
  document.getElementById('ds-pages').textContent = stats.pages ?? '—';
  document.getElementById('ds-files').textContent = stats.files ?? '—';
  document.getElementById('ds-cats').textContent  = stats.categories ?? '—';
}

function _renderDashComments(comments) {
  const el = document.getElementById('dash-comments');
  if (!comments.length) {
    el.innerHTML = '<div class="dash-empty">No comments yet.</div>';
    return;
  }
  el.innerHTML = comments.map(c => {
    const truncated = esc(c.text.length > 160 ? c.text.slice(0, 160) + '…' : c.text);
    const ts = c.created_at ? fmtDate(c.created_at) : '';
    return `<div class="dash-comment">
  <div class="dash-comment-meta">
    <span class="dash-comment-page" onclick="loadPage(${JSON.stringify(c.slug)}, '', ${JSON.stringify(c.page_title)})">${esc(c.page_title)}</span>
    <span class="dash-comment-author">${esc(c.author)}</span>
    <span class="dash-comment-ts">${esc(ts)}</span>
  </div>
  <div class="dash-comment-text">${truncated}</div>
</div>`;
  }).join('');
}

function _renderDashPages(pages) {
  const el = document.getElementById('dash-pages');
  if (!pages.length) {
    el.innerHTML = '<div class="dash-empty">No pages yet.</div>';
    return;
  }
  el.innerHTML = pages.map(p => {
    const ts = p.timestamp ? fmtDate(p.timestamp) : '';
    return `<div class="dash-page-item" onclick="loadPage(${JSON.stringify(p.slug)}, '', ${JSON.stringify(p.title)})">
  <span class="dash-page-title">${esc(p.title)}</span>
  <span class="dash-page-meta">${esc(ts)} · ${esc(p.editor)}</span>
</div>`;
  }).join('');
}

function _renderDashFiles(files) {
  const el = document.getElementById('dash-files');
  if (!files.length) {
    el.innerHTML = '<div class="dash-empty">No documents yet.</div>';
    return;
  }
  el.innerHTML = files.map(f => {
    const dt = f.upload_date
      ? new Date(f.upload_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '';
    const sumText = f.summary && f.summary.length > 200 ? f.summary.slice(0, 200) + '…' : (f.summary || '');
    return `<div class="dash-file-item">
  <div class="dash-file-name">${esc(f.original_filename)}</div>
  <div class="dash-file-meta">${esc(dt)} · ${esc(f.uploaded_by)}</div>${sumText ? `
  <div class="dash-file-summary">${esc(sumText)}</div>` : ''}
</div>`;
  }).join('');
}

function _renderDashTeam(team) {
  const el = document.getElementById('dash-team');
  if (!team.length) {
    el.innerHTML = '<div class="dash-empty">No team members configured.</div>';
    return;
  }
  el.innerHTML = team.map(m =>
    `<div class="dash-team-item">
  <span class="dash-team-name">${esc(m.name)}</span>
  <span class="dash-team-focus">${esc(m.focus)}</span>
</div>`
  ).join('');
}

function _renderDashCustomers(customers) {
  const el = document.getElementById('dash-customers');
  if (!customers.length) {
    el.innerHTML = '<div class="dash-empty">No customers configured.</div>';
    return;
  }
  el.innerHTML = customers.map(c =>
    `<div class="dash-customer-item">
  <span class="dash-customer-name">${esc(c.name)}</span>
  <span class="dash-customer-notes">${esc(c.notes)}</span>
</div>`
  ).join('');
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
  initChatTips();

  const session = _loadHypatiaSession();
  if (session && session.history.length) {
    chatHistory = session.history;
    _currentHypatiaFont = session.currentFont || null;
    const msgs = document.getElementById('chat-messages');
    msgs.innerHTML = '';
    msgs.classList.add('no-anim');
    for (const msg of chatHistory) {
      appendChatMsg(msg.role, msg.content, null, msg.ts || null, msg.image_url || null);
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
    const greetTs = Date.now();
    appendChatMsg('assistant', clean || r.reply, null, greetTs);
    chatHistory = [{ role: 'assistant', content: clean || r.reply, ts: greetTs }];
    _saveHypatiaSession();
    setHypatiaState('idle');
  } catch {
    await fadeOutMsg(thinking);
    appendChatMsg('assistant', "Something's stirring in the knowledge base… ask me anything.");
    setHypatiaState('idle');
  }
}

const _IMG_GEN_MSGS = [
  "Hmm, let me visualize that for you…",
  "Preparing the canvas…",
  "The model is loading — first generation takes a little longer…",
  "Warming things up on Wednesday…",
  "Flux is weaving your image together…",
  "Diffusion in progress…",
  "Almost there — just a few more sampling steps…",
  "Still working… once it's warm the next one will be nearly instant.",
  "Nearly done…",
  "Any moment now…",
];
let _imgGenInterval = null;

function _startImageGenPhrases(thinkingEl) {
  let idx = 0;
  _imgGenInterval = setInterval(() => {
    idx = Math.min(idx + 1, _IMG_GEN_MSGS.length - 1);
    const span = thinkingEl.querySelector('.chat-thinking');
    if (span) span.textContent = _IMG_GEN_MSGS[idx];
  }, 5000);
}

function _stopImageGenPhrases() {
  if (_imgGenInterval) { clearInterval(_imgGenInterval); _imgGenInterval = null; }
}

async function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  clearTimeout(_listeningTimer);
  const userTs = Date.now();
  appendChatMsg('user', text, null, userTs);
  chatHistory.push({ role: 'user', content: text, ts: userTs });
  input.value = '';
  setHypatiaState('thinking');
  const thinking = appendChatMsg('assistant', '…', 'thinking');
  document.getElementById('chat-send').disabled = true;
  // Only cycle image-gen phrases if the message looks like an image request
  const _IMAGE_KW = ['draw','sketch','illustrate','illustration','paint','render',
    'generate an image','generate a image','create an image','create a image',
    'make an image','make a image','picture of','photo of','image of',
    'show me','can you draw','can you create','can you generate','can you make'];
  const _lowerText = text.toLowerCase();
  const _looksLikeImage = _IMAGE_KW.some(kw => _lowerText.includes(kw));
  const _phraseDelay = _looksLikeImage ? setTimeout(() => _startImageGenPhrases(thinking), 15000) : null;
  try {
    const r = await api('POST', '/api/hypatia/chat', {
      messages: chatHistory,
      font_expression_enabled: isFontExpressionEnabled(),
    });
    clearTimeout(_phraseDelay);
    _stopImageGenPhrases();
    await fadeOutMsg(thinking);
    const { font, text: clean } = _parseFontPrefix(r.reply);
    if (font) _currentHypatiaFont = font;
    const reply = clean || r.reply;
    const replyTs = Date.now();
    const imgUrl = r.image_url || null;
    appendChatMsg('assistant', reply, null, replyTs, imgUrl);
    chatHistory.push({ role: 'assistant', content: reply, ts: replyTs, image_url: imgUrl });
    _saveHypatiaSession();
    setHypatiaState('idle');
    _maybeAutoReflect(); // fire-and-forget; no await
  } catch (ex) {
    clearTimeout(_phraseDelay);
    _stopImageGenPhrases();
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

function appendChatMsg(role, text, state = null, ts = null, image_url = null) {
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
    : role === 'assistant'
      ? marked.parse(text).replace(/<table/g, '<div class="chat-table-wrap"><table').replace(/<\/table>/g, '</table></div>')
      : `<p>${esc(text)}</p>`;

  const avatarHtml = role === 'assistant'
    ? `<div class="chat-avatar chat-avatar-hyp">HYP</div>`
    : `<div class="chat-avatar">${(currentUser?.sub?.[0] || 'U').toUpperCase()}</div>`;

  const tsLabel = ts
    ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tsHtml = `<span class="chat-ts">${tsLabel}</span>`;

  const imgHtml = image_url
    ? `<div class="chat-img-wrap"><img class="chat-gen-img" src="${esc(image_url)}" alt="Generated image" loading="lazy"></div>`
    : '';

  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `
    <div class="chat-msg-header">${avatarHtml}${tsHtml}</div>
    ${imgHtml}
    <div class="chat-bubble" style="${fontStyle}">${content}</div>`;
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
  switchProfileTab('profile');
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
  if (tab === 'sa-hypatia') { loadHypatiaSettings(); switchHypatiaTab('profile'); }
}

// ── Profile subtabs ────────────────────────────────────────────────────────
const ALL_PROFILE_TABS = ['profile', 'ai-prefs'];
function switchProfileTab(tab) {
  ALL_PROFILE_TABS.forEach(t => {
    document.getElementById(`ptab-btn-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`ptab-${t}`)?.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'ai-prefs') { loadAiPrefs(); loadMyMemoryDump(); }
}

// ── Session reflection + new conversation ─────────────────────────────────

let _lastReflectTurnCount = 0;
const REFLECT_EVERY_N_TURNS = 5;

async function _endSession(thenClear) {
  // Fire-and-forget reflect if there's substantive conversation
  const userTurns = chatHistory.filter(m => m.role === 'user');
  if (userTurns.length >= 2) {
    try {
      await api('POST', '/api/hypatia/reflect', { messages: chatHistory });
      _lastReflectTurnCount = userTurns.length;
    } catch {}
  }
  if (thenClear) {
    _clearSession();
    _lastReflectTurnCount = 0;
  }
}

async function _maybeAutoReflect() {
  const userTurns = chatHistory.filter(m => m.role === 'user');
  const newTurns = userTurns.length - _lastReflectTurnCount;
  if (userTurns.length >= 2 && newTurns >= REFLECT_EVERY_N_TURNS) {
    try {
      await api('POST', '/api/hypatia/reflect', { messages: chatHistory });
      _lastReflectTurnCount = userTurns.length;
    } catch {}
  }
}

function _clearSession() {
  chatHistory = [];
  _currentHypatiaFont = null;
  _clearHypatiaSession();
  document.getElementById('chat-messages').innerHTML = '';
  sendHiddenGreeting();
}

async function newConversation() {
  const btn = document.getElementById('chat-new-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  await _endSession(true);
  if (btn) { btn.disabled = false; btn.innerHTML = '&#43;'; }
}

function toggleHypatiaExpand() {
  const expanded = document.body.classList.toggle('hypatia-expanded');
  const btn = document.getElementById('chat-expand-btn');
  if (btn) btn.innerHTML = expanded ? '&#x2923;' : '&#x2922;';
}

// ── CHAT TIPS ──────────────────────────────────────────────────────────────

const CHAT_TIPS = [
  'Expand the sidebar with <b>⤢</b>, or pop the chat into its own resizable window with <b>↗</b> — perfect for reading tables.',
  'Need a visual? Say <b>"draw me…"</b> or <b>"generate an image of…"</b> and I\'ll create one for you.',
  'I have full access to every wiki page and uploaded library document — ask me anything about the team\'s work.',
  'I can build diagrams: ask me to <b>"make a flowchart of…"</b> or <b>"draw a sequence diagram for…"</b> and I\'ll write the Mermaid chart.',
  'I track the full context of our conversation — ask follow-up questions naturally without re-explaining the background.',
  'Ask me to <b>compare two documents</b> or find contradictions between sources — I\'ll surface the differences.',
  'Hit <b>+</b> to start a fresh conversation when switching to a completely different topic.',
  'Try asking <b>"what do we know about X?"</b> to pull together everything across pages and documents on any topic.',
  'You can paste raw text or data into the chat and ask me to summarize, reformat, or analyse it.',
  'Ask me <b>"what pages exist about…?"</b> to discover relevant wiki content you might not know about.',
];

function _tipHourSlot() {
  return Math.floor(Date.now() / (60 * 60 * 1000));
}

function initChatTips() {
  const slot = _tipHourSlot();
  const dismissed = parseInt(localStorage.getItem('hypatia_tip_dismissed') || '0', 10);
  if (dismissed === slot) return; // already dismissed this hour
  const tip = CHAT_TIPS[slot % CHAT_TIPS.length];
  document.getElementById('chat-tip-text').innerHTML = tip;
  document.getElementById('chat-tip-banner').classList.remove('hidden');
}

function dismissChatTip() {
  localStorage.setItem('hypatia_tip_dismissed', String(_tipHourSlot()));
  document.getElementById('chat-tip-banner').classList.add('hidden');
}

function popoutChat() {
  const w = 780, h = window.screen.availHeight || 900;
  const left = window.screen.availWidth - w;
  window.open(
    '/?popout',
    'hypatia-chat',
    `width=${w},height=${h},left=${left},top=0,resizable=yes,scrollbars=no`
  );
}

// Beacon on page unload (fire-and-forget, browser may discard if too slow)
window.addEventListener('beforeunload', () => {
  const userTurns = chatHistory.filter(m => m.role === 'user');
  if (userTurns.length < 2) return;
  const payload = JSON.stringify({ messages: chatHistory });
  navigator.sendBeacon('/api/hypatia/reflect', new Blob([payload], { type: 'application/json' }));
});

// ── Hypatia notes (read-only display) ─────────────────────────────────────

async function reflectNow() {
  const msg = document.getElementById('hypatia-notes-msg');
  if (msg) { msg.style.color = 'var(--subtext)'; msg.textContent = 'Reflecting…'; }
  try {
    const r = await api('POST', '/api/hypatia/reflect', { messages: chatHistory });
    if (r.skipped) {
      if (msg) { msg.style.color = 'var(--subtext)'; msg.textContent = 'No active conversation to reflect on — chat with Hypatia first, then come back here.'; setTimeout(() => msg.textContent = '', 5000); }
    } else {
      _lastReflectTurnCount = chatHistory.filter(m => m.role === 'user').length;
      if (msg) { msg.style.color = 'var(--green)'; msg.textContent = 'Done — memory updated.'; setTimeout(() => msg.textContent = '', 3000); }
      loadMyMemoryDump();
    }
  } catch (e) {
    if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `Error: ${e.message}`; setTimeout(() => msg.textContent = '', 4000); }
  }
}

async function loadHypatiaNotesDisplay() {
  const ta = document.getElementById('hypatia-notes-ta');
  if (!ta) return;
  try {
    const r = await api('GET', '/api/hypatia/me/hypatia-notes');
    ta.value = r.notes || '';
    ta.placeholder = r.notes ? '' : 'No notes yet — start a conversation with Hypatia.';
  } catch {
    ta.placeholder = 'Could not load notes.';
  }
}

async function clearHypatiaNotesConfirm() {
  if (!confirm('Clear all of Hypatia\'s notes about you? This cannot be undone.')) return;
  const msg = document.getElementById('hypatia-notes-msg');
  try {
    await api('DELETE', '/api/hypatia/me/hypatia-notes');
    if (msg) { msg.style.color = 'var(--green)'; msg.textContent = 'Cleared'; setTimeout(() => msg.textContent = '', 2000); }
    loadMyMemoryDump();
  } catch {}
}

// ── Memory dump: self ──────────────────────────────────────────────────────

function _renderMemTopics(prefix, notesText) {
  const sections = { working_on: '', preferences: '', context: '' };
  const re = /###\s+(Currently Working On|Preferences & Style|Ongoing Context)\n([\s\S]*?)(?=###|$)/g;
  let m;
  while ((m = re.exec(notesText)) !== null) {
    if (m[1] === 'Currently Working On') sections.working_on = m[2].trim();
    else if (m[1] === 'Preferences & Style') sections.preferences = m[2].trim();
    else if (m[1] === 'Ongoing Context') sections.context = m[2].trim();
  }
  const empty = '<span style="color:var(--subtext);font-style:italic;font-size:12px">Nothing recorded yet</span>';
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val ? esc(val).replace(/\n/g,'<br>') : empty; };
  set(`${prefix}-working-on`, sections.working_on);
  set(`${prefix}-preferences`, sections.preferences);
  set(`${prefix}-context`, sections.context);
}

function _renderMemConversations(listEl, memories, deleteEndpoint) {
  if (!memories.length) {
    listEl.innerHTML = '<span style="color:var(--subtext);font-style:italic;font-size:12px">No conversation memories yet</span>';
    return;
  }
  listEl.innerHTML = memories.map(m => `
    <div class="mem-conv-item">
      <span class="mem-conv-date">${esc(m.date)}</span>
      <span class="mem-conv-summary">${esc(m.summary)}</span>
      <button class="btn-danger-sm mem-conv-del" onclick="${deleteEndpoint}('${m.id}')">Delete</button>
    </div>`).join('');
}

async function loadMyMemoryDump() {
  const [notesRes, memsRes] = await Promise.allSettled([
    api('GET', '/api/hypatia/me/hypatia-notes'),
    api('GET', '/api/hypatia/me/memories'),
  ]);
  _renderMemTopics('mem', notesRes.status === 'fulfilled' ? (notesRes.value.notes || '') : '');
  const listEl = document.getElementById('mem-conversations');
  if (listEl) _renderMemConversations(listEl, memsRes.status === 'fulfilled' ? (memsRes.value.memories || []) : [], 'deleteMyMemory');
}

async function deleteMyMemory(pointId) {
  if (!confirm('Delete this conversation memory?')) return;
  await api('DELETE', `/api/hypatia/me/memories/${pointId}`);
  loadMyMemoryDump();
}

// ── Admin: memory dump for any user ───────────────────────────────────────

async function adminLoadMemoryUserList() {
  const sel = document.getElementById('admin-notes-user-sel');
  if (!sel || sel.options.length > 1) return;
  try {
    const r = await api('GET', '/api/auth/superadmin/users');
    (r || []).forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = (u.display_name || u.username) + ' (' + u.username + ')';
      sel.appendChild(opt);
    });
  } catch {}
}

async function adminLoadUserMemory() {
  const sel = document.getElementById('admin-notes-user-sel');
  const dumpEl = document.getElementById('admin-mem-dump');
  const clearBtn = document.getElementById('admin-notes-clear-btn');
  const msg = document.getElementById('admin-notes-msg');
  const username = sel?.value;
  if (!username) { if (dumpEl) dumpEl.style.display = 'none'; if (clearBtn) clearBtn.disabled = true; return; }
  if (dumpEl) dumpEl.style.display = 'block';
  if (clearBtn) clearBtn.disabled = false;
  msg.textContent = 'Loading…';
  const [notesRes, memsRes] = await Promise.allSettled([
    api('GET', `/api/hypatia/admin/users/${encodeURIComponent(username)}/hypatia-notes`),
    api('GET', `/api/hypatia/admin/users/${encodeURIComponent(username)}/memories`),
  ]);
  msg.textContent = '';
  _renderMemTopics('admin-mem', notesRes.status === 'fulfilled' ? (notesRes.value.notes || '') : '');
  const listEl = document.getElementById('admin-mem-conversations');
  if (listEl) _renderMemConversations(listEl, memsRes.status === 'fulfilled' ? (memsRes.value.memories || []) : [], `(id) => adminDeleteMemory('${username}', id)`);
}

async function adminClearUserNotesConfirm() {
  const sel = document.getElementById('admin-notes-user-sel');
  const username = sel?.value;
  if (!username) return;
  if (!confirm(`Clear all of Hypatia's topic notes about ${username}?`)) return;
  await api('DELETE', `/api/hypatia/admin/users/${encodeURIComponent(username)}/hypatia-notes`);
  adminLoadUserMemory();
}

async function adminDeleteMemory(username, pointId) {
  if (!confirm('Delete this conversation memory?')) return;
  await api('DELETE', `/api/hypatia/admin/users/${encodeURIComponent(username)}/memories/${pointId}`);
  adminLoadUserMemory();
}

async function loadAiPrefs() {
  try {
    const s = await api('GET', '/api/auth/me/ai-prefs');
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    set('pref-name',     s.preferred_name);
    set('pref-focus',    s.focus_area);
    set('pref-title',    s.title);
    set('pref-freeform', s.freeform);
    [0,1,2].forEach(i => {
      set(`pref-strength-${i}`, (s.strengths || [])[i] || '');
      set(`pref-help-${i}`,     (s.help_areas || [])[i] || '');
    });
    // Radio buttons
    const commEl = document.querySelector(`input[name="comm-style"][value="${s.comm_style || 'detailed'}"]`);
    if (commEl) commEl.checked = true;
    const techEl = document.querySelector(`input[name="tech-depth"][value="${s.tech_depth || 'some'}"]`);
    if (techEl) techEl.checked = true;
  } catch {}
}

async function saveAiPrefs() {
  const msg = document.getElementById('ai-prefs-msg');
  msg.textContent = '';
  const get = id => (document.getElementById(id)?.value || '').trim();
  const getRadio = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
  const body = {
    preferred_name: get('pref-name'),
    focus_area:     get('pref-focus'),
    title:          get('pref-title'),
    strengths:      [0,1,2].map(i => get(`pref-strength-${i}`)),
    help_areas:     [0,1,2].map(i => get(`pref-help-${i}`)),
    comm_style:     getRadio('comm-style') || 'detailed',
    tech_depth:     getRadio('tech-depth') || 'some',
    freeform:       get('pref-freeform'),
  };
  try {
    await api('PUT', '/api/auth/me/ai-prefs', body);
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved — Hypatia will use this in your next conversation';
    setTimeout(() => msg.textContent = '', 3000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Save failed';
  }
}

const ALL_HYPATIA_TABS = ['profile','models','skills','connections','system-prompts','memory'];
function switchHypatiaTab(tab) {
  ALL_HYPATIA_TABS.forEach(t => {
    document.getElementById(`hytab-btn-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`hytab-${t}`)?.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'system-prompts' && !_promptSections.length) {
    api('GET', '/api/hypatia/prompts').then(r => {
      _promptSections = (r.prompts || []).map(p => ({ ...p }));
      renderPromptSections();
    }).catch(() => {});
  }
  if (tab === 'models') { loadImageGenSettings(); }
  if (tab === 'memory') { loadMemorySettings(); adminLoadMemoryUserList(); }
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

async function reindexAllPages() {
  const btn = document.getElementById('reindex-btn');
  const status = document.getElementById('reindex-status');
  btn.disabled = true;
  status.textContent = 'Indexing…';
  try {
    const r = await api('POST', '/api/pages/reindex-all');
    status.style.color = 'var(--green)';
    status.textContent = `Queued ${r.queued} page${r.queued !== 1 ? 's' : ''} for re-indexing.`;
  } catch (e) {
    status.style.color = 'var(--danger)';
    status.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 8000);
  }
}

async function reindexAllLibraryFiles() {
  const btn = document.getElementById('reindex-lib-btn');
  const status = document.getElementById('reindex-lib-status');
  btn.disabled = true;
  status.style.color = 'var(--subtext)';
  status.textContent = 'Queuing…';
  try {
    const r = await api('POST', '/api/library/reindex-all');
    status.style.color = 'var(--green)';
    status.textContent = `Queued ${r.queued} file${r.queued !== 1 ? 's' : ''} for re-indexing.`;
  } catch (e) {
    status.style.color = 'var(--danger)';
    status.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 10000);
  }
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
  try {
    const rp = await api('GET', '/api/hypatia/prompts');
    _promptSections = (rp.prompts || []).map(p => ({ ...p }));
    renderPromptSections();
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
          <input type="text" id="mn-${id}" list="mnl-${id}" value="${esc(m.model_name||'')}"
            autocomplete="off" placeholder="e.g. qwen/qwen3-embedding-8b"
            oninput="_mcSet('${id}','model_name',this.value)" style="flex:1">
          <datalist id="mnl-${id}"></datalist>
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
  const input = document.getElementById(`mn-${id}`);
  const dl = document.getElementById(`mnl-${id}`);
  const prev = input.placeholder;
  input.placeholder = 'Fetching…';
  // Also sync token from DOM before fetching
  const cardEl = document.getElementById(`mc-${id}`);
  if (cardEl) {
    const tokenEl = cardEl.querySelector('input[type="password"]');
    if (tokenEl && tokenEl.value) m.api_token = tokenEl.value;
  }
  try {
    const r = await api('POST', '/api/hypatia/fetch-models', {
      provider: m.provider,
      api_endpoint: m.api_endpoint,
      api_token: m.api_token,
    });
    dl.innerHTML = r.models.map(mod => `<option value="${esc(mod.id)}">${esc(mod.name)}</option>`).join('');
    input.placeholder = prev;
    // If field is empty and we got results, pre-fill with first model
    if (!m.model_name && r.models.length) {
      m.model_name = r.models[0].id;
      input.value = m.model_name;
    }
  } catch(e) {
    input.placeholder = prev;
    dl.innerHTML = '';
    const msg = document.getElementById(`test-msg-${id}`);
    if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `Fetch failed: ${e.message||'error'}`; }
  }
}

async function _testModel(id) {
  const m = _modelCards.find(m => m.id === id);
  if (!m) return;
  // Sync token from DOM in case _modelCards is stale (browser password field behaviour)
  const cardEl = document.getElementById(`mc-${id}`);
  if (cardEl) {
    const tokenEl = cardEl.querySelector('input[type="password"]');
    if (tokenEl && tokenEl.value) m.api_token = tokenEl.value;
  }
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

// ── Image Generation Settings ────────────────────────────────────────────────
async function loadImageGenSettings() {
  try {
    const r = await api('GET', '/api/hypatia/image-gen');
    document.getElementById('ig-enabled').checked   = r.enabled !== false;
    document.getElementById('ig-endpoint').value    = r.api_endpoint || 'http://100.74.90.66:6501';
    document.getElementById('ig-checkpoint').value  = r.checkpoint || '';
    document.getElementById('ig-vae').value         = r.vae || '';
    document.getElementById('ig-clip_l').value      = r.clip_l || '';
    document.getElementById('ig-t5xxl').value       = r.t5xxl || '';
    document.getElementById('ig-sampler').value     = r.sampler || 'Euler';
    document.getElementById('ig-scheduler').value   = r.scheduler || 'Beta';
    document.getElementById('ig-steps').value       = r.steps ?? 20;
    document.getElementById('ig-width').value       = r.width ?? 512;
    document.getElementById('ig-height').value      = r.height ?? 512;
    document.getElementById('ig-cfg_scale').value   = r.cfg_scale ?? 1;
    document.getElementById('ig-distilled_cfg').value = r.distilled_cfg_scale ?? 3;
    document.getElementById('ig-prompt_suffix').value = r.prompt_suffix || '';
  } catch {}
}

async function saveImageGenSettings() {
  const msg = document.getElementById('ig-save-msg');
  msg.textContent = '';
  try {
    await api('PUT', '/api/hypatia/image-gen', {
      enabled:            document.getElementById('ig-enabled').checked,
      api_endpoint:       document.getElementById('ig-endpoint').value.trim(),
      checkpoint:         document.getElementById('ig-checkpoint').value.trim(),
      vae:                document.getElementById('ig-vae').value.trim(),
      clip_l:             document.getElementById('ig-clip_l').value.trim(),
      t5xxl:              document.getElementById('ig-t5xxl').value.trim(),
      sampler:            document.getElementById('ig-sampler').value.trim(),
      scheduler:          document.getElementById('ig-scheduler').value.trim(),
      steps:              parseInt(document.getElementById('ig-steps').value) || 20,
      width:              parseInt(document.getElementById('ig-width').value) || 512,
      height:             parseInt(document.getElementById('ig-height').value) || 512,
      cfg_scale:          parseFloat(document.getElementById('ig-cfg_scale').value) || 1,
      distilled_cfg_scale: parseFloat(document.getElementById('ig-distilled_cfg').value) || 3,
      prompt_suffix:      document.getElementById('ig-prompt_suffix').value.trim(),
    });
    msg.style.color = 'var(--green)'; msg.textContent = 'Saved';
    setTimeout(() => msg.textContent = '', 2000);
  } catch(e) {
    msg.style.color = 'var(--danger)'; msg.textContent = e.message || 'Save failed';
  }
}

// ── Multi-section prompt stack ───────────────────────────────────────────────
let _promptSections = [];

function renderPromptSections() {
  const container = document.getElementById('prompt-sections-list');
  if (!container) return;
  if (!_promptSections.length) {
    container.innerHTML = '<p class="admin-placeholder">Loading prompts…</p>';
    return;
  }
  container.innerHTML = _promptSections.map((p, i) => `
    <div class="prompt-section-card" id="psc-${p.id}">
      <div class="psc-header">
        <label class="psc-toggle">
          <input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="_pscToggle('${p.id}',this.checked)">
          <span class="psc-label">${esc(p.label)}</span>
        </label>
        <span class="psc-desc">${esc(p.description)}</span>
        <button class="icon-btn psc-expand-btn" onclick="_pscToggleExpand('${p.id}')" title="Expand/Collapse">
          <span id="psc-chevron-${p.id}">▾</span>
        </button>
      </div>
      <div class="psc-body" id="psc-body-${p.id}">
        <textarea class="psc-textarea" id="psc-text-${p.id}" rows="8"
          oninput="_pscEdit('${p.id}',this.value)">${esc(p.content)}</textarea>
      </div>
    </div>
  `).join('');
}

function _pscToggle(id, checked) {
  const p = _promptSections.find(s => s.id === id);
  if (p) p.enabled = checked;
}

function _pscEdit(id, val) {
  const p = _promptSections.find(s => s.id === id);
  if (p) p.content = val;
}

function _pscToggleExpand(id) {
  const body = document.getElementById(`psc-body-${id}`);
  const chevron = document.getElementById(`psc-chevron-${id}`);
  const collapsed = body.classList.toggle('collapsed');
  chevron.textContent = collapsed ? '▸' : '▾';
}

async function saveAllPrompts() {
  const msg = document.getElementById('prompts-save-msg');
  msg.textContent = '';
  try {
    await api('PUT', '/api/hypatia/prompts', { prompts: _promptSections });
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved';
    setTimeout(() => msg.textContent = '', 2000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Save failed';
  }
}

// ── MEMORY SETTINGS ─────────────────────────────────────────────────────────

let _memDirtyFlag = false;

function memDirty() { _memDirtyFlag = true; }

async function loadMemorySettings() {
  try {
    const s = await api('GET', '/api/hypatia/memory-settings');
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val ?? el.value;
    };
    set('mem-user-profiles',   s.user_profiles);
    set('mem-user-expertise',  s.user_expertise);
    set('mem-user-history',    s.user_history);
    set('mem-sessions-enabled',s.sessions_enabled);
    set('mem-retention',       s.retention_days);
    set('mem-consolidation',   s.consolidation);
    set('mem-max-tokens',      s.max_tokens);
    set('mem-inject-profile',  s.inject_profile);
    set('mem-inject-sessions', s.inject_sessions);
    set('mem-inject-index',    s.inject_index);
    _memDirtyFlag = false;
  } catch {}
}

async function saveMemorySettings() {
  const msg = document.getElementById('memory-save-msg');
  msg.textContent = '';
  const get = id => {
    const el = document.getElementById(id);
    if (!el) return null;
    return el.type === 'checkbox' ? el.checked : el.value;
  };
  const body = {
    user_profiles:    get('mem-user-profiles'),
    user_expertise:   get('mem-user-expertise'),
    user_history:     get('mem-user-history'),
    sessions_enabled: get('mem-sessions-enabled'),
    retention_days:   parseInt(get('mem-retention')) || 30,
    consolidation:    get('mem-consolidation'),
    max_tokens:       parseInt(get('mem-max-tokens')) || 800,
    inject_profile:   get('mem-inject-profile'),
    inject_sessions:  get('mem-inject-sessions'),
    inject_index:     get('mem-inject-index'),
  };
  try {
    await api('PUT', '/api/hypatia/memory-settings', body);
    msg.style.color = 'var(--green)';
    msg.textContent = 'Saved';
    _memDirtyFlag = false;
    setTimeout(() => msg.textContent = '', 2000);
  } catch(e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = e.message || 'Save failed';
  }
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
  ['files','search','upload'].forEach(t => {
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

let _libraryFileCache = [];

async function libraryLoadFiles() {
  const el = document.getElementById('library-file-list');
  try {
    const r = await api('GET', '/api/library/files');
    const files = r.files || [];
    _libraryFileCache = files;
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
                <button class="btn-ghost" onclick="libraryViewSummary('${f.id}')">Summary</button>
                <button class="btn-ghost danger" onclick="libraryDeleteFile('${f.id}','${esc(f.original_filename)}')">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    el.innerHTML = `<div class="dropbox-empty">Error loading files: ${e.message}</div>`;
  }
}


function libraryViewSummary(fileId) {
  const f = _libraryFileCache.find(x => x.id === fileId);
  if (!f) return;
  const pts = (f.key_points || []).map(p => `<li>${esc(p)}</li>`).join('');
  const modal = document.getElementById('lib-summary-modal');
  document.getElementById('lib-summary-title').textContent = f.original_filename;
  document.getElementById('lib-summary-body').innerHTML =
    `${f.summary ? `<p style="margin:0 0 14px;line-height:1.6">${esc(f.summary)}</p>` : ''}
     ${pts ? `<ul style="margin:0;padding-left:18px;line-height:1.8">${pts}</ul>` : ''}`;
  modal.classList.remove('hidden');
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
