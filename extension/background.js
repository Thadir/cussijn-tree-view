/*
 * Cussijn Tree View - background script.
 *
 * Deliberately tiny: this extension has no native-messaging port or any
 * other long-lived connection to keep alive, so its background page is a
 * non-persistent event page (see manifest.json's "persistent": false) -
 * Thunderbird can suspend and wake it freely. cussijn.js calls messenger.*
 * directly for everything else - there is no dispatch table here, because
 * there is no access-control boundary to enforce (no second party is
 * sending this extension commands).
 *
 * Three ways to open the view, all landing on the same openOrFocusView():
 *   1. A keyboard shortcut (the "open-cussijn-tree-view" command in
 *      manifest.json, Ctrl+Shift+Y by default - user-remappable in
 *      Thunderbird's Add-ons Manager gear menu -> Manage Extension
 *      Shortcuts).
 *   2. Tools menu -> "Cussijn Tree View" - the real top-menu-bar entry
 *      point a WebExtension can actually get (contexts: ["tools_menu"]).
 *      There is no supported way to add an entry to Thunderbird's native
 *      "View" menu specifically - checked against
 *      webextension-api.thunderbird.net's menus docs, whose `contexts`
 *      list has `tools_menu` but nothing for View - so Tools is the
 *      closest real top-menu-bar equivalent, not a consolation prize.
 *   3. Right-click a folder in the folder pane -> "Open in Cussijn Tree
 *      View" - opens already drilled into that folder (see cussijn.js
 *      reading the ?folder= query param).
 *
 * No toolbar button (browser_action): it can't reliably resolve the
 * right account from a background script's tab-focus state, and these
 * three entry points already cover the same job.
 */

let viewTabId = null;

// The keyboard shortcut and the Tools-menu entry both open with no
// folder in mind - loadAccounts() then needs to know which account to
// default to, since "no folder in mind" isn't the same as "the first
// account in the profile." mailTabs.query()'s displayedFolder (needs
// accountsRead, already held) gives us that for free. Querying with
// { active: true } alone isn't enough, since the Cussijn Tree View tab
// itself is often what's focused when you reach for the shortcut again,
// and no mail tab is "active" while a content tab has focus - falling
// back to whichever mail tab query() finds at all covers the common
// one-mail-tab-per-window case.
async function currentDisplayedFolderId() {
  try {
    const tabs = await messenger.mailTabs.query({ currentWindow: true });
    const tab = tabs.find((t) => t.active) || tabs[0];
    return tab?.displayedFolder?.id;
  } catch (e) {
    // no mail tab to read a folder from - open with no folder in mind
    return undefined;
  }
}

async function openOrFocusView(folderId) {
  const url = folderId
    ? browser.runtime.getURL("cussijn.html?folder=" + encodeURIComponent(folderId))
    : browser.runtime.getURL("cussijn.html");
  if (viewTabId != null) {
    try {
      await messenger.tabs.update(viewTabId, { active: true, url });
      return;
    } catch (e) {
      // tab was closed since - fall through and open a new one
      viewTabId = null;
    }
  }
  const tab = await messenger.tabs.create({ url });
  viewTabId = tab.id;
}

if (messenger.tabs?.onRemoved) {
  messenger.tabs.onRemoved.addListener((tabId) => {
    if (tabId === viewTabId) viewTabId = null;
  });
}

if (messenger.commands?.onCommand) {
  messenger.commands.onCommand.addListener(async (command) => {
    if (command === "open-cussijn-tree-view") openOrFocusView(await currentDisplayedFolderId());
  });
}

const FOLDER_MENU_ID = "cussijn-open-folder";
const TOOLS_MENU_ID = "cussijn-open-tools-menu";

if (messenger.menus) {
  // menus.create() throws "duplicate id" if this event page wakes and
  // re-registers an id Thunderbird already has - harmless, so it's
  // swallowed rather than guarded with a first-run flag this
  // non-persistent page can't reliably keep across suspends anyway.
  const ignoreDuplicateId = () => void browser.runtime.lastError;
  messenger.menus.create(
    { id: FOLDER_MENU_ID, title: "Open in Cussijn Tree View", contexts: ["folder_pane"] },
    ignoreDuplicateId
  );
  messenger.menus.create(
    { id: TOOLS_MENU_ID, title: "Cussijn Tree View", contexts: ["tools_menu"] },
    ignoreDuplicateId
  );
  messenger.menus.onClicked.addListener((info) => {
    if (info.menuItemId === TOOLS_MENU_ID) {
      currentDisplayedFolderId().then(openOrFocusView);
    } else if (info.menuItemId === FOLDER_MENU_ID) {
      const folder = info.selectedFolders?.[0];
      openOrFocusView(folder?.id);
    }
  });
}
