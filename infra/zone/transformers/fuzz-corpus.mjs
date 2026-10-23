// Writes the shared fuzz corpus and the JS evaluator's answer for each string, for
// verify-datafusion.py to compare against DataFusion:
//   node infra/zone/transformers/fuzz-corpus.mjs > corpus.json
import { loadSpec } from "../lib/spec.mjs";
import { envHosts } from "../lib/spec.mjs";
import { evaluateNetwork, fuzzCorpus, parseNetworkCase, readTemplate, renderTransformer } from "../lib/transformer.mjs";

const spec = loadSpec();
const job = spec.logpush.jobs.find((j) => j.transformer);
const parsed = parseNetworkCase(renderTransformer(readTemplate(spec, job), job, envHosts("production")));
process.stdout.write(JSON.stringify(fuzzCorpus().map((ip) => ({ ip, js: evaluateNetwork(parsed, ip) }))));
