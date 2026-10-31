/** A stand-in for a Node function the worker can't run: calling it throws and says which. */
export const unavailable =
  (module: string) =>
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`${module} unavailable in worker: ${name}`);
  };
