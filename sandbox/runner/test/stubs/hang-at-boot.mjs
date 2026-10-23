// Never reaches extraction: a worker that fails to start up.
import { setInterval } from "node:timers";
setInterval(() => {}, 1000);
