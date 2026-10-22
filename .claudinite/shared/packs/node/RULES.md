# Node.js

## Module resolution

- **A *named* import from a package's CommonJS entry can silently yield `undefined`.** Node recovers
  named bindings from a CJS module by static analysis, and that analysis fails on plenty of real
  entry points (a re-export built at runtime, a conditional assignment) — with no error: the
  import resolves, the binding is `undefined`, and the failure surfaces later as "x is not a
  function". When a package ships both entries, import the **ESM** one explicitly
  (`…/package/index.mjs`, or the `import` condition of its `exports`) for named bindings; when it
  doesn't, `import pkg from '…'` and destructure off the default. Resolve the package's own
  directory (`$(npm root -g)/<pkg>` for a global install) rather than hardcoding an absolute path
  into a version-pinned layout, which moves under you on the next image or upgrade.
  (named-import-packages)

- **Modern Node (22.7+) detects ES-module syntax in a `.js` file on its own** — no
  `"type": "module"`, no flag, no warning. A directory of ES modules therefore needs **no
  `package.json` of its own** just to be loadable; adding one to declare module-ness is cargo cult,
  and one already present for that reason is vestigial. (Prefer `.js` consistently within a tree
  over mixing in `.mjs` for the same purpose; the extension is then a style choice, not a signal.)
  (modern-node-22)

- **A throwaway script that imports a project dependency can't live in an external scratchpad.**
  Node's module resolution walks up from the *script's own directory* looking for `node_modules`,
  which never reaches the project's tree when the script sits outside it — the import fails with
  `ERR_MODULE_NOT_FOUND` however correctly the dependency is installed, and `NODE_PATH` doesn't help
  (it has no effect on ESM resolution). Put such a script inside the project (a gitignored scratch
  directory works), not in the harness's separate scratchpad. (throwaway-script-imports)

- **Before relying on a version-gated Node runtime feature, check what version CI actually pins**
  — the workflow's `setup-node` step, not the Node installed in the sandbox you're working in. A
  session's own Node can be newer than CI's pin, so a local green run proves nothing about the
  version that will execute the code in CI. (relying-version-gated)

- **Adding a `setup-node` step to a workflow** — declare its caching either way, `cache: npm` with a
  committed lockfile and `package-manager-cache: false` without: v5 caches by itself once
  `package.json` names `packageManager: npm`, and a cache with no lockfile fails the step. A
  workflow that can't assume a lockfile decides at run time:
  `cache: ${{ <has-lockfile> && 'npm' || '' }}`. (adding-setup-node)

## Ending a process

- **Ending a script that has printed anything** — set `process.exitCode` and let the process end,
  rather than `process.exit()`, which discards writes still queued: a write to a *pipe* is
  asynchronous, so a caller capturing the output silently gets a truncated answer under a
  successful status. (ending-script-has)

## jsdom diverges from a real browser in ways a green test can hide

- **`body.innerText` is null in jsdom.** Code reading `el.innerText || el.textContent` therefore
  falls through to `textContent` under test, which *includes* the `<script>` / `<style>` text,
  `<select>` / `<option>` text, and CSS-hidden text a real browser's `innerText` omits. Treat
  body-text results as jsdom-optimistic; never add a test that only passes because of it.
  (body-innertext-null)

- **`runScripts: "outside-only"` (the default) parses `<noscript>` into live DOM — the opposite of
  a real browser.** A `textContent` read looks clean under test but splices the `<noscript>` markup
  into the value in Chrome, which keeps `<noscript>` as raw text. Parse a script-free fragment with
  `runScripts: "dangerously"` to reproduce the browser. (runscripts-outside-only)
