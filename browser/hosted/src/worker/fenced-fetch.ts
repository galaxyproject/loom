/**
 * The worker's global fetch, behind its lease fence. Galaxy calls go through the Galaxy transport,
 * but the model, the observations and feedback POSTs, GTN, IWC and skills fetches all use the global
 * fetch, so a worker whose lease was taken must be stopped here as well: once the fence has tripped
 * nothing goes out, and every write re-reads the generation first.
 */
import type { LeaseFence } from "../lease/lease-fence";

export function fencedFetch(fence: LeaseFence, inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    // The fence only needs the method to decide; the request itself goes out untouched.
    return fence.fetch(() => inner(input, init))(url, { method });
  };
}
