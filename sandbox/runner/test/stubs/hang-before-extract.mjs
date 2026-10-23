import { setInterval } from "node:timers";
// Never yields a result and never reports extraction: a stuck decoder.
setInterval(() => {}, 1000);
