"""Robot Framework keyword library for driving a REAL Thunderbird over
Marionette - not Firefox, not a mock. See e2e/README.md for why Firefox
can't run this extension at all (no `messenger.*` namespace), and for
what is and isn't actually reachable this way (verified against a real
Thunderbird 140.15.0 ESR build, not assumed).

There is no ready-made "SeleniumLibrary for Thunderbird" - geckodriver
targets Firefox's tabbrowser model, and Thunderbird's tabmail model
turned out (see e2e/README.md's "Known limitation") not to expose its
content tabs the way Marionette expects for its usual window-handle /
switch_to_frame machinery. So this talks to marionette_driver directly
and exposes only the operations actually verified to work: launching
Thunderbird headless, installing the extension's real .xpi temporarily
(no signing needed - the same mechanism `about:debugging`'s "Load
Temporary Add-on" uses), opening its page as a real tabmail contentTab,
and confirming that tab actually navigated to the extension's own URL
(proving the extension loaded and background.js's openOrFocusView-style
tab creation works) rather than erroring out.
"""

import subprocess
import time

from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette

MARIONETTE_PORT = 2828
STARTUP_TIMEOUT_S = 30


class CussijnLibrary:
    # SUITE, not the default TEST - Suite Setup's Start Thunderbird and
    # the test cases that follow must share the same Marionette
    # connection/instance, not get a fresh one each.
    ROBOT_LIBRARY_SCOPE = "SUITE"

    def __init__(self):
        self._proc = None
        self._marionette = None
        self._addon_id = None

    def start_thunderbird(self, profile_dir, log_path="/tmp/thunderbird.log"):
        """Launches a real, headless Thunderbird with Marionette enabled
        against a throwaway profile, and waits for Marionette's port to
        come up. `-remote-allow-system-access` is required for any
        chrome-context script (installing the extension, opening a tab)
        - Thunderbird's own error message says so if you omit it.
        """
        log_file = open(log_path, "w")
        self._proc = subprocess.Popen(
            [
                "thunderbird",
                "-headless",
                "-marionette",
                "-remote-allow-system-access",
                "-no-remote",
                "-profile",
                profile_dir,
            ],
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

        deadline = time.time() + STARTUP_TIMEOUT_S
        while time.time() < deadline:
            try:
                with open(log_path) as f:
                    if "Listening on port" in f.read():
                        break
            except FileNotFoundError:
                pass
            time.sleep(0.5)
        else:
            raise AssertionError(
                f"Thunderbird did not start Marionette within {STARTUP_TIMEOUT_S}s - see {log_path}"
            )

        self._marionette = Marionette(host="127.0.0.1", port=MARIONETTE_PORT)
        self._marionette.start_session()
        self._marionette.set_context("chrome")

        caps = self._marionette.session_capabilities
        if caps.get("browserName") != "thunderbird":
            raise AssertionError(
                f"Expected to connect to thunderbird, got browserName={caps.get('browserName')!r} "
                "- refusing to run extension tests against the wrong application."
            )

    def stop_thunderbird(self):
        if self._marionette is not None:
            try:
                self._marionette.delete_session()
            except Exception:
                pass
            self._marionette = None
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None

    def install_extension_temporarily(self, xpi_path):
        """Installs the real, built .xpi the same way `about:debugging`'s
        "Load Temporary Add-on" does - unsigned, active immediately, and
        automatically removed on shutdown. Returns the addon id."""
        addons = Addons(self._marionette)
        self._addon_id = addons.install(xpi_path, temp=True)
        return self._addon_id

    def extension_should_be_active(self):
        info = self._marionette.execute_async_script(
            """
            let [id, resolve] = arguments;
            (async () => {
              const { AddonManager } = ChromeUtils.importESModule(
                "resource://gre/modules/AddonManager.sys.mjs"
              );
              const addon = await AddonManager.getAddonByID(id);
              resolve(addon ? { id: addon.id, isActive: addon.isActive, version: addon.version } : null);
            })();
            """,
            script_args=[self._addon_id],
        )
        if not info or not info.get("isActive"):
            raise AssertionError(f"Extension is not active: {info}")
        return info

    def open_extension_page(self, page):
        """Opens `moz-extension://<this addon's uuid>/<page>` as a real
        Thunderbird tabmail contentTab - the same mechanism
        background.js's openOrFocusView() uses via messenger.tabs.create,
        just invoked from chrome script instead of from the extension's
        own background page. Returns the resolved moz-extension:// URL.
        """
        url = self._marionette.execute_script(
            """
            const policy = WebExtensionPolicy.getByID(arguments[0]);
            return policy ? policy.getURL(arguments[1]) : null;
            """,
            script_args=[self._addon_id, page],
        )
        if not url:
            raise AssertionError(f"Could not resolve a moz-extension:// URL for {page!r}")

        self._marionette.execute_async_script(
            """
            let [url, resolve] = arguments;
            const win = Services.wm.getMostRecentWindow("mail:3pane");
            const tabmail = win.document.getElementById("tabmail");
            tabmail.openTab("contentTab", { url });
            resolve(true);
            """,
            script_args=[url],
        )

        # openTab() returns before navigation completes (the new tab
        # starts at about:blank) - poll the tab's own currentURI rather
        # than sleeping a fixed guess, since there's no content-side
        # "page loaded" signal reachable here (see the module docstring
        # and e2e/README.md's "Known limitation").
        deadline = time.time() + 10
        last_seen = None
        while time.time() < deadline:
            last_seen = self.get_last_tab_url()
            if last_seen == url:
                break
            time.sleep(0.2)
        else:
            raise AssertionError(
                f"Tab never navigated to {url!r} within 10s (last seen: {last_seen!r})"
            )
        return url

    def get_last_tab_url(self):
        """The currently-loaded URI of the most recently opened tabmail
        tab - NOT a content-context page URL (see e2e/README.md: this
        build's Thunderbird doesn't expose contentTab browsers to
        Marionette's content/window-handle machinery, so there's no
        `Get Title`/`Get Text`-from-inside-the-page here, only this
        chrome-side confirmation that navigation actually succeeded)."""
        return self._marionette.execute_script(
            """
            const win = Services.wm.getMostRecentWindow("mail:3pane");
            const tabmail = win.document.getElementById("tabmail");
            const tab = tabmail.tabInfo[tabmail.tabInfo.length - 1];
            const b = tab.browser || tab.linkedBrowser;
            return b && b.currentURI ? b.currentURI.spec : null;
            """
        )
