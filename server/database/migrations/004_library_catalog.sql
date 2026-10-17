-- Expand the catalogue into a mixed physical and licensed-eBook collection.
-- Safe to run more than once. Seeded eBook links point to public-domain works.

create table if not exists public.book_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.books
  add column if not exists category_id uuid references public.book_categories(id) on delete set null;

alter table public.book_copies
  add column if not exists format text not null default 'physical',
  add column if not exists digital_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'book_copies_format_check' and conrelid = 'public.book_copies'::regclass) then
    alter table public.book_copies add constraint book_copies_format_check check (format in ('physical','ebook'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ebook_copies_need_url_check' and conrelid = 'public.book_copies'::regclass) then
    alter table public.book_copies add constraint ebook_copies_need_url_check check (format <> 'ebook' or nullif(trim(digital_url),'') is not null);
  end if;
end $$;

create index if not exists books_category_id_idx on public.books(category_id);
create index if not exists book_copies_format_status_idx on public.book_copies(format,status);

alter table public.book_categories enable row level security;
revoke all on public.book_categories from anon,authenticated;
grant all on public.book_categories to service_role;

insert into public.book_categories(name,description,sort_order) values
  ('Fiction','Novels, short stories, and literary fiction.',10),
  ('Mystery & Detective','Mysteries, crime fiction, and detective stories.',20),
  ('Fantasy','Mythic worlds, magic, and imaginative fiction.',30),
  ('Science Fiction','Speculative fiction, space, and future societies.',40),
  ('Adventure','Journeys, exploration, and high-stakes action.',45),
  ('Romance','Love stories and relationship-centered fiction.',50),
  ('History','World, regional, and social history.',60),
  ('Biography & Memoir','Life stories, memoirs, and autobiographies.',70),
  ('Science & Nature','Natural sciences, ecology, and the environment.',80),
  ('Technology & Computing','Computing, software, engineering, and digital life.',90),
  ('Business & Economics','Management, entrepreneurship, and economics.',100),
  ('Health & Wellness','Health, psychology, and personal wellbeing.',110),
  ('Children & Young Adult','Picture books, middle grade, and young adult titles.',120),
  ('Poetry & Drama','Poetry, plays, and dramatic literature.',130),
  ('Reference & Research','Dictionaries, handbooks, and research resources.',140)
on conflict (name) do update set description=excluded.description,sort_order=excluded.sort_order;

-- Preserve any existing free-text categories when attaching books to the new lookup.
insert into public.book_categories(name,description,sort_order)
select distinct trim(b.category),'Existing library category',900
from public.books b
where nullif(trim(b.category),'') is not null
on conflict (name) do nothing;

update public.books b
set category_id=c.id
from public.book_categories c
where lower(trim(b.category))=lower(c.name) and b.category_id is distinct from c.id;

-- Demo collection: each title has physical shelf copies; selected public-domain titles
-- also have separately tracked concurrent eBook licenses.
do $$
declare
  item record;
  book_uuid uuid;
  category_uuid uuid;
  copy_no integer;
  barcode_key text;
begin
  for item in
    select * from (values
      ('pride-prejudice','Pride and Prejudice','Jane Austen','Romance','Penguin Classics',1813,'Austen’s classic novel of family, first impressions, and changing affection.',2,2,'https://www.gutenberg.org/ebooks/1342'),
      ('frankenstein','Frankenstein; or, The Modern Prometheus','Mary Shelley','Science Fiction','Penguin Classics',1818,'A Gothic novel about scientific ambition, responsibility, and belonging.',2,2,'https://www.gutenberg.org/ebooks/84'),
      ('sherlock-holmes','The Adventures of Sherlock Holmes','Arthur Conan Doyle','Mystery & Detective','Wordsworth Editions',1892,'Twelve celebrated cases featuring Sherlock Holmes and Dr. Watson.',2,2,'https://www.gutenberg.org/ebooks/1661'),
      ('alice-wonderland','Alice’s Adventures in Wonderland','Lewis Carroll','Children & Young Adult','Macmillan',1865,'A curious child follows a white rabbit into a world of wordplay and wonder.',3,2,'https://www.gutenberg.org/ebooks/11'),
      ('moby-dick','Moby-Dick; or, The Whale','Herman Melville','Fiction','Harper & Brothers',1851,'A whaling voyage becomes an epic meditation on obsession and the sea.',2,1,'https://www.gutenberg.org/ebooks/2701'),
      ('jane-eyre','Jane Eyre','Charlotte Brontë','Romance','Smith, Elder & Co.',1847,'A governess seeks independence, dignity, and love on her own terms.',2,1,'https://www.gutenberg.org/ebooks/1260'),
      ('little-women','Little Women','Louisa May Alcott','Children & Young Adult','Roberts Brothers',1868,'The March sisters grow up, pursue their ambitions, and support one another.',3,1,'https://www.gutenberg.org/ebooks/37106'),
      ('dracula','Dracula','Bram Stoker','Fantasy','Archibald Constable and Company',1897,'A journal-based Gothic tale of a vampire’s arrival in Victorian England.',2,2,'https://www.gutenberg.org/ebooks/345'),
      ('time-machine','The Time Machine','H. G. Wells','Science Fiction','William Heinemann',1895,'A Victorian inventor journeys far into humanity’s possible future.',2,1,'https://www.gutenberg.org/ebooks/35'),
      ('war-worlds','The War of the Worlds','H. G. Wells','Science Fiction','William Heinemann',1898,'An early science-fiction classic about a Martian invasion of Earth.',2,1,'https://www.gutenberg.org/ebooks/36'),
      ('tom-sawyer','The Adventures of Tom Sawyer','Mark Twain','Children & Young Adult','American Publishing Company',1876,'Tom Sawyer’s mischievous adventures along the Mississippi River.',2,1,'https://www.gutenberg.org/ebooks/74'),
      ('two-cities','A Tale of Two Cities','Charles Dickens','History','Chapman & Hall',1859,'A story of sacrifice and renewal set during the French Revolution.',2,1,'https://www.gutenberg.org/ebooks/98'),
      ('wuthering-heights','Wuthering Heights','Emily Brontë','Fiction','Thomas Cautley Newby',1847,'A passionate, multigenerational story set on the Yorkshire moors.',2,1,'https://www.gutenberg.org/ebooks/768'),
      ('dorian-gray','The Picture of Dorian Gray','Oscar Wilde','Fiction','Lippincott’s Monthly Magazine',1890,'A novel about beauty, influence, and the cost of a life without restraint.',2,1,'https://www.gutenberg.org/ebooks/174'),
      ('secret-garden','The Secret Garden','Frances Hodgson Burnett','Children & Young Adult','Frederick A. Stokes',1911,'A lonely child discovers a hidden garden and the power of friendship.',3,1,'https://www.gutenberg.org/ebooks/113'),
      ('wizard-oz','The Wonderful Wizard of Oz','L. Frank Baum','Fantasy','George M. Hill Company',1900,'Dorothy and her companions travel through the Land of Oz.',3,1,'https://www.gutenberg.org/ebooks/55'),
      ('around-world','Around the World in Eighty Days','Jules Verne','Adventure','Pierre-Jules Hetzel',1873,'Phileas Fogg races around the world in a wager against time.',2,1,'https://www.gutenberg.org/ebooks/103'),
      ('count-monte-cristo','The Count of Monte Cristo','Alexandre Dumas','Adventure','Pétion',1844,'A sweeping tale of wrongful imprisonment, escape, and revenge.',2,1,'https://www.gutenberg.org/ebooks/1184'),
      ('republic','The Republic','Plato','Reference & Research','Ancient Greek work',380,'A foundational philosophical dialogue about justice and political life (composed c. 380 BCE).',2,1,'https://www.gutenberg.org/ebooks/1497'),
      ('art-of-war','The Art of War','Sun Tzu','History','Ancient Chinese work',500,'A concise classic on strategy, leadership, and conflict (composed c. 500 BCE).',2,1,'https://www.gutenberg.org/ebooks/132'),
      ('the-hobbit','The Hobbit','J. R. R. Tolkien','Fantasy','George Allen & Unwin',1937,'Bilbo Baggins leaves home on an unexpected journey with a company of dwarves.',3,0,null),
      ('nineteen-eighty-four','Nineteen Eighty-Four','George Orwell','Science Fiction','Secker & Warburg',1949,'A dystopian novel about surveillance, language, and individual freedom.',3,0,null),
      ('mockingbird','To Kill a Mockingbird','Harper Lee','Fiction','J. B. Lippincott & Co.',1960,'A child’s perspective on conscience and justice in the American South.',3,0,null),
      ('sapiens','Sapiens: A Brief History of Humankind','Yuval Noah Harari','History','Harvill Secker',2011,'A broad account of human history, culture, and cooperation.',2,0,null),
      ('brief-history-time','A Brief History of Time','Stephen Hawking','Science & Nature','Bantam Books',1988,'An accessible introduction to cosmology and the nature of time.',2,0,null),
      ('clean-code','Clean Code','Robert C. Martin','Technology & Computing','Prentice Hall',2008,'Practical guidance for writing readable, maintainable software.',2,0,null),
      ('atomic-habits','Atomic Habits','James Clear','Health & Wellness','Avery',2018,'A practical guide to building habits through small, repeatable changes.',2,0,null),
      ('educated','Educated','Tara Westover','Biography & Memoir','Random House',2018,'A memoir about family, education, and making a life beyond one’s beginnings.',2,0,null),
      ('very-hungry-caterpillar','The Very Hungry Caterpillar','Eric Carle','Children & Young Adult','World Publishing Company',1969,'A brightly illustrated picture book following a caterpillar’s week of eating.',3,0,null),
      ('little-prince','The Little Prince','Antoine de Saint-Exupéry','Children & Young Adult','Reynal & Hitchcock',1943,'A pilot meets a young traveler who asks lasting questions about friendship.',2,0,null)
    ) as catalog(code,title,author,category,publisher,publication_year,description,physical_copies,ebook_licenses,ebook_url)
  loop
    select id into category_uuid from public.book_categories where name=item.category;
    select id into book_uuid from public.books where lower(title)=lower(item.title) and lower(author)=lower(item.author) limit 1;
    if book_uuid is null then
      insert into public.books(title,author,category,category_id,publisher,publication_year,description)
      values(item.title,item.author,item.category,category_uuid,item.publisher,item.publication_year,item.description)
      returning id into book_uuid;
    else
      update public.books set category_id=category_uuid where id=book_uuid and category_id is null;
    end if;

    for copy_no in 1..item.physical_copies loop
      barcode_key := 'CAT-' || upper(item.code) || '-P' || lpad(copy_no::text,3,'0');
      insert into public.book_copies(book_id,barcode,format)
      values(book_uuid,barcode_key,'physical') on conflict(barcode) do nothing;
    end loop;
    for copy_no in 1..item.ebook_licenses loop
      barcode_key := 'CAT-' || upper(item.code) || '-E' || lpad(copy_no::text,3,'0');
      insert into public.book_copies(book_id,barcode,format,digital_url)
      values(book_uuid,barcode_key,'ebook',item.ebook_url) on conflict(barcode) do nothing;
    end loop;
  end loop;
end $$;

-- Include the new copy metadata in future encrypted backups, while still restoring older snapshots.
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
  insert into books(id,isbn,title,author,category,category_id,publisher,publication_year,description,archived,created_at,updated_at)
    select id,isbn,title,author,category,category_id,publisher,publication_year,description,archived,created_at,updated_at
    from jsonb_to_recordset(p_snapshot->'books') as b(id uuid,isbn text,title text,author text,category text,category_id uuid,publisher text,publication_year integer,description text,archived boolean,created_at timestamptz,updated_at timestamptz);
  insert into book_copies(id,book_id,barcode,status,format,digital_url,created_at)
    select id,book_id,barcode,status,coalesce(format,'physical'),digital_url,created_at
    from jsonb_to_recordset(p_snapshot->'copies') as c(id uuid,book_id uuid,barcode text,status text,format text,digital_url text,created_at timestamptz);
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
