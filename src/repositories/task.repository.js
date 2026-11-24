function cloneTask(task) {
  return task ? structuredClone(task) : null;
}

function resolveTaskId(task) {
  return task?.data?.id ?? task?.id;
}

/**
 * In-memory task repository.
 * Data boundary intended to be swapped with SQLite SQL / SQLite KV adapters.
 */
export function createTaskRepository() {
  const tasks = new Map();

  async function create(task) {
    const record = cloneTask(task);
    tasks.set(resolveTaskId(record), record);
    return cloneTask(record);
  }

  async function findById(id) {
    return cloneTask(tasks.get(id) ?? null);
  }

  async function findAll() {
    return Array.from(tasks.values(), cloneTask);
  }

  async function update(id, patch) {
    const existing = tasks.get(id);
    if (!existing) {
      return null;
    }
    const updated = { ...existing, ...patch };
    tasks.set(id, updated);
    return cloneTask(updated);
  }

  async function count() {
    return tasks.size;
  }

  return {
    create,
    findById,
    findAll,
    update,
    count,
  };
}
