-- task-aside Supabase Postgres schema & RPC functions

create table if not exists public.tasks (
  id uuid primary key,
  parent_id uuid null references public.tasks(id) on delete set null,
  priority text not null check (priority in ('P0', 'P1', 'P2', 'P3')),
  agent text not null check (agent in ('agy', 'claude', 'codex')),
  status text not null default 'queued' check (
    status in ('queued', 'running', 'completed', 'failed', 'timeout', 'interrupted', 'cancelled')
  ),
  input_envelope jsonb not null,
  result_envelope jsonb null,
  worker_id text null,
  attempts integer not null default 0,
  lease_expires_at timestamptz null,
  trace_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null
);

create index if not exists idx_tasks_claim
  on public.tasks (agent, priority, created_at)
  where status = 'queued';

create index if not exists idx_tasks_running_lease
  on public.tasks (lease_expires_at)
  where status = 'running';

create index if not exists idx_tasks_parent_id
  on public.tasks (parent_id)
  where parent_id is not null;

create index if not exists idx_tasks_status_created
  on public.tasks (status, created_at desc);

create or replace function public.claim_next_task(
  p_allowed_agents text[],
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns setof public.tasks
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_now_iso text := to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_lease_secs integer := greatest(coalesce(p_lease_seconds, 120), 10);
  v_claimed_id uuid;
begin
  -- Expire stale running tasks whose worker lease has elapsed
  update public.tasks as stale
  set
    status = 'interrupted',
    finished_at = v_now,
    updated_at = v_now,
    lease_expires_at = null,
    result_envelope = coalesce(
      stale.result_envelope,
      jsonb_build_object(
        'schema', jsonb_build_object('version', 'v1', 'type', 'task_result'),
        'metadata', jsonb_build_object(
          'created_at', v_now_iso,
          'updated_at', v_now_iso,
          'trace_id', stale.trace_id,
          'span_id', null,
          'parent_span_id', stale.input_envelope #>> '{metadata,span_id}'
        ),
        'data', jsonb_build_object(
          'id', stale.id,
          'task_id', stale.id,
          'parent_id', stale.parent_id,
          'status', 'interrupted',
          'execution', jsonb_build_object(
            'agent', stale.agent,
            'worker_id', stale.worker_id,
            'requested_model', stale.input_envelope #>> '{data,execution,model}',
            'effective_model', null,
            'effort', stale.input_envelope #>> '{data,execution,effort}',
            'cwd', stale.input_envelope #>> '{data,execution,cwd}',
            'permission_mode', stale.input_envelope #>> '{data,execution,permission_mode}',
            'enforcement', null,
            'session_id', stale.input_envelope #>> '{data,execution,session_id}',
            'exit_code', null,
            'started_at', case
              when stale.started_at is not null
              then to_char(stale.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              else null
            end,
            'finished_at', v_now_iso,
            'duration_ms', case
              when stale.started_at is not null
              then greatest(0, floor(extract(epoch from (v_now - stale.started_at)) * 1000)::bigint)
              else null
            end
          ),
          'output', jsonb_build_object('format', 'markdown', 'text', null),
          'usage', jsonb_build_object('input_tokens', null, 'output_tokens', null, 'total_cost_usd', null),
          'artifacts', null,
          'error', jsonb_build_object(
            'code', 'LEASE_EXPIRED',
            'category', 'infrastructure',
            'message', 'Worker lease expired before completion'
          )
        )
      )
    )
  where stale.status = 'running'
    and stale.lease_expires_at is not null
    and stale.lease_expires_at < v_now;

  if p_allowed_agents is null or cardinality(p_allowed_agents) = 0 then
    return;
  end if;

  select t.id
  into v_claimed_id
  from public.tasks as t
  where t.status = 'queued'
    and t.agent = any(p_allowed_agents)
  order by t.priority asc, t.created_at asc
  for update skip locked
  limit 1;

  if v_claimed_id is null then
    return;
  end if;

  return query
  update public.tasks as target
  set
    status = 'running',
    worker_id = p_worker_id,
    attempts = target.attempts + 1,
    started_at = coalesce(target.started_at, v_now),
    updated_at = v_now,
    lease_expires_at = v_now + make_interval(secs => v_lease_secs)
  where target.id = v_claimed_id
  returning target.*;
end;
$$;

create or replace function public.extend_task_lease(
  p_task_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_lease_secs integer := greatest(coalesce(p_lease_seconds, 120), 10);
begin
  update public.tasks
  set
    lease_expires_at = v_now + make_interval(secs => v_lease_secs),
    updated_at = v_now
  where id = p_task_id
    and status = 'running'
    and worker_id = p_worker_id;

  return found;
end;
$$;

alter table public.tasks disable row level security;
grant select, insert, update, delete on public.tasks to anon, authenticated;
grant execute on function public.claim_next_task(text[], text, integer) to anon, authenticated;
grant execute on function public.extend_task_lease(uuid, text, integer) to anon, authenticated;

notify pgrst, 'reload schema';
