-- Allow signed-in students to check out an available physical copy or eBook
-- license to themselves. The API still supplies only server-validated IDs;
-- this security-definer routine performs the final checks and copy lock.
create or replace function public.issue_book_copy(
  p_copy uuid,
  p_borrower uuid,
  p_actor uuid,
  p_due_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan uuid;
  v_open_loans integer;
begin
  if p_due_at <= now() then raise exception 'Due date must be in the future'; end if;
  if p_due_at > now() + interval '30 days' then raise exception 'Due date cannot be more than 30 days away'; end if;

  perform 1
  from public.lms_users
  where id = p_actor
    and active
    and library_access
    and (
      role in ('administrator','librarian')
      or (role = 'student' and p_actor = p_borrower and p_due_at <= now() + interval '14 days')
    )
  for update;
  if not found then raise exception 'Actor is inactive or unauthorized'; end if;

  perform 1 from public.lms_users
  where id = p_borrower and role = 'student' and active and library_access
  for update;
  if not found then raise exception 'Borrower is not an eligible student'; end if;

  select count(*) into v_open_loans
  from public.loans where borrower_id = p_borrower and returned_at is null;
  if v_open_loans >= 5 then raise exception 'Borrower has reached the five-loan limit'; end if;

  perform 1
  from public.book_copies c
  join public.books b on b.id = c.book_id
  where c.id = p_copy and c.status = 'available' and b.archived = false
  for update of c;
  if not found then raise exception 'Copy is not available or its title is archived'; end if;

  insert into public.loans(copy_id,borrower_id,issued_by,due_at)
  values (p_copy,p_borrower,p_actor,p_due_at)
  returning id into v_loan;
  update public.book_copies set status = 'loaned' where id = p_copy;
  insert into public.audit_events(actor_id,action,entity_type,entity_id)
  values (p_actor,'LOAN_ISSUED','loan',v_loan::text);
  return v_loan;
end;
$$;

revoke all on function public.issue_book_copy(uuid,uuid,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.issue_book_copy(uuid,uuid,uuid,timestamptz) to service_role;

-- Feature readiness is exposed through the existing health RPC so the API
-- reports an incomplete LMS schema until this migration has been applied.
create or replace function public.lms_student_self_checkout_ready()
returns boolean
language sql
security definer
set search_path = public
as $$ select true $$;

revoke all on function public.lms_student_self_checkout_ready() from public, anon, authenticated;
grant execute on function public.lms_student_self_checkout_ready() to service_role;

create or replace function public.lms_schema_health()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'issue', to_regprocedure('public.issue_book_copy(uuid,uuid,uuid,timestamp with time zone)') is not null,
    'return', to_regprocedure('public.return_book_copy(uuid,uuid)') is not null,
    'snapshot', to_regprocedure('public.create_lms_snapshot()') is not null,
    'restore', to_regprocedure('public.restore_lms_snapshot(uuid,jsonb)') is not null,
    'studentSelfCheckout', public.lms_student_self_checkout_ready()
  );
$$;

revoke all on function public.lms_schema_health() from public, anon, authenticated;
grant execute on function public.lms_schema_health() to service_role;
