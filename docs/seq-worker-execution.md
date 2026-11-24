# Sequence: Worker Execution & Notifications

Covers adaptive polling, atomic task claiming in Supabase, attempt-fenced lease heartbeats, opt-in git worktree isolation, secret-redacted CLI runs, and completion updates.

## 1. Adaptive Poll & Claim

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker Transport
  participant U as Task Usecase
  participant DB as "Supabase RPC & Table"

  opt Local task.created event while idle
    U-->>W: Wake immediately & reset backoff
  end
  W->>U: processNextTask(signal)
  U->>DB: RPC claim_next_task(allowed_agents, worker_id, lease)
  alt Queue empty
    DB-->>W: processed = false (adaptive backoff + jitter sleep)
  else Task claimed (status = running, attempts + 1)
    DB-->>U: Claimed row (emits task.started & starts execution + heartbeat)
  end
```

## 2. Agent Execution & Completion

```mermaid
sequenceDiagram
  autonumber
  participant U as Task Usecase
  participant A as Agent Service
  participant CLI as "Headless CLI (agy / claude / codex)"
  participant DB as "Supabase Table"

  U->>A: executeTask(input_envelope, attempt, signal)
  A->>A: Enforce agent, permission & workspace gates + optional worktree
  A->>CLI: Spawn non-interactive process & redact streamed logs
  CLI-->>A: Exit code + native JSON/JSONL output
  A->>A: Smart worktree cleanup & write redacted result.json
  A-->>U: status + v1 task_result envelope
  U->>DB: Conditional update (status = running & matching attempts)
  U-->>U: Emit task.finished
```

## 3. Fenced Lease Heartbeat (Parallel to Execution)

```mermaid
sequenceDiagram
  autonumber
  participant U as Task Usecase
  participant DB as "Supabase RPC"
  participant CLI as "Headless CLI"

  loop Every heartbeat_interval_ms
    U->>DB: RPC extend_task_lease(..., p_attempt)
    opt Returns false (cancelled, expired, or stale attempt)
      U->>CLI: Abort child process
    end
  end
```

## Execution & Notification Rules

| Aspect | Behavior |
| --- | --- |
| **Adaptive polling** | Idle intervals step from `poll_interval_ms` to `poll_max_interval_ms` (`±15%` jitter); task completion or `task.created` resets immediately |
| **Scheduling & fencing** | `claim_next_task` uses `FOR UPDATE SKIP LOCKED` by `priority` then `created_at`; `extend_task_lease` and `finishTask` fence on `attempts` |
| **Policy & worktree gates** | Rejects disallowed agents, permission ceiling breaches, or `cwd` outside `allowed_workspaces`; opt-in `worktree` isolates runs in `runs/<id>/worktree` |
| **Secret redaction** | `redactSecrets` scrubs credentials and API/Bearer/bot-token patterns from daemon logs, `agent.log`, raw outputs, errors, and `result_envelope` |
| **Notifications** | `task.started` and `task.finished` drive Telegram card updates and result delivery (see [seq-telegram.md](./seq-telegram.md)) |
