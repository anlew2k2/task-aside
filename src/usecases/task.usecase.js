import { randomUUID } from "node:crypto";
import { NotFoundError } from "../utilities/errors.js";

async function defaultExecuteTask(task, _signal) {
  return {
    message: "Processed by background worker",
    name: task.name,
    payload: task.payload ?? null,
  };
}

/**
 * Task business logic usecase.
 * Orchestrates task persistence (repository) and queue dispatch (service).
 */
export function createTaskUsecase({
  taskRepository,
  queueService,
  executeTask = defaultExecuteTask,
}) {
  async function enqueueTask({ name, payload = null }) {
    const task = await taskRepository.create({
      id: randomUUID(),
      name,
      payload,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });

    await queueService.enqueue({
      taskId: task.id,
      name: task.name,
      payload: task.payload,
    });

    return task;
  }

  async function getTask(id) {
    const task = await taskRepository.findById(id);
    if (!task) {
      throw new NotFoundError(`Task not found: ${id}`);
    }
    return task;
  }

  async function listTasks() {
    const [tasks, queueStats] = await Promise.all([
      taskRepository.findAll(),
      queueService.stats(),
    ]);

    return {
      tasks,
      stats: {
        queuedCount: queueStats.queuedCount,
        totalCount: tasks.length,
      },
    };
  }

  async function getStats() {
    const [totalCount, queueStats] = await Promise.all([
      taskRepository.count(),
      queueService.stats(),
    ]);

    return {
      queuedCount: queueStats.queuedCount,
      totalCount,
    };
  }

  async function processNextTask({ signal } = {}) {
    const message = await queueService.dequeue();
    if (!message) {
      return { processed: false, task: null };
    }

    const existing = await taskRepository.findById(message.taskId);
    if (!existing) {
      await queueService.ack(message);
      return { processed: false, task: null };
    }

    const runningTask = await taskRepository.update(existing.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    try {
      const result = await executeTask(runningTask, signal);
      const completedTask = await taskRepository.update(existing.id, {
        status: "completed",
        result: result ?? null,
        finishedAt: new Date().toISOString(),
      });
      await queueService.ack(message);
      return { processed: true, task: completedTask };
    } catch (error) {
      const failedTask = await taskRepository.update(existing.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
      await queueService.nack(message, error);
      return { processed: true, task: failedTask };
    }
  }

  return {
    enqueueTask,
    getTask,
    listTasks,
    getStats,
    processNextTask,
  };
}
