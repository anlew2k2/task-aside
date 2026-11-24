# Sequence: Worker Execution & Notifications

Covers the sequential background loop from claiming a queued task in Supabase through headless CLI execution, lifecycle event emission, and Telegram notifications.

## Claim, Heartbeat & Execution Flow

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker Transport
  participant U as Task Usecase
  participant DB as "Supabase RPC & Table"
  participant A as Agent Service
  participant CLI as "Headless CLI (agy/claude/codex)"
  participant TG as "Telegram Transport (optional)"

  W->>U: processNextTask(signal)
  U->>DB: RPC claim_next_task(allowed_agents, worker_id, lease_seconds)
  alt Queue empty for allowed_agents
    DB-->>U: null
    U-->>W: processed = false (sleep until next poll)
  else Task claimed (status = running, attempts + 1)
    DB-->>U: Claimed task row
    U-->>TG: Emit task.started (silent edit or silent card)
    par Lease Heartbeat
      loop Every heartbeat_interval_ms
        U->>DB: RPC extend_task_lease(task_id, worker_id, lease_seconds)
        opt Lease returns false (remote cancel/expiry)
          U->>CLI: Abort child process
        end
      end
    and Headless Execution
      U->>A: executeTask(input_envelope, signal)
      A->>A: Enforce allowed_agents, max_permission_mode, allowed_workspaces
      A->>CLI: Spawn non-interactive process & stream artifacts to runs/
      CLI-->>A: Exit code + native JSON/JSONL output
      A-->>U: status + v1 task_result envelope
    end
    U->>DB: Conditional update (where status = running)
    U-->>TG: Emit task.finished (silent card edit + fresh push notification)
  end
```

## Execution & Notification Rules

| Aspect | Behavior |
| --- | --- |
| **Scheduling order** | `claim_next_task` uses `FOR UPDATE SKIP LOCKED`, filtering by `allowed_agents` and ordering by `priority` (`P0` first) then `created_at` |
| **Policy gates** | Pre-spawn checks reject disallowed agents, `permission_mode` above `max_permission_mode`, missing `cwd`, or `cwd` outside `allowed_workspaces` |
| **Remote cancellation** | `finishTask` guards `status = running`, and heartbeat loss aborts the running child so `cancelled` is never overwritten with `interrupted` |
| **Telegram delivery** | Short Markdown renders inline; outputs above ~3200 chars send an excerpt plus an attached `.md` document containing the task UUID |
