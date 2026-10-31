export class ServiceOutageError extends Error {
  constructor(message: string, options?: ErrorOptions);
}
export function serviceOutageIn(error: unknown): ServiceOutageError | undefined;
