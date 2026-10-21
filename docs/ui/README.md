# PackServer UI scheme

- [`wireframes.html`](wireframes.html): clickable wireframes for every screen. Open it in a browser; the bar at the top switches persona (Anonymous, Member, Publisher) and jumps between screens.
- [`sitemap.md`](sitemap.md): personas, sitemap, page-by-page inventory, header states, permission matrix, private-access options, open decisions.
- [`flows.md`](flows.md) (rendered with diagrams in [`flows.html`](flows.html), generated from flows.md and sitemap.md): step-by-step action flows with sequence diagrams (sign-up and MFA, reviews, bug reports, publishing by upload and from GitHub, validation, payment, org verification, private access, agent fetch over MCP, yank, moderation).

Aligned with the registry research (passkeys, OIDC trusted publishing, namespace verification, gated access requests) and the backend design (`gh/<org>/<pack>` and `com.google/<pack>` namespaces, per-new-pack publish credits, staged CI publishes).
