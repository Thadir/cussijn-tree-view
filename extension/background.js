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
 * Four ways to open the view, all landing on the same openOrFocusView():
 *   1. The toolbar button (browserAction).
 *   2. A keyboard shortcut (the "open-cussijn-tree-view" command in
 *      manifest.json, Ctrl+Shift+Y by default - user-remappable in
 *      Thunderbird's Add-ons Manager gear menu -> Manage Extension
 *      Shortcuts).
 *   3. Tools menu -> "Cussijn Tree View" - the real top-menu-bar entry
 *      point a WebExtension can actually get (contexts: ["tools_menu"]).
 *      There is no supported way to add an entry to Thunderbird's native
 *      "View" menu specifically - checked against
 *      webextension-api.thunderbird.net's menus docs, whose `contexts`
 *      list has `tools_menu` but nothing for View - so Tools is the
 *      closest real top-menu-bar equivalent, not a consolation prize.
 *   4. Right-click a folder in the folder pane -> "Open in Cussijn Tree
 *      View" - opens already drilled into that folder (see cussijn.js
 *      reading the ?folder= query param).
 */

let viewTabId = null;

async function openOrFocusView(folderId) {
  const url = folderId
    ? browser.runtime.getURL("cussijn.html?folder=" + encodeURIComponent(folderId))
    : browser.runtime.getURL("cussijn.html");
  if (viewTabId != null) {
    try {
      await messenger.tabs.update(viewTabId, { active: true, url });
      return;
    } catch (e) {
      viewTabId = null; // tab was closed since - fall through and open a new one
    }
  }
  const tab = await messenger.tabs.create({ url });
  viewTabId = tab.id;
}

browser.browserAction.onClicked.addListener(() => openOrFocusView());

if (messenger.tabs && messenger.tabs.onRemoved) {
  messenger.tabs.onRemoved.addListener((tabId) => {
    if (tabId === viewTabId) viewTabId = null;
  });
}

if (messenger.commands && messenger.commands.onCommand) {
  messenger.commands.onCommand.addListener((command) => {
    if (command === "open-cussijn-tree-view") openOrFocusView();
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
      openOrFocusView();
    } else if (info.menuItemId === FOLDER_MENU_ID) {
      const folder = info.selectedFolders && info.selectedFolders[0];
      openOrFocusView(folder && folder.id);
    }
  });
}
