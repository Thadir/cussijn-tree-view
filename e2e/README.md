# End-to-end testing (real Thunderbird, not Firefox)

This extension is Thunderbird-only - `cussijn.js` calls
`messenger.accounts`/`messenger.messages`/`messenger.mailTabs`, none of
which exist in Firefox at all (Firefox has no mail-account concept).
There is no such thing as "testing this in Firefox"; any real
interaction test has to run actual Thunderbird.

## What this is

`./e2e/run.sh` builds a container with a real Thunderbird (Debian's
`thunderbird` package, currently 140.15.0 ESR) and runs a
[Robot Framework](https://robotframework.org/) suite
(`e2e/robot/smoke.robot`) against it, driven over
[Marionette](https://firefox-source-docs.mozilla.org/testing/marionette/index.html)
- the same remote-automation protocol `geckodriver` speaks to Firefox.
Thunderbird has shipped Marionette support since Thunderbird 69
([bug 1543725](https://bugzilla.mozilla.org/show_bug.cgi?id=1543725)).

There is no ready-made "SeleniumLibrary for Thunderbird" and no
`geckodriver`-equivalent that targets it, so `e2e/robot/CussijnLibrary.py`
is a small hand-written Robot Framework library talking to
`marionette_driver` directly, exposing only what's actually been
verified to work against a real Thunderbird (see below) - not a
speculative wrapper.

Run it locally:

```
./e2e/run.sh
```

It rebuilds `extension/` into `dist/cussijn-tree-view.xpi` (same as
`build/build.sh`) and then runs `e2e/robot/smoke.robot` against it,
writing Robot's `log.html`/`report.html`/`output.xml` to `e2e/results/`
(gitignored).

## What's actually verified

Everything the smoke suite does was confirmed by hand against a real,
running Thunderbird before being written into `CussijnLibrary.py` - not
assumed from documentation:

- Thunderbird launches headless (`-headless -marionette
  -remote-allow-system-access -no-remote -profile <dir>`) and Marionette
  comes up on port 2828, no Xvfb/virtual display needed.
- The Marionette session's capabilities genuinely identify
  `browserName: "thunderbird"` - `CussijnLibrary.start_thunderbird()`
  asserts this rather than trusting the caller pointed it at the right
  binary.
- The **real, built** `.xpi` installs temporarily via
  `marionette_driver.addons.Addons.install(path, temp=True)` - the same
  mechanism `about:debugging`'s "Load Temporary Add-on" uses (unsigned,
  active immediately, removed on shutdown) - and Thunderbird's own
  `AddonManager` reports it `isActive: true` afterwards.
- Opening `cussijn.html` as a real tabmail `contentTab` (via chrome-context
  script calling `tabmail.openTab("contentTab", {url})` - the same thing
  `background.js`'s `openOrFocusView()` does through
  `messenger.tabs.create`) actually navigates there: the tab's own
  `browser.currentURI.spec` ends up equal to the extension's real
  `moz-extension://<uuid>/cussijn.html` URL, not `about:blank` or an
  error page.

That's a genuine, if shallow, regression test: it would catch a broken
`manifest.json`, a `background.js` that throws before wiring up its
listeners, or the extension failing to load at all.

## Known limitation: no in-page assertions (yet)

What the smoke suite deliberately does **not** do: read anything out of
`cussijn.html`'s own DOM (is the account list populated? did a click
select a cell? etc.). This was attempted and confirmed not to work
against this Thunderbird build, not left out for lack of trying:

- Marionette's normal `window_handles` (the list of content
  tabs/windows it can switch into) comes back **empty** for a tabmail
  `contentTab` - Thunderbird's tab model isn't Firefox's `gBrowser`, and
  its Marionette support appears to have been built out for driving the
  `mail:3pane` chrome window (message list, compose window, etc.), not
  for treating extension content tabs like Firefox tabs.
- `switch_to_frame()` on the tab's own `<browser>` element - the normal
  way to reach into a WebExtension page's content from chrome scope -
  fails with `NoSuchFrameException: Unable to locate frame for element`,
  both for an element returned from `execute_script` and one located via
  `find_element`.
- Reading `browser.contentDocument` directly from chrome script returns
  `null`: the tab's browser is a remote/out-of-process browser
  (`isRemoteBrowser: true`), and forcing single-process mode via
  `MOZ_FORCE_DISABLE_E10S=1` made no difference - extension pages appear
  to always run out-of-process here regardless of that toggle.

Going further (asserting on rendered cell counts, clicking a cell,
checking the filter bar) would need either a JSWindowActor registered
specifically for `cussijn.html`'s content process to bridge chrome
script and the page (real platform-level engineering, not a
`marionette_driver` option), or abandoning Marionette for this part in
favor of a GUI-in-a-container + image/accessibility-based approach (e.g.
`jlesage/docker-thunderbird` over VNC, driven by
`RPA.Desktop`/`SikuliLibrary`) - the alternative this project's earlier
design discussion considered and set aside in favor of trying Marionette
first.

## Mail fixture data

The smoke suite (CI) still runs against a fresh, empty profile - there's
no configured mail account, so nothing meaningful is asserted about what
the treemap actually renders (that's exactly what the DOM-access gap
above blocks anyway; a content-level assertion suite would need this
fixture too, but there'd be nothing to assert against it until that gap
is solved).

But seeded mail data itself now exists:
`e2e/fixtures/generate_fixture.py` writes a throwaway profile's
`prefs.js` (a "Local Folders" account - Thunderbird's own local
mbox-backed account type, no server involved) plus a
`Mail/Local Folders/Inbox` mbox file of entirely synthetic messages -
fake senders, fake subjects, `*.test` domains (IANA-reserved for exactly
this, [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) - nothing
derived from any real mailbox. Two things had to be found live before
this worked at all:

- A raw mbox file dropped into a fresh profile is **not** auto-indexed
  by Thunderbird on startup - `CussijnLibrary.index_local_inbox()` has
  to force it via `nsIMsgLocalMailFolder.parseFolder()` (chrome-only
  XPCOM, unreachable through any `messenger.*` WebExtension API).
- Thunderbird's five default tag keys (`$label1`-`$label5` ->
  Important/Work/Personal/To Do/Later) are built in and don't need
  declaring in `prefs.js` at all.

`e2e/robot/screenshot.robot` (run via `./e2e/screenshot.sh`, **not**
part of `./e2e/run.sh` or CI - there's no reason to regenerate an
identical image on every push) uses this fixture to produce
`docs/screenshot.png` for the README: seeds the fixture, opens the real
extension against it in a real headless Thunderbird, and saves a full
window screenshot (`Marionette.screenshot()` - a WebDriver-level
capability that works at the browser-window level and, unlike
content-DOM access, doesn't run into the gap above at all).

## CI

`.github/workflows/e2e.yml` runs this suite on every push/PR to `main`,
same as `./e2e/run.sh` does locally. It is **not** currently a required
status check for branch protection (unlike CI's `test` job) - it's new,
container-based, and slower, so it's opt-in until it's proven stable
over a few real runs; promote it to required once that's true.
