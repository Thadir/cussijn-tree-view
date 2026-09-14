# Cussijn Tree View — project notes for Claude Code

## What this is

A standalone Thunderbird WebExtension: a SequoiaView-style treemap of the
mailbox's folder structure, colored by tag/domain/address-type and
recursively drillable. It needs no native host, no companion process,
and no network access - it just reads mail via Thunderbird's own APIs
and draws a picture.

**Name**: "Cussijn" is an archaic Dutch spelling of "cushion" - a wink at
**cushion treemaps** (van Wijk & van de Wetering, 1999, TU Eindhoven),
the shading technique real SequoiaView (from the same research group) is
known for. The squarified layout algorithm this project actually
implements (`squarify()`) is the *other* half of that lineage (Bruls,
Huizing & van Wijk, 2000) - the two are related but distinct
contributions from the same group; don't conflate them in docs/comments.
The icon (`extension/icons/icon.svg`) draws both: a rounded, tufted
cushion silhouette with a small squarified treemap tiled inside it, each
cell carrying its own radial-highlight "bump" - the actual cushion-
treemap shading technique, not just decoration.

## Architecture

```
extension/
  manifest.json      permissions (accountsRead, accountsFolders,
                      messagesRead, messagesTags - all read-only; menus -
                      for the folder-pane and Tools menu entries) and
                      the browser_action/commands/options_ui declarations
  background.js       tiny: owns the toolbar button, a keyboard shortcut
                      (commands), a Tools-menu entry, and a folder-pane
                      context menu entry - all four open/focus the same
                      Cussijn Tree View tab via one openOrFocusView()
                      function. No dispatch table, no message relay -
                      see "Conventions" below for why.
  cussijn.html/.js    the treemap: reads mail directly via
                      messenger.accounts.list(true) (which also returns
                      each account's real rootFolder.subFolders tree,
                      nested) and messenger.messages.query() +
                      continueList pagination, then:
                        1. buildFolderTree() turns the messages + the
                           real folder tree into treemap nodes nested
                           exactly like the account's own folder pane -
                           see "Drill-down mirrors the real folder tree
                           first" below.
                        2. Within a leaf folder, groupMessages() further
                           aggregates by whichever of THREE precomputed
                           content dimensions (tag, sender domain,
                           To/Cc/Bcc address type - see groupFor()) is
                           active, then by sender, then by individual
                           message (the actual bottom of this data).
                      Lays out a squarified treemap (Bruls/Huizing/van
                      Wijk algorithm), renders with hover + recursive
                      drill-down (a "Depth" control shows several of
                      those levels nested at once - see layoutTree() -
                      rather than forcing one click per level) + a
                      filter bar, and opens a real Thunderbird search
                      view via
                      messenger.mailTabs.create/update +
                      .setQuickFilter() ("jump to search"). Also reads
                      an optional ?folder=<id> query param (set by the
                      folder-pane context menu entry) to open already
                      drilled all the way down to one real folder.
  cussijn.test.js     Node-run unit tests for the pure-logic pieces
                      (buildFolderTree, findFolderPath, computeBreakdowns,
                      groupFor, groupMessages, nextDimension, colorForKey,
                      jumpFilterFor, squarify, applyFilters,
                      buildQuickFilterProps, classifyAddressType,
                      hashColor) - the DOM wiring and the real
                      messenger.* calls are not unit-tested: they need a
                      live Thunderbird to exercise meaningfully, and this
                      dev environment doesn't have one (see "Known gaps").
  options.html        a short about page - there's nothing to configure.

build/                podman-based lint/test/package pipeline (Containerfile,
                      build.sh, run.sh) - `./build/run.sh`, no Node needed
                      on the host at all.
e2e/                  podman-based Robot Framework smoke suite against a
                      REAL headless Thunderbird over Marionette (not
                      Firefox - see e2e/README.md for why that's a category
                      error for this extension) - `./e2e/run.sh`. Verified
                      to actually install the built .xpi and open its page;
                      does NOT yet reach into the page's own DOM - see
                      e2e/README.md's "Known limitation" before assuming
                      otherwise or trying to add a content-level assertion.
```

## Conventions

- **No dispatch table.** `cussijn.js` calls
  `messenger.accounts`/`messenger.messages` directly instead of relaying
  through `background.js`. A dispatch table (a single choke point that
  every call is routed through) earns its keep when there's an external
  caller whose access needs limiting - there is no such caller here (no
  queue, no other process, no second party sending this extension
  commands), so there's nothing to enforce. Don't add a relay "for
  consistency" with some other pattern; it would be indirection with no
  purpose.
- **MV2 (not MV3).** Chosen for consistency with an already-verified-
  working pattern, not because MV3 would break anything here -
  `background.persistent: false` is set so Thunderbird can still
  suspend/wake this background page freely, closer to how an MV3 event
  page behaves anyway. Revisit MV3 if there's a reason to (e.g. wanting
  to publish under a manifest version Mozilla is pushing harder).
- Read-only-or-UI-only permissions (`accountsRead`, `accountsFolders`,
  `messagesRead`, `messagesTags`, `menus`) - this extension never calls
  `messages.update`/`.move`/`.delete` or anything under `compose`. Keep
  it that way; if a future feature needs a write permission, that's a
  meaningfully bigger scope change than this project started with and
  deserves being flagged as such, not added quietly.
- **There is no supported way for a WebExtension to add an item to
  Thunderbird's native "View" application menu** - checked against
  webextension-api.thunderbird.net's `menus` docs before assuming
  otherwise; its `contexts` list has `tools_menu` (the Tools menu) but
  nothing for View. The real entry points the platform offers beyond a
  toolbar button are a keyboard shortcut (the `commands` manifest key +
  `messenger.commands.onCommand`, namespaced under `messenger.*`, not
  `browser.*`), a Tools-menu item (`messenger.menus`, `contexts:
  ["tools_menu"]`), and a folder-pane context menu entry
  (`contexts: ["folder_pane"]` - its `onClicked`/`info` carries the
  target folder as `selectedFolders` (an array of `MailFolder`), *not*
  `displayedFolder`, which is a `message_list`-only field). All three
  are wired in `background.js`; don't reintroduce a half-remembered API
  shape here without checking the current docs first - a plausible-
  looking `messenger.*` shape has turned out to be wrong in this
  codebase before (see the `accounts.list()` boolean note further down)
  and Thunderbird's API has clearly drifted from whatever a
  half-remembered shape assumes.
- `messenger.menus.create()` is called unconditionally at the top of
  `background.js` (not guarded by an installed/first-run check) because
  this is a non-persistent event page that can't reliably track "have I
  already registered this" across suspends - a resulting "duplicate id"
  error on a later wake is expected and swallowed, not a bug to fix by
  adding first-run tracking.
- Tag display names come from `messenger.messages.listTags()` at load
  time (`realListTags()` in `cussijn.js`), not a hardcoded map - this
  extension has no opinion on what a user's tags are called or mean.
- Colors are assigned dynamically per session (`assignPalette()`) from
  whatever dominant tags are actually present, not a fixed category ->
  color table - there's no fixed category list to hardcode against.
- **The coloring/grouping dimension is switchable and independent of
  filtering.** Filters (tag OR-selection, address-text search) narrow
  *which messages* are counted at all; "Group by" (tag / sender domain /
  address type) only changes what a rectangle's *color* represents.
  `computeBreakdowns()` computes all three dimensions' breakdowns up
  front so switching modes is a re-render, not a re-fetch - keep that
  property if adding a fourth dimension, rather than re-aggregating per
  mode switch.
- **The default Group-by mode is picked per account, not hardcoded to
  "tag."** Found live: a Gmail account (via IMAP) had zero
  Thunderbird-tagged messages, so Group-by: Tag colored literally every
  cell the same muted Uncategorized gray - technically correct, useless
  as a picture. `loadData()` now checks whether the just-loaded account
  has ANY tagged message at all and defaults to "domain" instead when it
  doesn't - but only while `groupByAutoPicked` is still true.
  `setGroupBy()` (a user's own click) sets it false permanently for the
  session, so this auto-pick never overrides a Group-by the user
  actually chose, even if they then switch to another tag-less account.
  Don't make this unconditional (i.e. don't drop the
  `groupByAutoPicked` check) - a user who deliberately wants to SEE "yes,
  this account has nothing tagged" by picking Tag mode themselves should
  still be able to.
- **Sender-domain coloring uses `hashColor()`, not the fixed tag
  palette.** The set of domains isn't known ahead of time the way tags
  are, so each domain's color is derived deterministically from its own
  string (same domain -> same color, every session) rather than
  assigned by first-seen order - that's what makes it usable at all
  (a palette that shuffled on every reload would defeat the point of
  color-coding by domain).
- **Address-type classification (`classifyAddressType`) needs to know
  the mailbox owner's own address(es).** These come from
  `messenger.accounts.list(true)`'s `identities`, which are always
  present on every `MailAccount` regardless of that boolean - the
  boolean actually controls whether `rootFolder.subFolders` gets
  populated (see the next bullet); don't conflate the two, an earlier
  version of this file's comments did. A message doesn't state directly
  "was this addressed to me" - it carries To/Cc/Bcc address lists, which
  `classifyAddressType` compares against those identities.
- **Drill-down mirrors the real folder tree first, then falls back to
  content grouping.** `buildFolderTree()` walks
  `account.rootFolder.subFolders` (nested, from `accounts.list(true)`)
  and buckets the already-fetched messages by their real `folder.id` -
  it does NOT build one node per distinct full path the way an earlier
  version of this file did, which showed a folder and its own subfolder
  as unrelated flat siblings instead of parent and child. A node's
  `messages`/`count`/`size_mb`/breakdowns are the recursive union of its
  own direct messages plus every descendant's, mirroring how a real
  disk-usage view treats a directory's size as including its
  subdirectories'. `drillInto()` (in `cussijn.js`) checks `n.children`
  first: any real subfolders (or the synthetic "(direct in this
  folder)" node - see below) drill structurally, arbitrarily deep;
  only once that's exhausted (`n.children.length === 0`) does it fall
  through to the OLDER recursive-by-content-dimension machinery below
  this bullet (`groupMessages()`/`nextDimension()`: leaf folder -> the
  active Group-by dimension -> sender -> terminal). A folder with both
  its own direct messages AND real subfolders gets one extra synthetic
  child, `{ label: "(direct in this folder)", children: [] }`, built
  with the SAME node shape as a real folder so it falls through to
  content-dimension drilling exactly like a true leaf would - don't
  special-case its rendering. When computing a parent's `allMessages`
  in `buildFolderTree()`, sum the REAL children's `.messages` before
  pushing that synthetic node into the children array, not after - it
  otherwise double-counts every direct message (own, once) once (own,
  again via the synthetic child's `.messages`); a test in
  `cussijn.test.js` caught exactly this. Every drill node (both the
  folder-tree ones and the content-dimension ones) keeps its own
  `messages` array specifically so the next click can regroup that real
  subset - don't special-case one more hardcoded level (e.g. "top 8
  senders", which an even earlier version of this file did) - fold a new
  grouping dimension into `groupKeyFor()`/`colorForKey()`/
  `jumpFilterFor()` instead, and it drills like the others for free.
  `nextDimension()`'s content chain runs Group-by dimension -> sender ->
  `"message"` -> terminal - `"message"` is the actual bottom of this
  data, one cell per email; `groupKeyFor()` keys it by the message's own
  id (so a message-level group is always a singleton), and
  `colorKeyFor()` is the one place label and color diverge: a message's
  *label* is its subject (unique per cell, that's the point) but its
  *color* comes from its own sender via `hashColor()` instead (a unique
  id would hash to a meaningless color; the sender at least visually
  clusters one person's mail even at the finest level).
- **A `MailFolderId` is `"<accountId>://<path>"` - confirmed live** (e.g.
  `account4://INBOX`, from an actual right-click in a real multi-account
  profile), not assumed from docs. This matters because
  `pendingFolderId` (the `?folder=` deep link background.js's folder-pane
  entry sets) can name a folder in ANY account, not just whichever one
  `loadAccounts()` happens to default to - found live, the same way: a
  Gmail account's folder, right-clicked, opened showing the FIRST-listed
  account's (IMAP's) data instead, because `loadAccounts()` picked
  `accounts[0]` unconditionally before `pendingFolderId` was even
  consulted. `accountIdFromFolderId()` pulls the account id back out of
  the folder id itself - no separate account id needs to travel
  alongside `folder=` in the URL, since it's already encoded there - and
  `loadAccounts()` now prefers that account over `accounts[0]` whenever
  a pending folder names one. Keep deriving it this way rather than
  having background.js's menu handler pass a second `&account=` query
  param; the folder id already carries what's needed. Once consumed,
  `rebuild()` strips `?folder=...` back out of the visible address bar
  via `history.replaceState()` - a raw internal id like
  `?folder=account4%3A%2F%2FINBOX` left on display after it's done its
  job is just noise (also found live, same screenshot).
- **The account `<select>` shows each account's own identity email
  (`accountDisplayName()`), not `account.name`.** `account.name` is
  whatever display name Thunderbird's settings (or an import wizard)
  happened to give the account - not necessarily distinguishing at a
  glance between e.g. two accounts both left named "Mail". The identity
  email (`thadir@thadir.net` vs `thadir@gmail.com`) is unambiguous and
  matches how the user actually thinks of "which account" - falls back
  to `account.name` only for the edge case of an account with no
  identities at all.
- **`nextLevelNodes()`, `layoutTree()`, and the "Depth" control turn the
  same drill-down into an at-once nested view, not just a click-per-level
  one.** `nextLevelNodes(n)` is `drillInto()`'s "what's one step inside
  this node" logic pulled out into its own function specifically so
  `layoutTree()` can call the SAME logic to expand a cell's children
  INLINE (nested inside its own rectangle, still in the outer
  container's coordinate space - see the comment on `layoutTree()`) when
  the user's chosen "Depth" allows more than one level to be visible at
  once. A cell whose children are drawn inline this render skips its own
  label/go-btn (they'd render underneath those children) - real
  SequoiaView doesn't label intermediate levels of its nested view
  either, relying on hover for identification; only the deepest cells
  actually shown keep their label. Depth changes only re-render already-
  loaded data (no re-fetch) and is independent of `stack`/breadcrumb
  navigation - clicking a cell still drills the whole view forward by
  one step (to whatever is inside THAT cell), it just starts from a
  richer nested picture each time rather than a flat one. **Exception:
  `layoutTree()` never lets a sender-level cell auto-expand into
  individual messages, no matter how high Depth is** - found live: every
  message has count 1, so inline-expanding a real sender's messages
  produced one giant near-blank `groupMessages()` overflow cell (most of
  the screen) plus a wall of same-size tiles, not a useful picture.
  Message-level detail stays reachable, just only via an explicit click
  (`drillInto()`) - don't remove that guard to "simplify" `canExpand`.
- **`groupMessages()` caps how many distinct groups become their own
  cell**, and the cap is DIFFERENT for "message" than every other
  dimension. `MAX_GROUP_NODES` (200) applies to tag/domain/addressType/
  sender - dimensions where group SIZE varies meaningfully, so seeing
  many is genuinely informative. `MAX_MESSAGE_NODES` (40) applies only to
  "message" - every individual message has the same count (1), so a wall
  of 199 identically-tiny tiles is no more useful than a wall of 39, just
  slower to lay out and click through. Either way, a dimension with more
  groups than its cap would otherwise turn into one treemap cell PER
  group - hundreds of slivers. Past the cap, the smallest groups fold
  into one `isOverflow: true` node (`groupKey`/`colorKey` both `null`,
  colored via the same muted gray as an empty/uncategorized cell - see
  `colorForKey()`) rather than each getting a cell; the biggest
  `cap - 1` groups still show individually, since those are what's
  actually worth seeing. If a future grouping dimension can also produce
  many same-sized groups, give it its own low cap the way "message" has,
  rather than lumping it under `MAX_GROUP_NODES`.
- **Right-click on a cell (`contextmenu`, `preventDefault()`'d) does the
  same thing as its hover go-btn** - both call `openFolderSearchImpl`
  with the same `n.folderId`/`n.jumpFilter`. It's wired on EVERY cell,
  not gated by `!entry.hasInlineChildren` the way the go-btn is - a
  "container" cell (one currently showing its children nested inside it)
  hides its own go-btn (see the `nextLevelNodes()`/`layoutTree()` bullet
  above), so right-click is the only way to jump straight to THAT cell's
  own search without drilling into it first. Keep both wired to the same
  action if either changes - they're meant to feel like one affordance
  reached two ways, not two separate features.
- **The address filter and `mailTabs.setQuickFilter()`'s text match
  must stay in the same scope.** `applyFilters()` (client-side, builds
  the treemap) and `buildQuickFilterProps()` (what actually gets sent to
  Thunderbird for "jump to search") both search From+To+Cc+Bcc together
  - if one changes scope, the treemap and the search view it links to
  will disagree about what matched. There is no CC-only match in either
  place: Thunderbird's own `QuickFilterTextDetail` has no such flag,
  only a combined `recipients` (To+Cc+Bcc) - said plainly in the README
  rather than faked with a client-side-only CC filter that the "jump to
  search" link couldn't actually reproduce.

## CI/CD & releases

- **`main` is protected and only ever moves via PR** - required status
  check `test` (the CI job in `.github/workflows/ci.yml`) must pass,
  force-push and deletion are blocked. Dependabot's PRs get the same
  gate: `.github/workflows/dependabot-auto-merge.yml` turns on GitHub's
  native auto-merge on them the moment they're opened, which only
  actually merges once `test` passes - it doesn't bypass CI, it just
  removes the need to click merge by hand.
- **Versioning is `.github/workflows/release.yml`, deliberately NOT
  release-please/semantic-release/Conventional Commits.** An earlier
  version of this pipeline used release-please; it was ripped out
  because its whole engine is hard-wired to `feat`/`fix`/`!` vocabulary
  with no config knob to just relabel those keywords, and this project
  wants literal `major`/`minor`/`bugfix` instead. That word now appears
  in exactly one of two places on a PR - a GitHub label (`major`,
  `minor`, or `bugfix`; checked first) or the PR title starting with
  `major:`/`minor:`/`bugfix:` (fallback; `patch:` also reads as
  `bugfix`) - never a commit-message type prefix. Don't reintroduce
  `feat:`/`fix:`/`BREAKING CHANGE:` parsing here; a PR with neither
  signal present merges normally and cuts no release at all, which is
  the correct behavior for docs/CI/Dependabot PRs, not a bug to fix by
  making one of major/minor/bugfix the silent default.
- **Merging a real PR does not cut a release by itself - it triggers a
  SECOND, fully automatic hop through the same workflow.** `release.yml`
  runs on every `pull_request: closed` into `main` and tells the two
  hops apart by the merged branch's name:
  1. A real PR merges (any branch not starting `release/`) - reads its
     label/title for a bump type, computes the next `vX.Y.Z` from the
     latest git tag, and opens + immediately auto-merges a
     `release/vX.Y.Z` PR bumping `extension/manifest.json`'s `version`
     and prepending a `CHANGELOG.md` entry.
  2. That `release/*` PR merges - THIS is what tags the repo and
     publishes a GitHub Release. Recognized purely by branch name
     (`startsWith(..., 'release/')`), not by anything in its title/label,
     so don't rename that branch prefix without updating both `if:`
     conditions in `release.yml` together.
  This two-hop shape exists only because main's branch protection
  ("require a pull request before merging") blocks even this workflow's
  own `GITHUB_TOKEN` from pushing the version-bump commit straight to
  `main` - from a human's perspective it's still one merge, since hop 2
  is fully automatic (auto-merge waiting on the same required `test`
  check every other PR waits on, no manual click) unlike release-please's
  old deliberately-manual "release PR" checkpoint. Don't add a manual
  approval gate back onto the `release/*` PR "for safety" without
  flagging that as a deliberate scope change - the whole point of this
  redesign was removing the second click.
- **A published GitHub Release is what triggers
  `.github/workflows/publish-thunderbird.yml`** (`on: release:
  types: [published]`, not `on: push: tags`) - it rebuilds the `.xpi`
  from that exact tagged commit via the same `build/build.sh` CI already
  uses, attaches it to the GitHub Release, then signs and submits it to
  addons.thunderbird.net (ATN) via `kewisch/action-web-ext` (maintained
  by a Thunderbird add-ons contributor - it knows ATN's quirks the
  generic Mozilla `web-ext` tooling doesn't default to).
- **ATN is a separate addons-server instance from addons.mozilla.org
  (AMO), on the older v4 API, not AMO's v5** - that's why
  `publish-thunderbird.yml` passes an explicit
  `apiUrlPrefix: https://addons.thunderbird.net/api/v4` instead of
  relying on the action's AMO-pointed default. Needs two repo secrets
  (`ATN_API_KEY`/`ATN_API_SECRET`) from an ATN developer account that
  only a human can create - see README's "Publishing to Thunderbird
  Add-ons" section. **Unverified against a real ATN submission**: whether
  a brand-new listing's very first version can go through this API path
  cleanly, or needs one manual web-UI upload first to create the listing
  - don't assume either way without checking, and see that same README
  section before troubleshooting a failed first release.
- **Dependabot has exactly two ecosystems to watch, both grouped weekly**
  (`.github/dependabot.yml`): `github-actions` (the actions these
  workflows use) and `docker` (`build/Containerfile`'s `node:20-slim`
  base). There is no `npm`/`package.json` ecosystem to add - this
  extension has zero JS dependencies by design (see the rest of this
  file) - don't add one "for completeness."

## Known gaps / TODO

- There IS now an automated test against a real Thunderbird
  (`e2e/`, `./e2e/run.sh`) - but it's a shallow smoke test (does the real
  .xpi install and activate, does its page open without erroring), not a
  DOM/interaction test. It cannot currently read anything out of
  cussijn.html's own rendered page (see e2e/README.md's "Known
  limitation" - genuinely investigated and confirmed, not just
  unattempted) or exercise real `messenger.*` data (empty profile, no
  seeded mail - see e2e/README.md's "No mail fixture data"). The unit
  tests remain what actually covers the pure logic (folder/tag
  aggregation, the treemap layout math); don't treat the e2e suite as a
  substitute for either that or a real DOM-rendering test.
- `buildFolderTree()` assumes a message's `folder.id` (from
  `messages.query()`) matches a `MailFolder.id` in the SAME account's
  `rootFolder.subFolders` tree (from `accounts.list(true)`, a separate
  call) exactly - now indirectly supported by a live session (a
  right-clicked folder's tree rendered correctly, just under the wrong
  account - see the `MailFolderId` bullet above - which only works at
  all if this matching succeeds), but still not exhaustively verified
  across every account/folder-type combination. If folders mysteriously
  stop appearing in the tree (messages get fetched but their folder
  never groups under anything), check this first - the same category of
  risk as other API-shape assumptions in this codebase that have turned
  out wrong only once actually run against a live Thunderbird (see the
  squarify orientation bug found via a real screenshot, or the
  `accounts.list()` boolean note above).
- Only shows the currently-selected account, not a combined cross-account
  view - the account picker switches between accounts rather than
  merging them. Revisit if that turns out to matter in practice.
- No persistence of UI state (selected account, size mode) across
  reopens - always starts from the first account, count mode. Would need
  `browser.storage.local` if that's worth adding.

## Where things run

Entirely inside Thunderbird, on whatever machine the user installs it
on. `build/` runs in a podman container on a dev machine only, for
linting/testing/packaging - it never ships or runs on the end user's
machine.
