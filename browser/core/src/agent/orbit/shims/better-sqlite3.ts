/** better-sqlite3 in the Orbit worker: the session index needs files, which the worker has none of. */
import { unavailable } from "./unavailable";

export default unavailable("better-sqlite3")("Database");
