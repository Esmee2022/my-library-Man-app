-- Atomic security-sensitive updates used by AUTH_STORE=supabase.
create or replace function public.auth_record_failed_attempt(p_user_id bigint)
returns integer language plpgsql security definer set search_path=public as $$
declare attempts integer;
begin
  update auth_users
     set failed_login_attempts=failed_login_attempts+1, updated_at=now()
   where id=p_user_id
   returning failed_login_attempts into attempts;
  return attempts;
end $$;
revoke all on function public.auth_record_failed_attempt(bigint) from public,anon,authenticated;
grant execute on function public.auth_record_failed_attempt(bigint) to service_role;

-- A session login with a recovery code must consume exactly one matching code.
create or replace function public.auth_consume_recovery_code(p_user_id bigint,p_code_hash text)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update auth_recovery_codes set used=true,used_at=now()
   where user_id=p_user_id and code_hash=p_code_hash and used=false;
  return found;
end $$;
revoke all on function public.auth_consume_recovery_code(bigint,text) from public,anon,authenticated;
grant execute on function public.auth_consume_recovery_code(bigint,text) to service_role;

create or replace function public.auth_schema_health()
returns boolean language sql stable security definer set search_path=public as $$
  select to_regprocedure('public.auth_record_failed_attempt(bigint)') is not null
     and to_regprocedure('public.auth_consume_recovery_code(bigint,text)') is not null
$$;
revoke all on function public.auth_schema_health() from public,anon,authenticated;
grant execute on function public.auth_schema_health() to service_role;
