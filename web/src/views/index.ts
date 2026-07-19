// views/index.ts — registers the extracted workspace views (console-uplift
// 1.1). Importing this module populates the registry; app.ts's tab
// dispatcher consults it via viewFor(). History + Audit are the first
// residents — both are fresh-data views that re-mount on every activation
// (History: newly-applied entries surface immediately; Audit: fresh events +
// integrity status, no auto-poll).

import { registerView } from "./registry.js";
import { mountHistoryTab } from "../history.js";
import { mountAuditTab } from "../audit.js";
import { mountSpecsView, specsViewDegraded } from "./specs/index.js";

export { viewFor } from "./registry.js";

registerView({
  id: "history",
  panelId: "panel-history",
  remountOnActivate: true,
  mount: (panel) => { mountHistoryTab(panel); },
});

registerView({
  id: "audit",
  panelId: "panel-audit",
  remountOnActivate: true,
  mount: (panel) => { void mountAuditTab(panel); },
});

registerView({
  id: "specs",
  panelId: "panel-specs",
  remountOnActivate: false,
  // Dead-mount recovery (#390): a transient schema failure leaves the Specs
  // view degraded (empty PANELS); re-mount on activation until it heals.
  shouldRemount: specsViewDegraded,
  mount: (panel) => { void mountSpecsView(panel); },
});
