import { LAUNCH_FLAG, launchMirrorCurrent, mirrorLaunch } from "@packserver/core/flags";
import type { AdminRuntime } from "../bindings";
import { opsPorts } from "../ops/context";

/** Brings the judge's copy of `launch.flag` back in line with the flag, so a missed write or a restored key is repaired within the hour. */
export async function flagMirror(runtime: AdminRuntime): Promise<void> {
  const ops = opsPorts(runtime);
  const flags = await ops.flags.read(ops);
  if (flags.readAt === null) throw new Error("the feature flags could not be read");
  const on = flags.get(LAUNCH_FLAG) === true;
  if (await launchMirrorCurrent(ops.kv, on)) return;
  await mirrorLaunch(ops.kv, on);
  console.log(JSON.stringify({ event: "admin.launch_mirror_repaired", launch: on }));
}
