import {
  assertNonEmptyString,
  assertNullableUuidV7,
  assertOptionalAgentName,
  assertOptionalTaskStatus,
  assertPaginationInt,
  assertPlainObject,
  assertString,
  assertTaskExecution,
  assertTaskPriority,
  assertUuidV7,
} from "#src/utilities/validation.js";

/**
 * Transport-agnostic task handler shared by HTTP, MCP, and Worker transports.
 */
export function createTaskHandler({ taskUsecase }) {
  async function createTask(input, context = {}) {
    const args = assertPlainObject(input, "Task input must be an object");
    const title = assertNonEmptyString(args.title, "title");
    const description = assertString(args.description, "description");
    const parent_id = assertNullableUuidV7(args.parent_id, "parent_id");
    const priority = assertTaskPriority(args.priority, "priority");
    const execution = assertTaskExecution(args.execution, "execution");
    const traceparent = typeof context?.traceparent === "string" ? context.traceparent : null;

    return taskUsecase.createTask({
      title,
      description,
      parent_id,
      priority,
      execution,
      traceparent,
    });
  }

  async function getTask(input) {
    const args = assertPlainObject(input, "Task lookup input must be an object");
    const id = assertUuidV7(args.id, "id");
    return taskUsecase.getTask(id);
  }

  async function listTasks(input = {}) {
    const args = assertPlainObject(input, "List tasks input must be an object");
    const status = assertOptionalTaskStatus(args.status, "status");
    const agent = assertOptionalAgentName(args.agent, "agent");
    const parent_id =
      args.parent_id === undefined
        ? undefined
        : assertNullableUuidV7(args.parent_id, "parent_id");
    const limit = assertPaginationInt(args.limit, "limit", {
      min: 1,
      max: 200,
      defaultValue: 50,
    });
    const offset = assertPaginationInt(args.offset, "offset", {
      min: 0,
      max: 100_000,
      defaultValue: 0,
    });

    return taskUsecase.listTasks({
      status,
      agent,
      parent_id,
      limit,
      offset,
    });
  }

  async function processNextTask({ signal } = {}) {
    return taskUsecase.processNextTask({ signal });
  }

  async function cancelTask(input) {
    const args = assertPlainObject(input, "Task cancel input must be an object");
    const id = assertUuidV7(args.id, "id");
    return taskUsecase.cancelTask(id);
  }

  async function retryTask(input, context = {}) {
    const args = assertPlainObject(input, "Task retry input must be an object");
    const id = assertUuidV7(args.id, "id");
    const traceparent = typeof context?.traceparent === "string" ? context.traceparent : null;
    return taskUsecase.retryTask(id, { traceparent });
  }

  function subscribe(listener) {
    return taskUsecase.subscribe(listener);
  }

  return {
    createTask,
    getTask,
    listTasks,
    cancelTask,
    retryTask,
    processNextTask,
    subscribe,
  };
}
