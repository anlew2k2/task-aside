import {
  assertNonEmptyString,
  assertNullableUuidV7,
  assertPlainObject,
  assertString,
  assertTaskPriority,
} from "../utilities/validation.js";

/**
 * Transport-agnostic task handler shared by HTTP, MCP, and Worker transports.
 */
export function createTaskHandler({ taskUsecase }) {
  async function createTask(input) {
    const args = assertPlainObject(input, "Task input must be an object");
    const title = assertNonEmptyString(args.title, "title");
    const description = assertString(args.description, "description");
    const parent_id = assertNullableUuidV7(args.parent_id, "parent_id");
    const priority = assertTaskPriority(args.priority, "priority");

    return taskUsecase.createTask({
      title,
      description,
      parent_id,
      priority,
    });
  }

  async function processNextTask({ signal } = {}) {
    return taskUsecase.processNextTask({ signal });
  }

  return {
    createTask,
    processNextTask,
  };
}
