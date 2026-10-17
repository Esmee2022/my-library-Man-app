const $ = (id) => document.getElementById(id);
let profile = null;
let cachedBooks = [];
let cachedUsers = [];
let libraryCategories = [];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const coverPalettes = [['#173f5f','#20639b','#3caea3'],['#402b50','#76528b','#c06c84'],['#30475e','#52616b','#84a9ac'],['#4b3832','#8d6e63','#d7b49e'],['#183a37','#2d6a4f','#95d5b2'],['#422a1f','#a44a3f','#e9c46a']];
function bookCover(book, index) {
  const title = String(book.title || 'Library selection');
  const words = title.split(/\s+/);
  const lines = []; let line = '';
  for (const word of words) { if ((line + ' ' + word).trim().length > 18 && line) { lines.push(line); line = word; } else line = (line + ' ' + word).trim(); }
  if (line) lines.push(line); const palette = coverPalettes[index % coverPalettes.length];
  const titleSvg = lines.slice(0,3).map((part, i) => `<tspan x="42" dy="${i ? 30 : 0}">${esc(part)}</tspan>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 560"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${palette[0]}"/><stop offset=".58" stop-color="${palette[1]}"/><stop offset="1" stop-color="${palette[2]}"/></linearGradient></defs><rect width="420" height="560" fill="url(#g)"/><circle cx="330" cy="115" r="120" fill="#fff" opacity=".09"/><path d="M0 395 Q100 320 210 400 T420 390 V560 H0Z" fill="#101c2a" opacity=".18"/><path d="M305 305c-28-44-71-45-95-15-24-30-67-29-95 15 18 56 55 79 95 102 40-23 77-46 95-102Z" fill="#fff" opacity=".16"/><text x="42" y="83" fill="#fff" opacity=".78" font-family="Georgia,serif" font-size="13" letter-spacing="4">THE LIBRARY COLLECTION</text><text x="42" y="155" fill="#fff" font-family="Georgia,serif" font-size="27" font-weight="700">${titleSvg}</text><path d="M42 267h92" stroke="#fff" stroke-width="2" opacity=".72"/><text x="42" y="505" fill="#fff" opacity=".86" font-family="Arial,sans-serif" font-size="15">${esc(book.author || 'Selected reading')}</text><rect x="15" y="15" width="390" height="530" rx="5" fill="none" stroke="#fff" opacity=".28"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function parsedDate(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  const normalized = raw.includes('T') || /[+-]\d{2}:?\d{2}$|Z$/i.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const result = new Date(normalized);
  return Number.isNaN(result.getTime()) ? null : result;
}
const date = (v) => { const parsed = parsedDate(v); return parsed ? parsed.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}) : '—'; };
const dateTime = (v) => { const parsed = parsedDate(v); return parsed ? parsed.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '—'; };
function message(text, type = 'success') { const el = $('notice'); el.textContent = text; el.className = `notice ${type}`; el.hidden = false; clearTimeout(message.timer); message.timer = setTimeout(() => { el.hidden = true; }, 5500); }
async function api(path, options = {}) {
  const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) };
  const csrf = sessionStorage.getItem('csrfToken');
  if (csrf && ['POST','PATCH','DELETE','PUT'].includes((options.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(path, { credentials: 'include', cache: 'no-store', ...options, headers });
  let body = {};
  try { body = await response.json(); } catch { }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showView(name) {
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `${name}View`; });
  document.querySelectorAll('.library-nav button').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  if (name === 'catalog') loadCatalog();
  if (name === 'loans') loadLoans(true);
  if (name === 'operations') { loadStaffData(); loadLoans(false); }
  if (name === 'reports') loadReports();
  if (name === 'admin') loadAdmin();
}

async function loadCatalog() {
  try {
    const term = $('searchTerm').value.trim();
    const data = await api(`/api/library/catalog${term ? `?q=${encodeURIComponent(term)}` : ''}`);
    cachedBooks = data.books || [];
    const category = $('categoryFilter').value;
    const format = $('formatFilter').value;
    const filteredBooks = cachedBooks.filter(book => (!category || book.category === category) && (!format || (book.formats || ['physical']).includes(format)));
    $('catalogCount').textContent = `${filteredBooks.length} title${filteredBooks.length === 1 ? '' : 's'}`;
    $('booksBody').innerHTML = filteredBooks.length ? filteredBooks.map((b, index) => {
      const formats = (b.formats || ['physical']).map(kind => `<span class="format-chip ${kind === 'ebook' ? 'ebook' : ''}">${kind === 'ebook' ? 'eBook' : 'Physical'}</span>`).join('');
      const actions = profile.role === 'administrator' ? `<button class="row-action" data-edit-book="${esc(b.id)}">Edit</button> <button class="row-action" data-archive="${esc(b.id)}">Archive</button>` : '';
      return `<article class="book-card"><img class="book-art" src="${bookCover(b,index)}" alt="Illustrated cover for ${esc(b.title)}" loading="lazy"><div class="book-card-content"><p class="book-category">${esc(b.category || 'General collection')}</p><h3>${esc(b.title)}</h3><p class="book-author">${esc(b.author)}</p><div class="book-format-row">${formats || '—'}</div><div class="book-stock"><span><strong>${Number(b.availablePhysicalCopies || 0)} / ${Number(b.physicalCopies || 0)}</strong>Physical available</span><span><strong>${Number(b.availableEbookLicenses || 0)} / ${Number(b.ebookLicenses || 0)}</strong>eBook licenses</span></div>${actions ? `<div class="book-card-actions">${actions}</div>` : ''}</div></article>`;
    }).join('') : '<div class="book-empty">No matching books. Try another search or category.</div>';
    const choices = [];
    for (const book of cachedBooks) for (const copy of book.copies || []) if (copy.status === 'available') choices.push(`<option value="${esc(copy.id)}">${copy.format === 'ebook' ? 'eBook license' : 'Physical copy'} · ${esc(book.title)} · ${esc(copy.barcode)}</option>`);
    if ($('copySelect')) $('copySelect').innerHTML = choices.length ? choices.join('') : '<option value="">No available copies</option>';
  } catch (e) { message(e.message, 'error'); }
}

async function loadLoans(own) {
  try {
    const { loans = [] } = await api(`/api/library/loans${own ? '' : '?status=open'}`);
    if (own) {
      $('myLoansBody').innerHTML = loans.length ? loans.map(l => {
        const overdue = !l.returned_at && Date.parse(l.due_at) < Date.now();
        const ebookLink = l.copy?.format === 'ebook' && !l.returned_at && l.copy?.digital_url ? `<a class="read-link" href="${esc(l.copy.digital_url)}" target="_blank" rel="noopener noreferrer">Open eBook ↗</a>` : '';
        return `<tr><td>${esc(l.copy?.book?.title || 'Book')} ${l.copy?.format === 'ebook' ? '<span class="format-chip ebook">eBook</span>' : '<span class="format-chip">Physical</span>'} ${ebookLink}</td><td>${date(l.borrowed_at)}</td><td>${date(l.due_at)}</td><td>${date(l.returned_at)}</td><td><span class="status-pill ${overdue ? 'overdue' : ''}">${l.returned_at ? 'Returned' : overdue ? 'Overdue' : 'On loan'}</span></td></tr>`;
      }).join('') : '<tr><td colspan="5">No loan history yet.</td></tr>';
    } else {
      const rows = loans.map(l => `<tr><td>${esc(l.copy?.book?.title || 'Book')}</td><td>${esc(l.borrower?.display_name || l.borrower?.email || '')}</td><td>${date(l.borrowed_at)}</td><td>${date(l.due_at)}</td><td><button class="row-action" data-return="${esc(l.id)}">Record return</button> ${profile.role==='administrator' ? `<button class="row-action" data-extend="${esc(l.id)}">Extend due date</button>` : ''}</td></tr>`).join('');
      if ($('allLoansBody')) $('allLoansBody').innerHTML = rows || '<tr><td colspan="5">No open loans.</td></tr>';
      if ($('reportLoansBody')) $('reportLoansBody').innerHTML = loans.map(l => `<tr><td>${esc(l.copy?.book?.title || '')}</td><td>${esc(l.borrower?.display_name || '')}</td><td>${date(l.borrowed_at)}</td><td>${date(l.due_at)}</td><td>${Date.parse(l.due_at) < Date.now() ? 'Overdue' : 'On loan'}</td></tr>`).join('') || '<tr><td colspan="5">No loans yet.</td></tr>';
    }
  } catch (e) { message(e.message, 'error'); }
}

async function loadStaffData() {
  try {
    const { users = [] } = await api('/api/library/users');
    cachedUsers = users.filter(u => u.active && u.library_access && u.role === 'student');
    $('borrowerSelect').innerHTML = cachedUsers.map(u => `<option value="${u.local_user_id}">${esc(u.display_name)} · ${esc(u.email)}</option>`).join('') || '<option value="">No active student accounts</option>';
    $('dueDate').value = new Date(Date.now() + 14 * 86400000).toISOString().slice(0,10);
    await loadCatalog();
  } catch (e) { message(e.message, 'error'); }
}

async function loadReports() {
  try {
    const [summary, { events = [] }] = await Promise.all([api('/api/library/reports/summary'), api('/api/library/reports/activity')]);
    $('summaryGrid').innerHTML = Object.entries({'Titles':summary.totalTitles,'Physical copies':summary.copies,'eBook licenses':summary.ebookLicenses,'Active loans':summary.activeLoans,'Returned loans':summary.returnedLoans,'Overdue':summary.overdueLoans}).map(([label,value]) => `<div class="summary-card"><strong>${Number(value)}</strong><span>${label}</span></div>`).join('');
    await loadLoans(false);
    $('reportActivityBody').innerHTML = events.map(e => `<tr><td class="date-time">${esc(dateTime(e.created_at))}</td><td>${esc(e.action)}</td><td>${esc(e.actor?.display_name || 'Former staff')}</td><td>${esc(e.entity_type)} ${esc(e.entity_id || '')}</td></tr>`).join('') || '<tr><td colspan="4">No recent circulation activity.</td></tr>';
  } catch (e) { message(e.message, 'error'); }
}

async function loadAdmin() {
  try {
    const { books = [] } = await api('/api/library/catalog');
    cachedBooks = books;
    $('inventoryBookId').innerHTML = books.map(b => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join('');
    const [{ users = [] }, { events = [] }, { backups = [] }] = await Promise.all([api('/api/library/users'), api('/api/library/audit?limit=100'), api('/api/library/backups')]);
    cachedUsers = users;
    $('usersBody').innerHTML = users.map(u => {
      const hasAccount = u.authentication_exists !== false;
      const isSelf = Number(u.local_user_id) === Number(profile.local_user_id);
      const status = hasAccount ? (u.active ? 'Active' : 'Inactive') : 'Deleted · history kept';
      const access = u.library_access ? 'Granted' : 'Revoked';
      const controls = isSelf ? 'Current account' : hasAccount ? `<div class="user-actions"><button class="row-action" data-security="${u.local_user_id}">View security</button><button class="row-action" data-save-role="${u.local_user_id}">Save role</button><button class="row-action" data-access="${u.local_user_id}" data-enabled="${u.active}">${u.active ? 'Deactivate' : 'Activate'}</button><button class="row-action" data-library-access="${u.local_user_id}" data-enabled="${u.library_access}">${u.library_access ? 'Revoke library' : 'Grant library'}</button><button class="row-action danger-text" data-delete-user="${u.local_user_id}">Delete account</button></div>` : 'History retained';
      const roleSelect = hasAccount && !isSelf ? `<select data-role-for="${u.local_user_id}" aria-label="Role for ${esc(u.email)}">${['student','librarian','manager','administrator'].map(role => `<option value="${role}" ${role === u.role ? 'selected' : ''}>${role}</option>`).join('')}</select>` : esc(u.role);
      return `<tr><td>${esc(u.display_name)}</td><td>${esc(u.email)}</td><td>${roleSelect}</td><td>${esc(status)}</td><td>${esc(access)}</td><td>${controls}</td></tr>`;
    }).join('') || '<tr><td colspan="6">No accounts.</td></tr>';
    $('auditBody').innerHTML = events.map(e => `<tr><td>${date(e.created_at)}</td><td>${esc(e.action)}</td><td>${esc(e.entity_type)} ${esc(e.entity_id || '')}</td></tr>`).join('') || '<tr><td colspan="3">No audit events.</td></tr>';
    const restoreSelect = $('restoreBackupSelect');
    const previousBackup = restoreSelect.value;
    restoreSelect.innerHTML = `<option value="">Choose a backup to restore</option>${backups.map(b => `<option value="${esc(b.id)}">${esc(dateTime(b.created_at))} · ${esc(b.id.slice(0,8))}</option>`).join('')}`;
    if (backups.some(b => b.id === previousBackup)) restoreSelect.value = previousBackup;
    $('restoreBackupButton').disabled = !restoreSelect.value;
    $('backupsBody').innerHTML = backups.map(b => `<tr><td class="date-time">${esc(dateTime(b.created_at))}</td><td>${Math.ceil(Number(b.byte_length)/1024)} KB</td><td>${esc(JSON.stringify(b.record_counts))}</td><td><button class="row-action" data-preview="${esc(b.id)}">Preview</button></td></tr>`).join('') || '<tr><td colspan="4">No backups yet.</td></tr>';
  } catch (e) { message(e.message, 'error'); }
}

async function loadCategories() {
  const { categories = [] } = await api('/api/library/categories');
  libraryCategories = categories;
  $('categoryFilter').innerHTML = '<option value="">All categories</option>' + categories.map(category => `<option value="${esc(category.name)}">${esc(category.name)}</option>`).join('');
  $('bookCategorySelect').innerHTML = '<option value="">Choose a category</option>' + categories.map(category => `<option value="${esc(category.name)}">${esc(category.name)}</option>`).join('');
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) return showView(nav.dataset.view);
  const returnButton = event.target.closest('[data-return]');
  if (returnButton) {
    try { await api(`/api/library/loans/${encodeURIComponent(returnButton.dataset.return)}/return`, {method:'POST', body:'{}'}); message('Return recorded.'); await loadCatalog(); await loadLoans(false); }
    catch (e) { message(e.message, 'error'); }
  }
  const extendButton = event.target.closest('[data-extend]');
  if (extendButton) {
    const dueAt=prompt('Enter the approved new due date (YYYY-MM-DD):');
    if(dueAt) try { const iso=new Date(`${dueAt}T23:59:59`).toISOString(); await api(`/api/library/loans/${encodeURIComponent(extendButton.dataset.extend)}/due-date`,{method:'PATCH',body:JSON.stringify({dueAt:iso})}); message('Due date updated and audited.'); await loadLoans(false); }
    catch(e) { message(e.message,'error'); }
  }
  const archive = event.target.closest('[data-archive]');
  if (archive && confirm('Archive this title? Loan history will be retained.')) {
    try { await api(`/api/library/books/${encodeURIComponent(archive.dataset.archive)}`, {method:'PATCH', body:JSON.stringify({archived:true})}); message('Title archived.'); loadCatalog(); }
    catch (e) { message(e.message, 'error'); }
  }
  const editBook = event.target.closest('[data-edit-book]');
  if (editBook) {
    const book = cachedBooks.find(item => item.id === editBook.dataset.editBook);
    if (!book) return;
    const title = prompt('Book title:', book.title);
    if (title === null) return;
    const author = prompt('Author:', book.author);
    if (author === null) return;
    const category = prompt('Category:', book.category || '');
    if (category === null) return;
    try {
      await api(`/api/library/books/${encodeURIComponent(book.id)}`, {method:'PATCH', body:JSON.stringify({title,author,category:category || null})});
      message('Book details updated.');
      await loadCatalog();
    } catch (e) { message(e.message, 'error'); }
  }
  const access = event.target.closest('[data-access]');
  if (access) {
    const active = access.dataset.enabled !== 'true';
    try { await api(`/api/library/users/${access.dataset.access}/access`, {method:'PATCH',body:JSON.stringify({active})}); message(active ? 'Account activated.' : 'Account deactivated.'); loadAdmin(); }
    catch (e) { message(e.message, 'error'); }
  }
  const libraryAccess = event.target.closest('[data-library-access]');
  if (libraryAccess) {
    const libraryAccessValue = libraryAccess.dataset.enabled !== 'true';
    try { await api(`/api/library/users/${libraryAccess.dataset.libraryAccess}/access`,{method:'PATCH',body:JSON.stringify({libraryAccess:libraryAccessValue})}); message(libraryAccessValue?'Library access granted.':'Library access revoked.'); await loadAdmin(); }
    catch(e) { message(e.message,'error'); }
  }
  const security = event.target.closest('[data-security]');
  if (security) {
    try {
      let result = await api(`/api/users/${security.dataset.security}/security`);
      if (confirm('The hash is one-way and cannot reveal the password. Deliberately reveal the stored encoded hash?')) result = await api(`/api/users/${security.dataset.security}/security?reveal=1`);
      const fields = [['Account', result.security.email],['Role',result.security.role],['Hashing method',result.security.hashingAlgorithm],['Hash parameters',JSON.stringify(result.security.parameters)],['Password hash',result.security.passwordHash],['Individual salt',result.security.salt],['2FA enabled',result.security.twoFactorEnabled ? 'Yes' : 'No'],['Password changed',dateTime(result.security.passwordChangedAt)]];
      $('securityDetails').innerHTML = fields.map(([label,value]) => `<div class="security-item"><strong>${esc(label)}</strong><code>${esc(value ?? '—')}</code>${['Password hash','Individual salt'].includes(label) ? `<button type="button" data-copy-security="${esc(label)}">Copy</button>` : ''}</div>`).join('');
      $('securityDetails').closest('details').open = true;
      $('securityDetails').dataset.hash = result.security.passwordHash || '';
      $('securityDetails').dataset.salt = result.security.salt || '';
    } catch (e) { message(e.message,'error'); }
  }
  const copySecurity = event.target.closest('[data-copy-security]');
  if (copySecurity) {
    const key = copySecurity.dataset.copySecurity === 'Password hash' ? 'hash' : 'salt';
    try { await navigator.clipboard.writeText($('securityDetails').dataset[key] || ''); message(`${copySecurity.dataset.copySecurity} copied.`); }
    catch { message('Clipboard access is unavailable in this browser.', 'error'); }
  }
  const deleteUser = event.target.closest('[data-delete-user]');
  if (deleteUser) {
    const user = cachedUsers.find(item => Number(item.local_user_id) === Number(deleteUser.dataset.deleteUser));
    if (!user || !confirm(`Permanently remove the sign-in account for ${user.email}? Existing loans and library history will be retained.`)) return;
    try { await api(`/api/users/${encodeURIComponent(user.local_user_id)}`,{method:'DELETE'}); message('Account deleted. Library history was retained.'); await loadAdmin(); }
    catch (e) { message(e.message,'error'); }
  }
  const roleButton = event.target.closest('[data-save-role]');
  if (roleButton) {
    const select = document.querySelector(`[data-role-for="${roleButton.dataset.saveRole}"]`);
    try { await api(`/api/users/${roleButton.dataset.saveRole}/role`, {method:'PATCH',body:JSON.stringify({role:select.value})}); message('Role updated.'); loadAdmin(); }
    catch (e) { message(e.message, 'error'); }
  }
  const backupButton = event.target.closest('[data-preview]');
  if (backupButton) {
    try {
      $('restoreBackupSelect').value = backupButton.dataset.preview;
      $('restoreBackupButton').disabled = false;
      const preview = await api(`/api/library/backups/${encodeURIComponent(backupButton.dataset.preview)}/preview`);
      message(`Backup preview ready: ${JSON.stringify(preview.recordCounts)} records. Use Restore backup to continue.`);
    } catch (e) { message(e.message,'error'); }
  }
});

$('searchForm').addEventListener('submit', e => { e.preventDefault(); loadCatalog(); });
$('categoryFilter').addEventListener('change', loadCatalog);
$('formatFilter').addEventListener('change', loadCatalog);
$('refreshLoans').addEventListener('click', () => loadLoans(true));
$('refreshAllLoans').addEventListener('click', () => loadLoans(false));
$('refreshReports').addEventListener('click', loadReports);
$('refreshAdmin').addEventListener('click', loadAdmin);
$('issueForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/library/loans',{method:'POST',body:JSON.stringify({copyId:$('copySelect').value,borrowerId:Number($('borrowerSelect').value),dueAt:new Date(`${$('dueDate').value}T23:59:59`).toISOString()})}); message('Book issued.'); await loadStaffData(); await loadLoans(false); }
  catch (err) { message(err.message, 'error'); }
});
$('bookForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.currentTarget); const payload = Object.fromEntries(f.entries()); payload.physicalCopies = Number(payload.physicalCopies); payload.ebookLicenses = Number(payload.ebookLicenses); payload.publicationYear = payload.publicationYear ? Number(payload.publicationYear) : null;
  try { await api('/api/library/books',{method:'POST',body:JSON.stringify(payload)}); e.currentTarget.reset(); message('Title and inventory saved.'); await loadCatalog(); }
  catch (err) { message(err.message,'error'); }
});
$('inventoryForm').addEventListener('submit', async e => {
  e.preventDefault(); const form=new FormData(e.currentTarget); const payload={bookId:form.get('bookId'),count:Number(form.get('count')),format:form.get('format'),digitalUrl:form.get('digitalUrl')};
  try { await api('/api/library/copies',{method:'POST',body:JSON.stringify(payload)}); e.currentTarget.reset(); message('Inventory copies added.'); await loadCatalog(); await loadAdmin(); }
  catch(err) { message(err.message,'error'); }
});
$('userForm').addEventListener('submit', async e => {
  e.preventDefault(); const payload = Object.fromEntries(new FormData(e.currentTarget).entries());
  const email = String(payload.email || '').trim().toLowerCase();
  const submitButton = e.currentTarget.querySelector('button[type="submit"],button:not([type])');
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Creating…'; }
  try {
    await api('/api/users',{method:'POST',body:JSON.stringify(payload)});
    e.currentTarget.reset();
    await loadAdmin();
    if (cachedUsers.some(user => String(user.email).toLowerCase() === email)) message('Account created and added to Users and access. The user will enroll in 2FA at first login.');
    else message('Account created, but the refreshed list did not include it. Use Refresh administration to try again.', 'error');
  }
  catch (err) { message(err.message,'error'); }
  finally { if (submitButton) { submitButton.disabled = false; submitButton.textContent = 'Create account'; } }
});
$('createBackup').addEventListener('click', async () => {
  try { const result = await api('/api/library/backups',{method:'POST',body:'{}'}); message(`Encrypted backup created (${result.backup.id}).`); await loadAdmin(); }
  catch (e) { message(e.message,'error'); }
});
$('restoreBackupSelect').addEventListener('change', () => { $('restoreBackupButton').disabled = !$('restoreBackupSelect').value; });
$('restoreBackupButton').addEventListener('click', async () => {
  const backupId = $('restoreBackupSelect').value;
  if (!backupId) return message('Choose a backup first.', 'error');
  try {
    const preview = await api(`/api/library/backups/${encodeURIComponent(backupId)}/preview`);
    if (!confirm(`This backup contains ${JSON.stringify(preview.recordCounts)}. Restoring replaces current library data. Continue?`)) return;
    const phrase = prompt('Type RESTORE LMS DATA to confirm the restore:');
    if (phrase !== 'RESTORE LMS DATA') return message('Restore cancelled.');
    await api(`/api/library/backups/${encodeURIComponent(backupId)}/restore`,{method:'POST',body:JSON.stringify({confirmation:phrase})});
    message('Restore completed.');
    await loadAdmin();
  } catch (e) { message(e.message,'error'); }
});
$('changePasswordForm').addEventListener('submit', async e => {
  e.preventDefault(); const payload=Object.fromEntries(new FormData(e.currentTarget).entries());
  try { await api('/api/auth/password',{method:'POST',body:JSON.stringify(payload)}); sessionStorage.clear(); message('Password changed. Please sign in with your new password.'); setTimeout(()=>location.href='index.html',1200); }
  catch(err) { message(err.message,'error'); }
});
let libraryLoggingOut = false;
$('logoutButton').addEventListener('click', async event => {
  if (libraryLoggingOut) return;
  libraryLoggingOut = true;
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Signing out…';
  try { await api('/api/auth/logout',{method:'POST',body:'{}',signal:AbortSignal.timeout(5000)}); }
  finally { sessionStorage.clear(); location.replace('index.html'); }
});

async function start() {
  try {
    const auth = await api('/api/auth/me');
    if (auth.csrfToken) sessionStorage.setItem('csrfToken', auth.csrfToken);
    const { user } = await api('/api/library/me'); profile = user;
    $('welcome').textContent = `Welcome, ${user.display_name || user.email}`;
    const roleTitles = { student: 'My Library', librarian: 'Librarian Dashboard', manager: 'Library Manager', administrator: 'Library Administration' };
    $('workspaceTitle').textContent = roleTitles[user.role] || 'Library Dashboard';
    $('roleBadge').textContent = String(user.role || 'member').replaceAll('_', ' ').toUpperCase();
    const updateClock = () => { $('workspaceClock').textContent = new Intl.DateTimeFormat(undefined, {dateStyle:'full',timeStyle:'medium'}).format(new Date()); };
    updateClock();
    setInterval(updateClock, 1000);
    document.querySelectorAll('[data-roles]').forEach(el => { el.hidden = !el.dataset.roles.split(',').includes(user.role); });
    if (user.role === 'librarian') document.querySelector('[data-view="loans"]').textContent = 'Loan history';
    await loadCategories();
    showView('catalog');
  } catch (e) {
    if (/Authentication|Session/i.test(e.message)) location.href = 'index.html';
    else message(e.message, 'error');
  }
}
start();
