const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let currentProfile = null;
let currentBook = null;
let activeLoans = [];
let borrowing = false;

function message(text, type = 'success') {
  const notice = $('notice');
  notice.textContent = text;
  notice.className = `notice ${type}`;
  notice.hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => { notice.hidden = true; }, 5500);
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) };
  const csrf = sessionStorage.getItem('csrfToken');
  if (csrf && ['POST','PATCH','DELETE','PUT'].includes((options.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(`/api${path}`, {credentials:'include',cache:'no-store',...options,headers});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function safeReaderUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; }
  catch { return null; }
}

function coverImage(book) {
  const isbn = String(book.isbn || '').replace(/[^0-9Xx]/g,'');
  return isbn ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg?default=false` : '';
}

function meta(label, value) {
  return `<div class="book-meta-item"><span class="book-meta-label">${esc(label)}</span><span class="book-meta-value">${esc(value || 'Not provided')}</span></div>`;
}

function render() {
  const book = currentBook;
  if (!book) return;
  const activePhysical = activeLoans.find(loan => loan.format === 'physical');
  const activeEbook = activeLoans.find(loan => loan.format === 'ebook');
  const ebookUrl = activeEbook ? safeReaderUrl(activeEbook.ebookUrl) : null;
  const canBorrow = currentProfile.role === 'student';
  const image = coverImage(book);
  const formats = (book.formats || []).map(format => `<span class="format-chip ${format === 'ebook' ? 'ebook' : ''}">${format === 'ebook' ? 'eBook' : 'Physical'}</span>`).join('');
  const actions = canBorrow ? `
    ${activePhysical ? `<div class="book-loan-note">Physical copy checked out to you · due ${esc(new Date(activePhysical.dueAt).toLocaleDateString())}. Collect it at the circulation desk.</div>` : book.formats?.includes('physical') ? `<button type="button" class="book-action" data-borrow="physical" ${book.availablePhysicalCopies < 1 || borrowing ? 'disabled' : ''}>${book.availablePhysicalCopies > 0 ? 'Borrow physical copy · 14 days' : 'No physical copies available'}</button>` : ''}
    ${activeEbook && ebookUrl ? `<a class="book-action" href="${esc(ebookUrl)}" target="_blank" rel="noopener noreferrer">Continue reading online ↗</a>` : activeEbook ? `<div class="book-loan-note warning">Your eBook loan is active, but the library needs to update its secure reading link.</div>` : book.formats?.includes('ebook') ? `<button type="button" class="book-action secondary" data-borrow="ebook" ${book.availableEbookLicenses < 1 || borrowing ? 'disabled' : ''}>${book.availableEbookLicenses > 0 ? 'Borrow eBook license &amp; read online' : 'No eBook licenses available'}</button>` : ''}` : `<div class="book-loan-note">${currentProfile.role === 'librarian' || currentProfile.role === 'administrator' ? 'Use the Circulation desk to issue this title to a reader.' : 'Sign in with a student library account to borrow this title.'} <a href="library.html">Open library workspace</a></div>`;
  $('bookDetails').innerHTML = `<a class="book-back-link" href="library.html">← Back to catalogue</a>
    <div class="book-detail-layout">
      <div class="book-detail-cover" aria-label="${esc(book.title)} cover">${image ? `<img src="${esc(image)}" alt="Cover of ${esc(book.title)}" onerror="this.remove()">` : ''}<div class="book-cover-copy"><p class="book-cover-label">LIBRARY COLLECTION</p><h2>${esc(book.title)}</h2><p>${esc(book.author)}</p></div></div>
      <div class="book-detail-copy"><p class="book-detail-category">${esc(book.category || 'General collection')}</p><h1 class="book-detail-title">${esc(book.title)}</h1><p class="book-detail-author">by ${esc(book.author)}</p>
        <div class="book-detail-formats">${formats || '<span class="format-chip">Library title</span>'}</div>
        <p class="book-detail-description">${esc(book.description || 'No description is available for this title yet.')}</p>
        <div class="book-detail-metadata">${meta('Publisher',book.publisher)}${meta('Published',book.publication_year)}${meta('ISBN',book.isbn)}${meta('Category',book.category)}</div>
        <section class="book-stock-panel"><h3>Availability</h3><div class="book-stock-line"><span>Physical copies available</span><strong>${Number(book.availablePhysicalCopies || 0)} / ${Number(book.physicalCopies || 0)}</strong></div><div class="book-stock-line"><span>eBook licenses available</span><strong>${Number(book.availableEbookLicenses || 0)} / ${Number(book.ebookLicenses || 0)}</strong></div></section>
        <div id="bookActions" class="book-actions">${actions}</div>
        <p class="book-detail-note">eBooks open through the library’s linked reading provider. Only links supplied by the library for an active eBook loan are shown here. Physical loans are recorded for 14 days and the copy should be collected from the circulation desk.</p>
      </div>
    </div>`;
}

async function loadBook() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) throw new Error('No book was selected. Return to the catalogue and choose a title.');
  const [{user}, detail] = await Promise.all([api('/library/me'), api(`/library/books/${encodeURIComponent(id)}`)]);
  currentProfile = user;
  currentBook = detail.book;
  activeLoans = detail.myActiveLoans || [];
  $('readerWelcome').textContent = `Signed in as ${user.display_name || user.email}`;
  render();
}

$('bookDetails').addEventListener('click', async event => {
  const button = event.target.closest('[data-borrow]');
  if (!button || borrowing) return;
  borrowing = true;
  button.disabled = true;
  button.textContent = 'Checking availability…';
  try {
    const format = button.dataset.borrow;
    await api(`/library/books/${encodeURIComponent(currentBook.id)}/borrow`, {method:'POST',body:JSON.stringify({format})});
    message(format === 'ebook' ? 'eBook loan started. Tap Continue reading online to open the reader.' : 'Physical copy borrowed. Please collect it at the circulation desk.');
    await loadBook();
  } catch (error) {
    message(error.message || 'Could not borrow this title. Please try again.', 'error');
    try { await loadBook(); } catch { }
  } finally { borrowing = false; }
});

$('logoutButton').addEventListener('click', async () => {
  $('logoutButton').disabled = true;
  try { await api('/auth/logout',{method:'POST',body:'{}'}); }
  catch { }
  sessionStorage.clear();
  location.replace('index.html');
});

(async () => {
  try {
    const session = await api('/auth/me');
    if (session.csrfToken) sessionStorage.setItem('csrfToken', session.csrfToken);
    await loadBook();
  } catch (error) {
    if (/authentication|session/i.test(error.message)) location.replace('index.html');
    else $('bookDetails').innerHTML = `<p class="book-detail-error">${esc(error.message)}</p><a class="book-action secondary" href="library.html">Return to catalogue</a>`;
  }
})();
