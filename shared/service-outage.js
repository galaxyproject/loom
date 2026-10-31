/**
 * A Galaxy call that failed because the service behind it is down -- the Galaxy server, or the
 * sign-in service a hosted session gets its Galaxy token from -- rather than because of anything
 * the call asked for.
 *
 * A hosted transport raises it; nothing on the desktop does. The model is told to stop and wait
 * instead of investigating, since no retry or narrowed request can help until the service is back.
 */

export class ServiceOutageError extends Error {
  // (message, options) because galaxy-api's withTransportCode rebuilds errors through
  // `err.constructor` with exactly those arguments.
  constructor(message, options) {
    super(message, options);
    this.name = "ServiceOutageError";
  }
}

/** The ServiceOutageError behind `error`, down its cause chain, or undefined. */
export function serviceOutageIn(error) {
  for (let e = error, depth = 0; e !== undefined && e !== null && depth < 16; depth++) {
    // A bundled worker and its host can hold two copies of the class; the name is the contract.
    if (e instanceof Error && e.name === "ServiceOutageError") return e;
    e = e.cause;
  }
  return undefined;
}
