import { inert } from "./inert";

const chokidar = inert("chokidar");
export default chokidar;
// Its own proxy, so the export itself is not counted as a touch of the default.
export const watch = inert("chokidar.watch");
