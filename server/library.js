/** Library API. All persistence is through the server-only Supabase client.
 * Run database/migrations/001_library.sql in the Supabase SQL editor first.
 */
const express = require('express');
const { requireAuth, requireRole } = require('./rbac');
const { getClient, isConfigured } = require('./supabase');
const { logAudit, listUsers } = require('./database');
const { updateUserStatus, deleteUserSessions } = require('./database');
const { getUserById, updateUserRole } = require('./database');
const { encryptSecret, decryptSecret } = require('./crypto');
const crypto = require('crypto');

const router = express.Router();
const ROLES = ['administrator', 'librarian', 'manager', 'student'];
const STAFF = ['administrator', 'librarian'];
const MANAGEMENT = ['administrator'];
const BACKUP_BUCKET = 'lms-backups';

function db() {
  if (!isConfigured()) {
    const error = new Error('Library database is not configured.');
    error.status = 503;
    throw error;
  }
  return getClient();
}

function isSecureReaderUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

function legacyRoleToLibrary(role) {
  if (role === 'administrator') return 'administrator';
  if (role === 'manager') return 'manager';
  if (role === 'admin') return 'librarian';
  return 'student';
}

async function actor(req) {
  const client = db();
  const baseRole = legacyRoleToLibrary(req.user.role);
  const { data, error } = await client.from('lms_users').upsert({
    local_user_id: req.user.id,
    email: req.user.email.toLowerCase(),
    username: req.user.email.toLowerCase(),
    display_name: req.user.name || req.user.email,
    role: baseRole
  }, { onConflict: 'local_user_id', ignoreDuplicates: true }).select('id,local_user_id,email,display_name,role,active,library_access').maybeSingle();
  if (error) throw error;
  if (data) return data;
  const found = await client.from('lms_users').select('id,local_user_id,email,display_name,role,active,library_access').eq('local_user_id', req.user.id).single();
  if (found.error) throw found.error;
  return found.data;
}

function requireLibraryRole(roles) {
  return async (req, res, next) => {
    try {
      req.libraryActor = await actor(req);
      if (!req.libraryActor.active || !req.libraryActor.library_access) return res.status(403).json({ error: 'Library access is disabled.' });
      if (!roles.includes(req.libraryActor.role)) return res.status(403).json({ error: 'You are not authorized for this library action.' });
      next();
    } catch (e) { next(e); }
  };
}

function fail(res, error) {
  const msg = String(error.message || 'Library request failed');
  const status = error.status || (error.code === '23505' ? 409 : error.code === '23514' ? 400 : error.code === 'P0001' ? 409 : /^PGRST/.test(error.code || '') || /schema cache/i.test(msg) ? 503 : msg.includes('not available') || msg.includes('not found') ? 409 : 500);
  return res.status(status).json({ error: status >= 500 ? 'Library request failed. Check that the LMS migration is applied and the database is reachable.' : msg });
}

router.get('/library/me', requireAuth, async (req, res) => {
  try { const user = await actor(req); res.json({ user }); } catch (e) { fail(res, e); }
});

router.get('/library/categories', requireAuth, requireLibraryRole(ROLES), async (req, res) => {
  try {
    const { data, error } = await db().from('book_categories').select('id,name,description,sort_order').eq('active', true).order('sort_order').order('name');
    if (error) throw error;
    res.json({ categories: data || [] });
  } catch (e) { fail(res, e); }
});

router.get('/library/catalog', requireAuth, requireLibraryRole(ROLES), async (req, res) => {
  try {
    const client = db();
    const term = String(req.query.q || '').replace(/[^\p{L}\p{N}\s-]/gu,'').trim().slice(0, 100);
    let query = client.from('books').select('id,isbn,title,author,category,category_id,category_detail:book_categories(name),publisher,publication_year,description,archived,book_copies(id,barcode,status,format)').eq('archived', false).order('title').limit(100);
    if (term) query = query.or(`title.ilike.%${term}%,author.ilike.%${term}%,isbn.ilike.%${term}%,category.ilike.%${term}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ books: (data || []).map(b => {
      const copies = b.book_copies || [];
      const physical = copies.filter(copy => copy.format === 'physical');
      const ebooks = copies.filter(copy => copy.format === 'ebook');
      return {
        ...b,
        category: b.category_detail?.name || b.category,
        copies,
        totalCopies: copies.length,
        availableCopies: copies.filter(copy => copy.status === 'available').length,
        physicalCopies: physical.length,
        availablePhysicalCopies: physical.filter(copy => copy.status === 'available').length,
        ebookLicenses: ebooks.length,
        availableEbookLicenses: ebooks.filter(copy => copy.status === 'available').length,
        formats: [...new Set(copies.map(copy => copy.format || 'physical'))]
      };
    }) });
  } catch (e) { fail(res, e); }
});

// Book details are public only to signed-in library readers. An eBook's actual
// reading URL is returned only when this reader holds an active license loan.
router.get('/library/books/:id', requireAuth, requireLibraryRole(ROLES), async (req, res) => {
  try {
    const client = db();
    const { data: book, error } = await client.from('books')
      .select('id,isbn,title,author,category,category_id,category_detail:book_categories(name),publisher,publication_year,description,archived,book_copies(id,barcode,status,format,created_at)')
      .eq('id', req.params.id).eq('archived', false).maybeSingle();
    if (error) throw error;
    if (!book) return res.status(404).json({ error: 'This book is no longer in the catalogue.' });

    const copies = book.book_copies || [];
    const copyIds = copies.map(copy => copy.id);
    let myActiveLoans = [];
    if (copyIds.length) {
      const { data: loans, error: loanError } = await client.from('loans')
        .select('id,borrowed_at,due_at,copy:book_copies(id,format,digital_url)')
        .eq('borrower_id', req.libraryActor.id).is('returned_at', null).in('copy_id', copyIds);
      if (loanError) throw loanError;
      myActiveLoans = (loans || []).map(loan => ({
        id: loan.id,
        borrowedAt: loan.borrowed_at,
        dueAt: loan.due_at,
        format: loan.copy?.format,
        ebookUrl: loan.copy?.format === 'ebook' && /^https:\/\//i.test(loan.copy?.digital_url || '') ? loan.copy.digital_url : null
      }));
    }
    const physical = copies.filter(copy => copy.format === 'physical');
    const ebooks = copies.filter(copy => copy.format === 'ebook');
    res.set('Cache-Control', 'no-store');
    res.json({
      book: { ...book, category: book.category_detail?.name || book.category, category_detail: undefined, book_copies: undefined,
        copies: copies.map(({id,barcode,status,format}) => ({id,barcode,status,format})),
        physicalCopies: physical.length, availablePhysicalCopies: physical.filter(copy => copy.status === 'available').length,
        ebookLicenses: ebooks.length, availableEbookLicenses: ebooks.filter(copy => copy.status === 'available').length,
        formats: [...new Set(copies.map(copy => copy.format || 'physical'))] },
      myActiveLoans
    });
  } catch (e) { fail(res, e); }
});

// Student self-checkout. The database routine locks the selected copy and
// enforces availability and the five-open-loan limit atomically.
router.post('/library/books/:id/borrow', requireAuth, requireLibraryRole(ROLES), async (req, res) => {
  try {
    if (req.libraryActor.role !== 'student') return res.status(403).json({ error: 'Student accounts can borrow from the catalogue. Staff should use Circulation.' });
    const format = String(req.body?.format || '');
    if (!['physical','ebook'].includes(format)) return res.status(400).json({ error: 'Choose a physical copy or an eBook license.' });
    const client = db();
    const { data: copy, error } = await client.from('book_copies').select('id')
      .eq('book_id', req.params.id).eq('format', format).eq('status', 'available')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (error) throw error;
    if (!copy) return res.status(409).json({ error: `No ${format === 'ebook' ? 'eBook licenses' : 'physical copies'} are available right now.` });
    const dueAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: loanId, error: issueError } = await client.rpc('issue_book_copy', {
      p_copy: copy.id, p_borrower: req.libraryActor.id, p_actor: req.libraryActor.id, p_due_at: dueAt
    });
    if (issueError) throw issueError;
    await logAudit({ userId: req.user.id, action: 'LOAN_SELF_CHECKOUT', ip: req.ip, userAgent: req.get('user-agent'), status: 'SUCCESS', details: `Loan ${loanId}` });
    res.status(201).json({ loanId, dueAt, format });
  } catch (e) { fail(res, e); }
});

router.post('/library/books', requireAuth, requireLibraryRole(MANAGEMENT), async (req, res) => {
  try {
    const { title, author, isbn = null, category = null, publisher = null, publicationYear = null, description = null } = req.body || {};
    const physicalCopies = Number(req.body?.physicalCopies ?? req.body?.copies ?? 1);
    const ebookLicenses = Number(req.body?.ebookLicenses ?? 0);
    const ebookUrl = String(req.body?.ebookUrl || '').trim();
    if (!String(title || '').trim() || !String(author || '').trim()) return res.status(400).json({ error: 'Title and author are required.' });
    if (String(title).trim().length > 240 || String(author).trim().length > 180 || String(isbn || '').trim().length > 32 || String(category || '').length > 100 || String(publisher || '').length > 180 || String(description || '').length > 5000) return res.status(400).json({ error: 'One or more book fields exceed the allowed length.' });
    if (publicationYear !== null && publicationYear !== '' && (!Number.isInteger(Number(publicationYear)) || Number(publicationYear) < 0 || Number(publicationYear) > 2200)) return res.status(400).json({ error: 'Publication year must be a whole number from 0 to 2200.' });
    if (!Number.isInteger(physicalCopies) || physicalCopies < 0 || physicalCopies > 500 || !Number.isInteger(ebookLicenses) || ebookLicenses < 0 || ebookLicenses > 500 || physicalCopies + ebookLicenses < 1) return res.status(400).json({ error: 'Add at least one physical copy or eBook license; each quantity must be between 0 and 500.' });
    if (ebookLicenses && (!isSecureReaderUrl(ebookUrl) || ebookUrl.length > 2000)) return res.status(400).json({ error: 'Provide a valid HTTPS reading link for eBook licenses.' });
    const client = db();
    let categoryId = null;
    if (category) {
      const { data: foundCategory, error: categoryError } = await client.from('book_categories').select('id').eq('name', String(category).trim()).maybeSingle();
      if (categoryError) throw categoryError;
      if (!foundCategory) return res.status(400).json({ error: 'Choose a category from the library category list.' });
      categoryId = foundCategory.id;
    }
    const { data: book, error } = await client.from('books').insert({ title: String(title).trim(), author: String(author).trim(), isbn: isbn ? String(isbn).trim() : null, category, category_id: categoryId, publisher, publication_year: publicationYear === null || publicationYear === '' ? null : Number(publicationYear), description }).select().single();
    if (error) throw error;
    const inventory = [
      ...Array.from({ length: physicalCopies }, (_, i) => ({ book_id: book.id, barcode: `LIB-${book.id.slice(0, 8).toUpperCase()}-P-${String(i + 1).padStart(3, '0')}`, format: 'physical' })),
      ...Array.from({ length: ebookLicenses }, (_, i) => ({ book_id: book.id, barcode: `LIB-${book.id.slice(0, 8).toUpperCase()}-E-${String(i + 1).padStart(3, '0')}`, format: 'ebook', digital_url: ebookUrl }))
    ];
    const { error: copyError } = await client.from('book_copies').insert(inventory);
    if (copyError) { await client.from('books').delete().eq('id', book.id); throw copyError; }
    await client.from('audit_events').insert({ actor_id: req.libraryActor.id, action: 'BOOK_CREATED', entity_type: 'book', entity_id: book.id });
    res.status(201).json({ book, physicalCopies, ebookLicenses });
  } catch (e) { fail(res, e); }
});

router.patch('/library/books/:id', requireAuth, requireLibraryRole(MANAGEMENT), async (req, res) => {
  try {
    const allowed = ['title','author','isbn','category','publisher','description','publication_year','archived'];
    const values = {};
    for (const key of allowed) if (Object.hasOwn(req.body || {}, key)) values[key] = req.body[key];
    if (!Object.keys(values).length) return res.status(400).json({ error: 'No editable book fields supplied.' });
    if (Object.hasOwn(values, 'title') && (!String(values.title).trim() || String(values.title).trim().length > 240)) return res.status(400).json({ error: 'Title is required and must be 240 characters or fewer.' });
    if (Object.hasOwn(values, 'author') && (!String(values.author).trim() || String(values.author).trim().length > 180)) return res.status(400).json({ error: 'Author is required and must be 180 characters or fewer.' });
    if (Object.hasOwn(values, 'isbn') && String(values.isbn || '').length > 32) return res.status(400).json({ error: 'ISBN must be 32 characters or fewer.' });
    if (Object.hasOwn(values, 'publication_year') && values.publication_year !== null && (!Number.isInteger(Number(values.publication_year)) || Number(values.publication_year) < 0 || Number(values.publication_year) > 2200)) return res.status(400).json({ error: 'Publication year must be a whole number from 0 to 2200.' });
    if (Object.hasOwn(values, 'archived') && typeof values.archived !== 'boolean') return res.status(400).json({ error: 'Archived must be true or false.' });
    for (const [key, max] of [['category',100],['publisher',180],['description',5000]]) if (Object.hasOwn(values,key) && String(values[key] || '').length > max) return res.status(400).json({ error: `${key} exceeds the allowed length.` });
    if (typeof values.title === 'string') values.title = values.title.trim();
    if (typeof values.author === 'string') values.author = values.author.trim();
    if (Object.hasOwn(values, 'category')) {
      if (!values.category) values.category_id = null;
      else {
        const { data: selectedCategory, error: categoryError } = await db().from('book_categories').select('id').eq('name', String(values.category).trim()).maybeSingle();
        if (categoryError) throw categoryError;
        if (!selectedCategory) return res.status(400).json({ error: 'Choose a category from the library category list.' });
        values.category = String(values.category).trim();
        values.category_id = selectedCategory.id;
      }
    }
    values.updated_at = new Date().toISOString();
    const { data, error } = await db().from('books').update(values).eq('id', req.params.id).select().single();
    if (error) throw error;
    await db().from('audit_events').insert({ actor_id: req.libraryActor.id, action: values.archived ? 'BOOK_ARCHIVED' : 'BOOK_UPDATED', entity_type: 'book', entity_id: data.id });
    res.json({ book: data });
  } catch (e) { fail(res, e); }
});

router.post('/library/copies', requireAuth, requireLibraryRole(MANAGEMENT), async (req, res) => {
  try {
    const bookId = String(req.body?.bookId || '');
    const count = Number(req.body?.count || 1);
    const format = req.body?.format || 'physical';
    const digitalUrl = String(req.body?.digitalUrl || '').trim();
    if (!bookId || !Number.isInteger(count) || count < 1 || count > 500) return res.status(400).json({ error: 'A book and copy count from 1 to 500 are required.' });
    if (!['physical','ebook'].includes(format)) return res.status(400).json({ error: 'Format must be physical or ebook.' });
    if (format === 'ebook' && (!isSecureReaderUrl(digitalUrl) || digitalUrl.length > 2000)) return res.status(400).json({ error: 'Provide a valid HTTPS reading link for the eBook.' });
    const client = db();
    const copies = Array.from({ length: count }, () => ({ book_id: bookId, barcode: `LIB-${bookId.slice(0, 8).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, format, digital_url: format === 'ebook' ? digitalUrl : null }));
    const { data, error } = await client.from('book_copies').insert(copies).select();
    if (error) throw error;
    res.status(201).json({ copies: data });
  } catch (e) { fail(res, e); }
});

router.get('/library/users', requireAuth, requireLibraryRole(STAFF), async (req, res) => {
  try {
    const q = String(req.query.q || '').replace(/[^\p{L}\p{N}\s@._-]/gu,'').trim().slice(0, 100);
    const client = db();
    const authUsers = await listUsers();
    const missingProfiles = authUsers.map(u => ({ local_user_id: u.id, email: u.email.toLowerCase(), username: u.email.toLowerCase(), display_name: u.name || u.email, role: legacyRoleToLibrary(u.role) }));
    if (missingProfiles.length) {
      const { error: syncError } = await client.from('lms_users').upsert(missingProfiles, { onConflict: 'local_user_id', ignoreDuplicates: true });
      if (syncError) throw syncError;
    }
    const data = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      let query = client.from('lms_users').select('id,local_user_id,email,display_name,role,active,library_access').order('display_name').range(offset, offset + pageSize - 1);
      if (q) query = query.or(`email.ilike.%${q}%,display_name.ilike.%${q}%`);
      const { data: page, error } = await query;
      if (error) throw error;
      data.push(...(page || []));
      if (!page || page.length < pageSize) break;
    }
    // Use the auth store as the source of truth for newly provisioned accounts.
    // A just-created profile can be briefly absent from a paginated profile read;
    // include it here so it appears in the authorization list immediately.
    const usersById = new Map((data || []).map(user => [Number(user.local_user_id), user]));
    for (const user of authUsers) {
      const id = Number(user.id);
      const email = String(user.email || '').toLowerCase();
      if (!usersById.has(id) && (!q || email.includes(q.toLowerCase()) || String(user.name || '').toLowerCase().includes(q.toLowerCase()))) {
        usersById.set(id, {
          local_user_id: id,
          email,
          display_name: user.name || user.email,
          role: legacyRoleToLibrary(user.role),
          active: user.active !== false,
          library_access: true
        });
      }
    }
    const identityIds = new Set(authUsers.map(user => Number(user.id)));
    res.set('Cache-Control', 'no-store');
    res.json({ users: [...usersById.values()].map(user => ({ ...user, authentication_exists: identityIds.has(Number(user.local_user_id)) })) });
  } catch (e) { fail(res, e); }
});

router.patch('/library/users/:id/access', requireAuth, requireLibraryRole(MANAGEMENT), async (req, res) => {
  try {
    const localId = Number(req.params.id);
    if (!Number.isSafeInteger(localId) || localId < 1 || localId === req.user.id) return res.status(400).json({ error: 'Choose another valid account.' });
    const active = req.body?.active;
    const libraryAccess = req.body?.libraryAccess;
    if (typeof active !== 'boolean' && typeof libraryAccess !== 'boolean') return res.status(400).json({ error: 'Provide active or libraryAccess as a boolean.' });
    const client = db();
    const changes = {};
    if (typeof active === 'boolean') changes.active = active;
    if (typeof libraryAccess === 'boolean') changes.library_access = libraryAccess;
    const { data, error } = await client.from('lms_users').update(changes).eq('local_user_id', localId).select('id,local_user_id,active,library_access').single();
    if (error) throw error;
    if (typeof active === 'boolean') {
      await updateUserStatus(localId, active);
      if (!active) await deleteUserSessions(localId);
    }
    await client.from('audit_events').insert({ actor_id: req.libraryActor.id, action: active === false ? 'USER_DEACTIVATED' : active === true ? 'USER_ACTIVATED' : 'LIBRARY_ACCESS_UPDATED', entity_type: 'user', entity_id: data.id });
    res.json({ user: data });
  } catch (e) { fail(res, e); }
});

router.get('/library/loans', requireAuth, requireLibraryRole(ROLES), async (req, res) => {
  try {
    const client = db();
    let query = client.from('loans').select('id,borrowed_at,due_at,returned_at,copy:book_copies(id,barcode,format,digital_url,book:books(id,title,author,isbn)),borrower:lms_users!loans_borrower_id_fkey(id,local_user_id,email,display_name)').order('borrowed_at', { ascending: false }).limit(200);
    if (req.libraryActor.role === 'student') query = query.eq('borrower_id', req.libraryActor.id);
    if (req.query.status === 'open') query = query.is('returned_at', null);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ loans: data || [] });
  } catch (e) { fail(res, e); }
});

router.post('/library/loans', requireAuth, requireLibraryRole(STAFF), async (req, res) => {
  try {
    const { copyId, borrowerId, dueAt } = req.body || {};
    if (!copyId || !borrowerId || !dueAt || !Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) <= Date.now()) return res.status(400).json({ error: 'Copy, borrower, and a future due date are required.' });
    const { data: borrower, error } = await db().from('lms_users').select('id,active,library_access,role').eq('local_user_id', Number(borrowerId)).single();
    if (error) throw error;
    if (!borrower.active || !borrower.library_access || borrower.role !== 'student') return res.status(409).json({ error: 'Borrower is not an active student with library access.' });
    const { data, error: issueError } = await db().rpc('issue_book_copy', { p_copy: copyId, p_borrower: borrower.id, p_actor: req.libraryActor.id, p_due_at: new Date(dueAt).toISOString() });
    if (issueError) throw issueError;
    await logAudit({ userId: req.user.id, action: 'LOAN_ISSUED', ip: req.ip, userAgent: req.get('user-agent'), status: 'SUCCESS', details: `Loan ${data}` });
    res.status(201).json({ loanId: data });
  } catch (e) { fail(res, e); }
});

router.post('/library/loans/:id/return', requireAuth, requireLibraryRole(STAFF), async (req, res) => {
  try {
    const { error } = await db().rpc('return_book_copy', { p_loan: req.params.id, p_actor: req.libraryActor.id });
    if (error) throw error;
    await logAudit({ userId: req.user.id, action: 'LOAN_RETURNED', ip: req.ip, userAgent: req.get('user-agent'), status: 'SUCCESS', details: `Loan ${req.params.id}` });
    res.json({ returned: true });
  } catch (e) { fail(res, e); }
});

router.patch('/library/loans/:id/due-date', requireAuth, requireLibraryRole(MANAGEMENT), async (req,res) => {
  try {
    const timestamp = Date.parse(req.body?.dueAt || '');
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return res.status(400).json({error:'An approved due date must be in the future.'});
    const client = db();
    const {data:loan,error:lookupError}=await client.from('loans').select('id,borrowed_at,returned_at').eq('id',req.params.id).single();
    if(lookupError) throw lookupError;
    if(loan.returned_at) return res.status(409).json({error:'A returned loan cannot be extended.'});
    const {data,error}=await client.from('loans').update({due_at:new Date(timestamp).toISOString()}).eq('id',req.params.id).select('id,due_at').single();
    if(error) throw error;
    const {error:auditError}=await client.from('audit_events').insert({actor_id:req.libraryActor.id,action:'DUE_DATE_EXTENDED',entity_type:'loan',entity_id:data.id,details:{dueAt:data.due_at}});
    if(auditError) throw auditError;
    res.json({loan:data});
  } catch(e) { fail(res,e); }
});

router.get('/library/reports/summary', requireAuth, requireLibraryRole(['administrator','manager']), async (req, res) => {
  try {
    const client = db();
    const [books,copies,ebooks,open,returned,overdue] = await Promise.all([
      client.from('books').select('id',{count:'exact',head:true}).eq('archived',false),
      client.from('book_copies').select('id',{count:'exact',head:true}).eq('format','physical'),
      client.from('book_copies').select('id',{count:'exact',head:true}).eq('format','ebook'),
      client.from('loans').select('id',{count:'exact',head:true}).is('returned_at',null),
      client.from('loans').select('id',{count:'exact',head:true}).not('returned_at','is',null),
      client.from('loans').select('id',{count:'exact',head:true}).is('returned_at',null).lt('due_at',new Date().toISOString())
    ]);
    for (const r of [books,copies,ebooks,open,returned,overdue]) if (r.error) throw r.error;
    res.json({ totalTitles: books.count || 0, copies: copies.count || 0, ebookLicenses: ebooks.count || 0, activeLoans: open.count || 0, returnedLoans: returned.count || 0, overdueLoans: overdue.count || 0 });
  } catch (e) { fail(res, e); }
});

router.get('/library/reports/activity', requireAuth, requireLibraryRole(['administrator','manager']), async (req, res) => {
  try {
    const activityActions = ['LOAN_ISSUED','LOAN_RETURNED','DUE_DATE_EXTENDED'];
    const { data, error } = await db().from('audit_events')
      .select('id,action,entity_type,entity_id,created_at,actor:lms_users!audit_events_actor_id_fkey(display_name,role)')
      .in('action', activityActions).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (e) { fail(res, e); }
});

router.get('/library/audit', requireAuth, requireLibraryRole(MANAGEMENT), async (req, res) => {
  try {
    const { data, error } = await db().from('audit_events').select('id,actor_id,action,entity_type,entity_id,details,created_at').order('created_at',{ascending:false}).limit(Math.min(Number(req.query.limit)||100,250));
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (e) { fail(res, e); }
});

async function loadBackup(client, metadata) {
  const { data, error } = await client.storage.from(BACKUP_BUCKET).download(metadata.object_path);
  if (error) throw error;
  const encrypted = Buffer.from(await data.arrayBuffer()).toString('utf8');
  const snapshot = JSON.parse(decryptSecret(encrypted));
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.books) || !Array.isArray(snapshot.copies) || !Array.isArray(snapshot.loans) || !Array.isArray(snapshot.users) || !Array.isArray(snapshot.auditEvents)) {
    throw new Error('Backup contents did not pass validation.');
  }
  return snapshot;
}

router.post('/library/backups', requireAuth, requireLibraryRole(MANAGEMENT), async (req, res) => {
  let path;
  try {
    const client = db();
    const { data: snapshot, error: snapshotError } = await client.rpc('create_lms_snapshot');
    if (snapshotError) throw snapshotError;
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.users) || !Array.isArray(snapshot.books) || !Array.isArray(snapshot.copies) || !Array.isArray(snapshot.loans) || !Array.isArray(snapshot.auditEvents)) throw new Error('Cloud backup snapshot failed validation.');
    const encrypted = encryptSecret(JSON.stringify(snapshot));
    const payload = Buffer.from(encrypted,'utf8');
    const id = crypto.randomUUID();
    path = `${id}.enc`;
    const { error: uploadError } = await client.storage.from(BACKUP_BUCKET).upload(path,payload,{contentType:'application/octet-stream',upsert:false});
    if (uploadError) throw uploadError;
    const counts = {users:snapshot.users.length,books:snapshot.books.length,copies:snapshot.copies.length,loans:snapshot.loans.length,auditEvents:snapshot.auditEvents.length};
    const { data, error } = await client.from('backup_metadata').insert({id,object_path:path,created_by:req.libraryActor.id,byte_length:payload.length,record_counts:counts}).select('id,created_at,byte_length,record_counts').single();
    if (error) { await client.storage.from(BACKUP_BUCKET).remove([path]); throw error; }
    res.status(201).json({ backup:data });
  } catch (e) { fail(res,e); }
});

router.get('/library/backups', requireAuth, requireLibraryRole(MANAGEMENT), async (req,res) => {
  try {
    const {data,error}=await db().from('backup_metadata').select('id,created_at,byte_length,record_counts').order('created_at',{ascending:false}).limit(100);
    if(error) throw error;
    res.json({backups:data||[]});
  } catch(e) { fail(res,e); }
});

router.get('/library/backups/:id/preview', requireAuth, requireLibraryRole(MANAGEMENT), async (req,res) => {
  try {
    const client=db();
    const {data:metadata,error}=await client.from('backup_metadata').select('id,object_path,created_at,byte_length,record_counts').eq('id',req.params.id).single();
    if(error) throw error;
    const snapshot=await loadBackup(client,metadata);
    res.json({backup:{id:metadata.id,createdAt:metadata.created_at,byteLength:metadata.byte_length},recordCounts:{users:snapshot.users.length,books:snapshot.books.length,copies:snapshot.copies.length,loans:snapshot.loans.length,auditEvents:snapshot.auditEvents.length},schemaVersion:snapshot.schemaVersion,previewOnly:true});
  } catch(e) { fail(res,e); }
});

router.post('/library/backups/:id/restore', requireAuth, requireLibraryRole(MANAGEMENT), async (req,res) => {
  if (req.body?.confirmation !== 'RESTORE LMS DATA') return res.status(400).json({error:'Type RESTORE LMS DATA to confirm this restore.'});
  try {
    const client=db();
    const {data:metadata,error}=await client.from('backup_metadata').select('id,object_path,created_at,byte_length,record_counts').eq('id',req.params.id).single();
    if(error) throw error;
    const snapshot=await loadBackup(client,metadata);
    const {error:restoreError}=await client.rpc('restore_lms_snapshot',{p_actor:req.libraryActor.id,p_snapshot:snapshot});
    if(restoreError) throw restoreError;
    for(const saved of snapshot.users){
      if(await getUserById(saved.local_user_id)){
        await updateUserStatus(saved.local_user_id,Boolean(saved.active));
        await updateUserRole(saved.local_user_id,['manager','administrator'].includes(saved.role)?saved.role:'inputer');
        if(!saved.active) await deleteUserSessions(saved.local_user_id);
      }
    }
    res.json({restored:true,backupId:metadata.id,recordCounts:metadata.record_counts});
  } catch(e) { fail(res,e); }
});

module.exports = router;
