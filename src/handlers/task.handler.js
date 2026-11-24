import { assertNonEmptyString, assertPlainObject } from "../utilities/validation.js";

/**
 * Transport-agnostic task handler shared by HTTP, MCP, and Worker transports.
 */
export function createTaskHandler({ taskUsecase }) {
  async function enqueueTask(input) {
    const args = assertPlainObject(input, "Tool arguments must be an object");
    const name = assertNonEmptyString(args.name, "name");

    if (args.payload !== undefined && args.payload !== null) {
      assertPlainObject(args.payload, 'Argument "payload" must be an object');
    }

    return taskUsecase.enqueueTask({
      name,
      payload: args.payload ?? null,
    });
  }

  async function getTask(input) {
    const args = assertPlainObject(input, "Tool arguments must be an object");
    const id = assertNonEmptyString(args.id, "id");
    return taskUsecase.getTask(id);
  }

  async function listTasks({ worker } = {}) {
    const { tasks, stats } = await taskUsecase.listTasks();
    return {
      worker: {
        ...(worker ?? {}),
        ...stats,
      },
      tasks,
    };
  }

  async function processNextTask({ signal } = {}) {
    return taskUsecase.processNextTask({ signal });
  }

  return {
    enqueueTask,
    getTask,
    listTasks,
    processNextTask,
  };
}
