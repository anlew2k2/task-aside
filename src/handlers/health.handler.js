/**
 * Transport-agnostic health handler.
 */
export function createHealthHandler({ taskUsecase, appInfo }) {
  async function getHealth({ worker } = {}) {
    const stats = await taskUsecase.getStats();
    return {
      ok: true,
      name: appInfo.name,
      version: appInfo.version,
      worker: {
        ...(worker ?? {}),
        ...stats,
      },
    };
  }

  return {
    getHealth,
  };
}
