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
                      the commands/options_ui declarations
  background.js       tiny: owns a keyboard shortcut (commands), a
                      Tools-menu entry, and a folder-pane context menu
                      entry - all three open/focus the same Cussijn Tree
                      View tab via one openOrFocusView() function. No
                      dispatch table, no message relay - see
                      "Conventions" below for why.
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
                           aggregates by whichever of FOUR precomputed
                           content dimensions (tag, sender domain,
                           To/Cc/Bcc address type, year - see groupFor())
                           is active, then (year only) by month, then by
                           sender, then by individual message (the actual
                           bottom of this data).
                      Lays out a squarified treemap (Bruls/Huizing/van
                      Wijk algorithm), renders with hover + recursive
                      drill-down (a "Depth" control shows several of
                      those levels nested at once - see layoutTree() -
                      rather than forcing one click per level) + a
                      filter bar (tag/address/"Hide sent by me"), and
                      opens a real Thunderbird search view via
                      messenger.mailTabs.create/update +
                      .setQuickFilter() ("jump to search"). Also reads
                      an optional ?folder=<id> query param (set by the
                      folder-pane context menu entry) to open already
                      drilled all the way down to one real folder, and
                      caches the last fetched messages/tags per account
                      in browser.storage.local (stale-while-revalidate -
                      see "Conventions" below) so reopening the view
                      shows something instantly instead of waiting on a
                      full re-fetch.
  cussijn.test.js     Node-run unit tests for the pure-logic pieces
                      (buildFolderTree, findFolderPath, computeBreakdowns,
                      groupFor, groupMessages, nextDimension, colorForKey,
                      jumpFilterFor, squarify, applyFilters,
                      buildQuickFilterProps, classifyAddressType,
                      isSentByMe, messageYear, messageSignature,
                      cacheKeyFor, cacheMatches, hasAnyTag, hashColor,
                      legendEntries, nextLevelNodesFor, layoutTree,
                      withSizeValue, folderName, fmtSize) plus the thin
                      messenger.*/browser.* boundary functions
                      (realQueryAllMessages, realOpenFolderSearch,
                      realReadCache, ...) against fake globals.
                      `initUi()`'s DOM wiring is not unit-tested: it
                      needs a live Thunderbird to exercise meaningfully,
                      and this dev environment doesn't have one (see
                      "Known gaps"). Keep new logic OUT of `initUi()`
                      and in a module-level function it calls - that is
                      what makes it testable.
  options.html        a short about page - there's nothing to configure.

build/                podman-based lint/test/package pipeline (Containerfile,
                      build.sh, run.sh) - `./build/run.sh`, no Node needed
                      on the host at all. `local-build.sh` is a fallback
                      for a dev environment where rootless podman can't
                      run (this sandbox) - same lint/test, but packages
                      with python3's zipfile and stamps the packaged
                      manifest.json's version with a build timestamp
                      (`1.0.1.202609161930`, say) so Thunderbird always
                      treats a fresh local build as newer than the last
                      one; the checked-in manifest.json's version is
                      never touched. Also copies the result to Thadir's
                      SequoiaView folder (see "Where things run").
                      `sonar.sh` runs a SonarQube code-quality scan in a
                      container (see "CI/CD & releases").
e2e/                  podman-based Robot Framework smoke suite against a
                      REAL headless Thunderbird over Marionette (not
                      Firefox - see e2e/README.md for why that's a category
                      error for this extension) - `./e2e/run.sh`. Verified
                      to actually install the built .xpi and open its page;
                      does NOT yet reach into the page's own DOM - see
                      e2e/README.md's "Known limitation" before assuming
                      otherwise or trying to add a content-level assertion.
                      fixtures/generate_fixture.py generates a throwaway
                      profile's synthetic (fake senders, *.test domains)
                      Local Folders mail; robot/screenshot.robot
                      (`./e2e/screenshot.sh`, on-demand only, not CI)
                      uses it to produce docs/screenshot.png for the
                      README.
```

## Conventions

- **`manifest.json`'s `applications.gecko.id` is
  `cussijn-tree-view@thadir.net` - PERMANENT, never bump it per
  release.** This is the add-on's actual identity to Thunderbird/ATN -
  what makes a new `.xpi` register as "a new version of the same
  add-on" instead of an unrelated one - NOT something that tracks the
  version number, which already lives in `manifest.json`'s separate
  `"version"` field and is what the release pipeline (`release.yml`)
  actually bumps every release. Changing it orphans the current ATN
  listing (a new id is a brand-new listing to ATN, Description/Homepage
  and all) and breaks auto-update for anyone who already installed it.
  Don't ever suggest bumping this per-version "to match" the version
  number - the version field already does that job.
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
  `messagesRead`, `messagesTags`, `menus`, `storage`) - this extension
  never calls `messages.update`/`.move`/`.delete` or anything under
  `compose`. `storage` is `browser.storage.local` only, used for the
  per-account message/tag cache (see "Conventions" below) - still
  entirely local to the machine, nothing leaves it. Keep the no-mail-write
  rule; if a future feature needs a write permission, that's a
  meaningfully bigger scope change than this project started with and
  deserves being flagged as such, not added quietly.
- **There is no supported way for a WebExtension to add an item to
  Thunderbird's native "View" application menu** - checked against
  webextension-api.thunderbird.net's `menus` docs before assuming
  otherwise; its `contexts` list has `tools_menu` (the Tools menu) but
  nothing for View. The real entry points this extension uses are a
  keyboard shortcut (the `commands` manifest key +
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
- **No `browser_action` toolbar button.** It can't reliably resolve the
  right account/folder from a background script's tab-focus state. Don't
  add one without first confirming, live, that it can.
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
  filtering.** Filters (tag OR-selection, address-text search, "Hide
  sent by me") narrow *which messages* are counted at all; "Group by"
  (tag / sender domain / address type / year) only changes what a
  rectangle's *color* represents. `computeBreakdowns()` computes all
  four dimensions' breakdowns up front so switching modes is a
  re-render, not a re-fetch - keep that property if adding a fifth
  dimension, rather than re-aggregating per mode switch. Year, month,
  and address-type all have no matching `mailTabs.setQuickFilter()`
  facet (`NO_SEARCH_FACET` in cussijn.js) - no date/age or Cc-only
  match exists in that API - so jumping to search from one of those
  can't narrow past the folder's own current filters. The go-btn's
  tooltip says so directly for those three rather than silently
  opening the whole folder unfiltered and looking broken.
- **"Hide sent by me" (`isSentByMe()`/`applyFilters()`'s `hideSentByMe`)
  is a filter, not a Group-by mode** - it drops any message whose
  author is one of the account's own identities. Exists because Gmail's
  "All Mail" is, by IMAP definition, every message including your own
  sent replies - there's no folder-level way to see received-only mail
  there the way Inbox already gives you for free. Doesn't propagate to
  `mailTabs.setQuickFilter()` either (no such facet), same limitation
  as the dimensions above.
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
- **The "Tag" Group-by button relabels itself "Label" for a tag-less
  account** (same `anyTagged` check as above, but applied unconditionally
  - not gated by `groupByAutoPicked`, since the button's own wording
  should stay honest even if the user manually clicked back into that
  mode). This is a display-only rename, not a data-model change: Gmail's
  own "labels" and Thunderbird's own "tags" are genuinely different
  things under the hood (a label is folder membership - Gmail exposes
  each label as its own real IMAP folder, which `buildFolderTree()`
  already surfaces and drills into with no special-casing needed - a tag
  is a flat per-message field Gmail's IMAP labels don't populate at
  all). Don't attempt to synthesize a "these are the same dimension"
  merge (e.g. deriving a message's "tags" from which label-folders it
  appears in across `messages.query()`'s per-folder rows) without first
  verifying, against a live Gmail account, whether there's a stable
  cross-folder message identity available via this API to group same-
  message folder-occurrences by - unverified, and a wrong guess here
  (matching by subject+date+author, say) risks silently merging two
  different emails that happen to share both.
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
  populated (see the next bullet); don't conflate the two. A message doesn't state directly
  "was this addressed to me" - it carries To/Cc/Bcc address lists, which
  `classifyAddressType` compares against those identities.
- **Drill-down mirrors the real folder tree first, then falls back to
  content grouping.** `buildFolderTree()` walks
  `account.rootFolder.subFolders` (nested, from `accounts.list(true)`)
  and buckets the already-fetched messages by their real `folder.id` -
  it does NOT build one node per distinct full path - that would show a
  folder and its own subfolder as unrelated flat siblings instead of
  parent and child. A node's
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
  senders") - fold a new
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
  clusters one person's mail even at the finest level). "year" gets one
  extra hop before that chain resumes: `"year" -> "month" -> sender ->
  message`, requested by the user - a year alone is coarse. Month is a
  bounded set of exactly 12, so it colors like `addressType` (a fixed
  `PALETTE_ORDER` slot per value) rather than `hashColor()`. `layoutTree()`
  also never lets a month-level cell auto-expand into sender/message via
  Depth (same treatment as sender never auto-expanding into message,
  just below) - a further breakdown within one month is still a click
  away.
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
  one.** `nextLevelNodes(n)` (a thin wrapper in `initUi()` over the pure,
  module-level `nextLevelNodesFor(n, ctx)`) is `drillInto()`'s "what's
  one step inside this node" logic pulled out into its own function
  specifically so `layoutTree()` (also module-level and pure; it takes
  the expansion function as a parameter) can call the SAME logic to expand a cell's children
  INLINE (nested inside its own rectangle, still in the outer
  container's coordinate space) when the user's chosen "Depth" allows
  more than one level to be visible at once. Depth changes only
  re-render already-loaded data (no re-fetch) and is independent of
  `stack`/breadcrumb navigation - clicking a cell still drills the whole
  view forward by one step, it just starts from a richer nested picture
  each time rather than a flat one. `MAX_DEPTH` (6) is what the "Max"
  button jumps straight to in one click.
  A container (a cell whose children are drawn inline) keeps a slim
  `cell-header` labeling ITSELF instead of the normal bottom
  label/go-btn - with several containers expanded at once (several
  years, each showing its own months), there'd otherwise be no way to
  tell which cluster of children belongs to which container. The header
  has its own `▸` hint (clicking a container still drills into just that
  one node, e.g. focus on 2012 alone). A non-container cell gets the
  same `▸` mark near its own corner whenever `nextLevelNodes()` would
  return something, so a cell that looks flat (Depth too low, too
  small, or its dominant child color happens to match its own) still
  shows there's more to click into.
  **Exceptions to auto-expanding via Depth, both still reachable by an
  explicit click:** a sender-level cell never auto-expands into
  individual messages (every message has count 1, so it's a wall of
  same-size tiles, not informative) - month gets the same treatment,
  by request (month is meant to be the max automatic step in the
  Year -> Month breakdown). Separately, ANY cell whose next level would
  be a SINGLE group also doesn't expand, regardless of dimension - a
  lone child is the same 100%-of-area group just relabeled one
  dimension finer, so expanding into it would only hide the parent's own
  label for no informational gain (found live: Sent, authored entirely
  by the account owner, grouped by Year - every year's "sender"
  breakdown was just one group, so every year inline-expanded into a
  blank single-sender blob and the year labels disappeared).
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
- **The breadcrumb (`renderBreadcrumb()`) is a row of arrow-shaped
  chips, not plain text with a "›" character between them.** Each
  `<button>` is its own `clip-path` polygon (a point cut into one edge,
  a matching notch in the other) sized by the shared `--notch` custom
  property, so consecutive levels interlock into one ribbon; no
  separate separator element needed. The notch's tip must point INWARD
  (toward the next segment's own tip), not outward, or two segments read
  as "><" meeting nose-to-nose instead of one continuous ">" chain -
  found live, fixed once. `--crumb-a`/`--crumb-b` alternate per segment
  (`:nth-of-type(even)`) so adjacent levels stay visually distinct.
- **The address filter and `mailTabs.setQuickFilter()`'s text match
  must stay in the same scope.** `applyFilters()` (client-side, builds
  the treemap) and `buildQuickFilterProps()` (what actually gets sent to
  Thunderbird for "jump to search") both search From+To+Cc+Bcc together
  - if one changes scope, the treemap and the search view it links to
  will disagree about what matched. There is no CC-only match in either
  place: Thunderbird's own `QuickFilterTextDetail` has no such flag,
  only a combined `recipients` (To+Cc+Bcc) - said plainly in the README
  rather than faked with a client-side-only CC filter that the "jump to
  search" link couldn't actually reproduce. Exception: `jumpFilterFor()`
  marks a domain/sender/message drill's filter `senderOnly` -
  `buildQuickFilterProps()` then searches the sender field alone, not
  sender+recipients, since those three dimensions are computed from a
  message's author alone. Without this, drilling into your own address
  as a sender matches nearly every message in the account (you're also
  the recipient of most of them).
- **Per-account message/tag cache in `browser.storage.local`, stale-
  while-revalidate.** `loadData()` shows a cached account instantly if
  `readCacheImpl()` finds one, then fetches for real in the background;
  `messageSignature()` (a sorted-id fingerprint, order-independent)
  decides whether anything actually changed before re-rendering -
  rebuild() always resets the navigation stack back to "All folders",
  so re-rendering on a no-op background refresh would silently kick the
  user out of whatever they were drilled into for no reason. A cache
  write/read failure (quota, disabled storage) is swallowed - caching
  is an optimization, not something the view depends on to function.
## CI/CD & releases

- **`main` is protected and only ever moves via PR** - required status
  check `test` (the CI job in `.github/workflows/ci.yml`) must pass,
  force-push and deletion are blocked. Dependabot's PRs get the same
  gate: `.github/workflows/dependabot-auto-merge.yml` turns on GitHub's
  native auto-merge on them the moment they're opened, which only
  actually merges once `test` passes - it doesn't bypass CI, it just
  removes the need to click merge by hand.
- **Versioning is `.github/workflows/release.yml`, deliberately NOT
  release-please/semantic-release/Conventional Commits.** release-please's
  engine is hard-wired to `feat`/`fix`/`!` vocabulary with no config knob
  to just relabel those keywords, and this project wants literal
  `major`/`minor`/`bugfix` instead. That word now appears
  in exactly one of two places on a PR - a GitHub label (`major`,
  `minor`, or `bugfix`; checked first) or the PR title starting with
  `major:`/`minor:`/`bugfix:` (fallback; `patch:` also reads as
  `bugfix`) - never a commit-message type prefix. Don't reintroduce
  `feat:`/`fix:`/`BREAKING CHANGE:` parsing here; a PR with neither
  signal present merges normally and cuts no release at all, which is
  the correct behavior for docs/CI/Dependabot PRs, not a bug to fix by
  making one of major/minor/bugfix the silent default.
- **Merging a labeled/prefixed PR opens a second, small `release/vX.Y.Z`
  PR - merging THAT one (a deliberate, permanent manual step) is what
  tags the repo and publishes a GitHub Release.** Hop 1 (opening that PR)
  runs on `GITHUB_TOKEN` alone - no PAT, and it does NOT auto-merge the
  PR it opens. **Don't push straight to `main` with a stored personal
  access token to skip this step** - a PAT with write access to the repo
  is a real credential risk, not something this pipeline should hold on
  the user's behalf. **Don't auto-merge the `release/*` PR with
  `GITHUB_TOKEN` either** - GitHub's anti-recursion protection means a
  `GITHUB_TOKEN`-driven merge doesn't trigger further workflow runs, so
  the tag/release step would silently never fire, with no error anywhere.
  A human merging it instead (the GitHub UI, or Claude through its own
  authenticated `gh` session, which counts as a real user action)
  sidesteps that limit for free, with no new secret, and doubles as a
  legitimate checkpoint before anything reaches the Thunderbird store.
  GitHub sometimes holds that PR's own CI run for manual
  "action_required" approval too, since it's opened by
  `github-actions[bot]` - that's a normal part of reviewing/merging it,
  not a bug (`gh api -X POST repos/OWNER/REPO/actions/runs/<id>/approve`
  clears it, same as clicking Approve in the Actions tab). Branch
  protection's `strict: true` (require branch up to date) can also mark
  this PR stale (`BEHIND`) if an unrelated PR merges first - `gh api -X
  PUT repos/OWNER/REPO/pulls/<n>/update-branch` re-syncs it before
  merging. **Hop 2's own step needs its own `git config
  user.name`/`user.email`** - it's a separate job step from hop 1's
  PR-opening one that already sets those, and an annotated tag (`git tag
  -a`) fails outright without a committer identity (`fatal: empty ident
  name`).
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
  Add-ons" section. **Confirmed working against a real, brand-new ATN
  listing** (this repo's actual v1.0.0): the `.xpi` uploaded, validated,
  and was auto-signed within a couple of minutes with no manual step -
  `web-ext`'s own "doesn't have signing enabled" warning during the
  upload just means it doesn't wait around for that async result, not
  that signing itself didn't happen. Don't reintroduce the old
  "unverified, may need a manual first upload" hedge; this is settled.
  **But the SECOND listed version needs one prerequisite, also confirmed
  live (v1.0.1 failed on it)**: ATN rejects a second listed version via
  the API with `You cannot add a listed version to this addon via the
  API due to missing metadata. Please submit via the website` until the
  add-on's Description is filled in on the ATN Developer Hub - addon-
  level metadata no manifest key or API call in this pipeline sets, a
  genuine one-time human step (see README's "Publishing to Thunderbird
  Add-ons"), not a bug in `publish-thunderbird.yml` to chase.
- **SonarQube runs as a container, not a hosted service.**
  `build/sonar.sh` runs the unit tests with the lcov reporter (in a
  `node:20-slim` container; Node 20 supports it), starts
  `sonarqube:community`, scans `extension/` (`sonar-project.properties`;
  tests excluded), and prints the quality gate, coverage and headline
  metrics. It is report-only - it exits 0 whatever the gate says. The
  gate wants 80% coverage on new code, so it reads ERROR when a change
  touches `initUi()`'s untested DOM wiring; that is expected, not a
  regression. Deliberate findings (swallowed-error catches, the `void` on
  `runtime.lastError`, `hashColor()`'s `charCodeAt`) are ignored through
  `sonar.issue.ignore.multicriteria` in `sonar-project.properties`, each
  with its reason there - add to that list rather than sprinkling
  `NOSONAR` comments. The same script serves both places: locally under podman
  (server left up at localhost:9000 for browsing) and in
  `.github/workflows/sonar.yml` with `CONTAINER_ENGINE=docker` (server
  discarded with the runner, result in the job summary). Elasticsearch's
  mmap is switched off in the container because stock Linux hosts and
  GitHub runners have too low a `vm.max_map_count`. The workflow is
  deliberately separate from `ci.yml`: `test` there is the required check
  and the scan must never be able to block a merge. Don't move the scan
  into the `test` job or make it required. No hosted SonarQube Cloud, no
  `SONAR_TOKEN` secret.
- **Dependabot has exactly two ecosystems to watch, both grouped weekly**
  (`.github/dependabot.yml`): `github-actions` (the actions these
  workflows use) and `docker` (`build/Containerfile`'s `node:20-slim`
  base). There is no `npm`/`package.json` ecosystem to add - this
  extension has zero JS dependencies by design (see the rest of this
  file) - don't add one "for completeness."

## Known gaps / TODO

- **The README's coverage badge is CI-generated, not a static number
  someone has to remember to refresh.** A step in `.github/workflows/
  ci.yml` (only `if: github.ref == 'refs/heads/main' && github.event_name
  == 'push'` - not on every PR, so unmerged/abandoned work never
  touches it) runs `node --test --experimental-test-coverage`, parses
  the "all files" line-% out of its human-readable table output (`awk
  -F'|' '/all files/ {...}'` - one number is all the badge needs), and
  pushes a small shields.io
  "endpoint" JSON file (`{schemaVersion, label, message, color}`) to a
  separate, UNPROTECTED `badges` branch - `git push` there needs no PAT,
  main's branch protection doesn't apply to a different branch.
  `build/build.sh` also runs with `--experimental-test-coverage` now
  (matches what CI computes) so `./build/run.sh` shows the same number
  locally. The badge itself (`img.shields.io/endpoint?url=<raw
  coverage-badge.json on the badges branch>`) always reflects whatever
  JSON is currently there - editing the badge URL or the JSON schema
  are the only ways to change what it shows, there is no manual
  "refresh" step to remember. This IS whole-file LINE coverage of
  `cussijn.js`, though, which mixes the fully-tested pure logic with
  `initUi()`'s deliberately-untested DOM wiring (see the
  `cussijn.test.js` bullet in Architecture above) - don't read a modest
  number here as "half the logic is untested," and don't try to
  inflate it by unit-testing DOM wiring that's supposed to stay covered
  by the e2e suite instead; the README states this caveat plainly right
  next to the badge - keep that pairing.
- There IS now an automated test against a real Thunderbird
  (`e2e/`, `./e2e/run.sh`) - but it's a shallow smoke test (does the real
  .xpi install and activate, does its page open without erroring), not a
  DOM/interaction test. It cannot currently read anything out of
  cussijn.html's own rendered page (see e2e/README.md's "Known
  limitation" - genuinely investigated and confirmed, not just
  unattempted). The unit tests remain what actually covers the pure
  logic (folder/tag aggregation, the treemap layout math); don't treat
  the e2e suite as a substitute for either that or a real DOM-rendering
  test. **Synthetic mail fixture data now exists though**
  (`e2e/fixtures/generate_fixture.py` - see e2e/README.md's "Mail
  fixture data"), used by `e2e/robot/screenshot.robot`
  (`./e2e/screenshot.sh`) to generate the README's `docs/screenshot.png`
  against a real headless Thunderbird - a full-window screenshot works
  fine (`Marionette.screenshot()`, browser-window level) even though
  reading the page's own DOM still doesn't. Don't wire `screenshot.sh`
  into CI/`run.sh` - it's on-demand only, regenerating an identical
  image on every push would be pure waste.
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
machine. `local-build.sh` additionally copies its output to
`C:\Users\Thadir\Documents\SequoiaView\cussijn-tree-view.xpi` (Thadir's
own install-from-file folder) - `/mnt/c/Users/Thadir/Documents/SequoiaView`
from inside WSL2.
