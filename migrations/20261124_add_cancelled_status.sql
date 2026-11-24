-- Add 'cancelled' status to existing public.tasks installations

alter table public.tasks
  drop constraint if exists tasks_status_check;

alter table public.tasks
  add constraint tasks_status_check check (
    status in ('queued', 'running', 'completed', 'failed', 'timeout', 'interrupted', 'cancelled')
  );

notify pgrst, 'reload schema';
