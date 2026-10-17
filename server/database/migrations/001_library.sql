-- Supabase PostgreSQL foundation for the LMS. Apply only to a new project or
-- after reviewing the target database. The current Express auth service still
-- uses SQLite; these tables are a prepared cloud schema, not an active backend.
create extension if not exists pgcrypto;

create table if not exists public.lms_users (
  id uuid primary key default gen_random_uuid(),
  local_user_id integer not null unique,
  email text not null unique,
  username text not null unique,
  display_name text not null,
  role text not null check (role in ('administrator','librarian','manager','student')),
  active boolean not null default true,
  library_access boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  isbn text unique,
  title text not null,
  author text not null,
  category text,
  publisher text,
  publication_year integer check (publication_year between 0 and 2200),
  description text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists books_title_idx on public.books using gin (to_tsvector('simple', title || ' ' || author || ' ' || coalesce(isbn,'')));
create index if not exists books_category_idx on public.books(category);

create table if not exists public.book_copies (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete restrict,
  barcode text not null unique,
  status text not null default 'available' check (status in ('available','loaned','lost','repair','withdrawn')),
  created_at timestamptz not null default now()
);
create index if not exists book_copies_book_status_idx on public.book_copies(book_id,status);

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  copy_id uuid not null references public.book_copies(id) on delete restrict,
  borrower_id uuid not null references public.lms_users(id) on delete restrict,
  issued_by uuid not null references public.lms_users(id) on delete restrict,
  returned_by uuid references public.lms_users(id) on delete restrict,
  borrowed_at timestamptz not null default now(),
  due_at timestamptz not null,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  check (due_at > borrowed_at),
  check (returned_at is null or returned_at >= borrowed_at)
);
create unique index if not exists one_open_loan_per_copy on public.loans(copy_id) where returned_at is null;
create index if not exists loans_borrower_due_idx on public.loans(borrower_id,due_at) where returned_at is null;

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.lms_users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_created_idx on public.audit_events(created_at desc);

-- The Express service must use a server-only credential and enforce role and
-- borrower-ownership checks. Browser/mobile clients receive no table grants.
alter table public.lms_users enable row level security;
alter table public.books enable row level security;
alter table public.book_copies enable row level security;
alter table public.loans enable row level security;
alter table public.audit_events enable row level security;
revoke all on public.lms_users, public.books, public.book_copies, public.loans, public.audit_events from anon, authenticated;
grant all on public.lms_users, public.books, public.book_copies, public.loans, public.audit_events to service_role;

-- One statement builds a transaction-consistent backup snapshot.
create or replace function public.create_lms_snapshot()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'createdAt', now(),
    'users', coalesce((select jsonb_agg(to_jsonb(u) order by u.local_user_id) from lms_users u), '[]'::jsonb),
    'books', coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from books b), '[]'::jsonb),
    'copies', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from book_copies c), '[]'::jsonb),
    'loans', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from loans l), '[]'::jsonb),
    'auditEvents', coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from audit_events a), '[]'::jsonb)
  );
$$;
revoke all on function public.create_lms_snapshot() from public,anon,authenticated;
grant execute on function public.create_lms_snapshot() to service_role;

-- Lightweight readiness check; unlike the snapshot procedure it returns no user data.
create or replace function public.lms_schema_health()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'issue', to_regprocedure('public.issue_book_copy(uuid,uuid,uuid,timestamp with time zone)') is not null,
    'return', to_regprocedure('public.return_book_copy(uuid,uuid)') is not null,
    'snapshot', to_regprocedure('public.create_lms_snapshot()') is not null,
    'restore', to_regprocedure('public.restore_lms_snapshot(uuid,jsonb)') is not null
  );
$$;
revoke all on function public.lms_schema_health() from public,anon,authenticated;
grant execute on function public.lms_schema_health() to service_role;

-- Atomically issue a copy: row lock + availability check + loan insert + copy
-- state update. Call only from the trusted API after authorization.
create or replace function public.issue_book_copy(p_copy uuid,p_borrower uuid,p_actor uuid,p_due_at timestamptz)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_loan uuid;
  v_open_loans integer;
begin
  if p_due_at <= now() then raise exception 'Due date must be in the future'; end if;
  if p_due_at > now() + interval '30 days' then raise exception 'Due date cannot be more than 30 days away'; end if;
  perform 1 from lms_users where id=p_actor and role in ('administrator','librarian') and active and library_access for update;
  if not found then raise exception 'Staff account is inactive or unauthorized'; end if;
  perform 1 from lms_users where id=p_borrower and role='student' and active and library_access for update;
  if not found then raise exception 'Borrower is not an eligible student'; end if;
  select count(*) into v_open_loans from loans where borrower_id=p_borrower and returned_at is null;
  if v_open_loans >= 5 then raise exception 'Borrower has reached the five-loan limit'; end if;
  perform 1 from book_copies where id=p_copy and status='available' for update;
  if not found then raise exception 'Copy is not available'; end if;
  insert into loans(copy_id,borrower_id,issued_by,due_at) values(p_copy,p_borrower,p_actor,p_due_at) returning id into v_loan;
  update book_copies set status='loaned' where id=p_copy;
  insert into audit_events(actor_id,action,entity_type,entity_id) values(p_actor,'LOAN_ISSUED','loan',v_loan::text);
  return v_loan;
end $$;

create or replace function public.return_book_copy(p_loan uuid,p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_copy uuid;
begin
  update loans set returned_at=now(),returned_by=p_actor where id=p_loan and returned_at is null returning copy_id into v_copy;
  if not found then raise exception 'Open loan not found'; end if;
  update book_copies set status='available' where id=v_copy and status='loaned';
  insert into audit_events(actor_id,action,entity_type,entity_id) values(p_actor,'LOAN_RETURNED','loan',p_loan::text);
end $$;
revoke all on function public.issue_book_copy(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.return_book_copy(uuid,uuid) from public,anon,authenticated;
grant execute on function public.issue_book_copy(uuid,uuid,uuid,timestamptz) to service_role;
grant execute on function public.return_book_copy(uuid,uuid) to service_role;

create table if not exists public.backup_metadata (
  id uuid primary key default gen_random_uuid(),
  object_path text not null unique,
  created_by uuid references public.lms_users(id) on delete set null,
  byte_length bigint not null check (byte_length > 0),
  record_counts jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.backup_metadata enable row level security;
revoke all on public.backup_metadata from anon,authenticated;
grant all on public.backup_metadata to service_role;

-- Private encrypted backup objects; service_role is the only application access.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('lms-backups','lms-backups',false,52428800,array['application/octet-stream'])
on conflict (id) do update set public=false,file_size_limit=52428800;

create or replace function public.restore_lms_snapshot(p_actor uuid,p_snapshot jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if jsonb_typeof(p_snapshot) is distinct from 'object' or p_snapshot->>'schemaVersion' is distinct from '1' then
    raise exception 'Unsupported backup schema';
  end if;
  if jsonb_typeof(p_snapshot->'books') is distinct from 'array' or jsonb_typeof(p_snapshot->'copies') is distinct from 'array'
     or jsonb_typeof(p_snapshot->'loans') is distinct from 'array' or jsonb_typeof(p_snapshot->'users') is distinct from 'array'
     or jsonb_typeof(p_snapshot->'auditEvents') is distinct from 'array' then raise exception 'Invalid backup document'; end if;

  delete from loans;
  delete from book_copies;
  delete from books;
  delete from audit_events;
  insert into lms_users(id,local_user_id,email,username,display_name,role,active,library_access,created_at,updated_at)
    select id,local_user_id,email,username,display_name,role,active,library_access,created_at,updated_at
    from jsonb_to_recordset(p_snapshot->'users') as u(id uuid,local_user_id integer,email text,username text,display_name text,role text,active boolean,library_access boolean,created_at timestamptz,updated_at timestamptz)
    on conflict (id) do update set local_user_id=excluded.local_user_id,email=excluded.email,username=excluded.username,
      display_name=excluded.display_name,role=excluded.role,active=excluded.active,library_access=excluded.library_access,updated_at=excluded.updated_at;
  insert into books(id,isbn,title,author,category,publisher,publication_year,description,archived,created_at,updated_at)
    select id,isbn,title,author,category,publisher,publication_year,description,archived,created_at,updated_at
    from jsonb_to_recordset(p_snapshot->'books') as b(id uuid,isbn text,title text,author text,category text,publisher text,publication_year integer,description text,archived boolean,created_at timestamptz,updated_at timestamptz);
  insert into book_copies(id,book_id,barcode,status,created_at)
    select id,book_id,barcode,status,created_at from jsonb_to_recordset(p_snapshot->'copies') as c(id uuid,book_id uuid,barcode text,status text,created_at timestamptz);
  insert into loans(id,copy_id,borrower_id,issued_by,returned_by,borrowed_at,due_at,returned_at,created_at)
    select id,copy_id,borrower_id,issued_by,returned_by,borrowed_at,due_at,returned_at,created_at
    from jsonb_to_recordset(p_snapshot->'loans') as l(id uuid,copy_id uuid,borrower_id uuid,issued_by uuid,returned_by uuid,borrowed_at timestamptz,due_at timestamptz,returned_at timestamptz,created_at timestamptz);
  insert into audit_events(id,actor_id,action,entity_type,entity_id,details,created_at) overriding system value
    select id,actor_id,action,entity_type,entity_id,details,created_at
    from jsonb_to_recordset(p_snapshot->'auditEvents') as a(id bigint,actor_id uuid,action text,entity_type text,entity_id text,details jsonb,created_at timestamptz);
  insert into audit_events(actor_id,action,entity_type,details) values(p_actor,'BACKUP_RESTORED','backup','{"schemaVersion":1}');
  perform setval(pg_get_serial_sequence('public.audit_events','id'), coalesce((select max(id) from audit_events),1), exists(select 1 from audit_events));
end $$;
revoke all on function public.restore_lms_snapshot(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.restore_lms_snapshot(uuid,jsonb) to service_role;
