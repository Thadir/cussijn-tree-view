/*
 * Cussijn Tree View - the treemap itself.
 *
 * The name winks at "cushion treemaps" (van Wijk & van de Wetering,
 * 1999, TU Eindhoven) - the shading technique real SequoiaView (also
 * from that group) is known for - via "cussijn," an archaic Dutch
 * spelling of "cushion." This is a squarified treemap (Bruls, Huizing,
 * van Wijk, 2000 - see squarify()) of the mailbox's folder structure,
 * sized by message count or MB, with hover detail, a filter bar (tag
 * OR-selection, address-text search), a switchable coloring/grouping
 * dimension (tag / sender domain / To-Cc-Bcc), a "jump to search"
 * action that opens a real Thunderbird mail tab with the same filter
 * applied via mailTabs.setQuickFilter(), and recursive drill-down that
 * mirrors the account's REAL folder tree first (buildFolderTree() - a
 * folder's own real subfolders, arbitrarily deep, the way real
 * SequoiaView opens a directory into its actual subdirectories) and
 * then, once that bottoms out at a leaf folder, keeps drilling by
 * content: the active Group-by dimension -> sender -> message ->
 * (terminal) - "message" being the actual bottom of this data, one cell
 * per email (see groupMessages()/nextDimension()). A "Depth" control
 * (initUi()'s `depth`/layoutTree()) shows that many levels NESTED at
 * once starting from the current view, rather than forcing one click
 * per level - depth 1 is the original click-only behavior; clicking any
 * cell, at any depth, still drills the whole view one step further in.
 *
 * Calls messenger.accounts/messenger.messages/messenger.mailTabs
 * directly - there is no second party to relay through and no
 * access-control boundary to enforce here (no dispatch table, because
 * there's no external caller a dispatch table would need to gate).
 * Reading mail is exactly the permission the user already granted at
 * install.
 *
 * Also runs under plain Node for cussijn.test.js (module.exports guard
 * at the bottom) - the pure layout/aggregation/filter/color functions
 * are what's worth unit-testing; DOM wiring and the real messenger.*
 * calls are not.
 */

const PALETTE_ORDER = [
  "#2a78d6", "#eb6834", "#e87ba4", "#4a3aa7", "#1baf7a", "#008300", "#9085e9", "#eda100",
  "#e34948", "#17a589", "#d55181", "#6b6a66", "#0c8f6a", "#8c7853", "#c98500", "#5598e7",
];
const UNCATEGORIZED_COLOR = "#898781";
const EMPTY_LABEL = "Empty";
const ADDRESS_TYPES = ["Direct (To)", "Cc", "Bcc", "Other"];

function folderName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function assignPalette(tagNames) {
  const palette = { Uncategorized: UNCATEGORIZED_COLOR, [EMPTY_LABEL]: "#5a5a57" };
  tagNames.forEach((name, i) => { palette[name] = PALETTE_ORDER[i % PALETTE_ORDER.length]; });
  return palette;
}

// A stable (not re-randomized every render), automatically-distinct
// color per arbitrary string - used for the "group by domain" coloring
// mode, where the set of domains isn't known ahead of time the way the
// tag list is. Same domain always gets the same color, this run and
// next; different domains land at different, evenly-spread hues.
function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 58%, 46%)`;
}

function extractEmail(addr) {
  const m = /<([^<>]+)>/.exec(addr || "");
  return (m ? m[1] : addr || "").trim().toLowerCase();
}

function senderDomain(author) {
  const email = extractEmail(author);
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}

// Every address field a message carries, concatenated and lowercased -
// the one place "does this message involve paypal.com at all" gets
// answered, whether paypal.com shows up as the sender, a To, a Cc, or a
// Bcc. Matching only From (an earlier version of this file did) misses
// e.g. a receipt where paypal.com is Cc'd rather than the sender.
function allAddressText(m) {
  return [m.author, ...(m.recipients || []), ...(m.ccList || []), ...(m.bccList || [])]
    .filter(Boolean).join(" ").toLowerCase();
}

// Classifies a message by how the mailbox owner was addressed:
// "Direct (To)" if one of myAddresses is in the To list, "Cc"/"Bcc" if
// only there, "Other" if none of the owner's own addresses appear at
// all (a mailing list post, a Bcc the account can't see itself in,
// etc.) - myAddresses comes from the current account's identities.
function classifyAddressType(message, myAddresses) {
  const mine = new Set((myAddresses || []).map((a) => a.toLowerCase()));
  if (!mine.size) return "Other";
  const matches = (list) => (list || []).some((addr) => mine.has(extractEmail(addr)));
  if (matches(message.recipients)) return "Direct (To)";
  if (matches(message.ccList)) return "Cc";
  if (matches(message.bccList)) return "Bcc";
  return "Other";
}

// Client-side pre-filter, applied to the raw message list before
// buildFolderTree(): narrows the whole treemap to what actually
// matches, rather than just dimming cells.
//   tagKeys: raw tag keys (e.g. "$cat_banking") - a message must carry
//            at least one (OR across a multi-tag selection, matching
//            mailTabs.setQuickFilter's {mode:"any"} semantics used
//            later for the same filter).
//   addressText: substring match against From + To + Cc + Bcc combined
//            (see allAddressText) - so filtering by a domain like
//            "paypal.com" catches it in any address role, not just as
//            sender.
// A message must satisfy every filter TYPE that's active (tags AND
// address), but within a type, any match is enough (OR) - standard
// facet-filter behavior.
function applyFilters(messages, filters) {
  filters = filters || {};
  const tagKeys = filters.tagKeys || [];
  const addressText = (filters.addressText || "").toLowerCase().trim();

  return messages.filter((m) => {
    if (tagKeys.length) {
      const mTags = m.tags || [];
      if (!tagKeys.some((t) => mTags.includes(t))) return false;
    }
    if (addressText && !allAddressText(m).includes(addressText)) return false;
    return true;
  });
}

function topEntries(counter, n) {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n || Infinity);
}

// Tallies a message list into THREE independent breakdowns at once (tag,
// sender domain, address type) so switching the "color by" dimension in
// the UI is just a re-render, not a re-fetch. `tagLabels` maps a raw tag
// key to a display name; `myAddresses` (the current account's own
// identity emails) drives the address-type breakdown - pass [] if
// unknown, everything then falls back to "Other". Shared by every level
// of the folder tree (buildFolderTree) - a parent folder's breakdown is
// over its whole subtree's messages, not just its own.
function computeBreakdowns(messages, tagLabels, myAddresses) {
  tagLabels = tagLabels || {};
  myAddresses = myAddresses || [];
  const tagCounts = new Map();
  const domainCounts = new Map();
  const addressTypeCounts = new Map();
  for (const m of messages) {
    for (const t of m.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    const domain = senderDomain(m.author) || "(unknown)";
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    const addrType = classifyAddressType(m, myAddresses);
    addressTypeCounts.set(addrType, (addressTypeCounts.get(addrType) || 0) + 1);
  }

  const sortedTags = topEntries(tagCounts);
  const dominantTagKey = sortedTags.length ? sortedTags[0][0] : null;
  const dominantTag = dominantTagKey ? (tagLabels[dominantTagKey] || dominantTagKey) : "Uncategorized";
  const tagBreakdown = {};
  for (const [t, c] of sortedTags) tagBreakdown[tagLabels[t] || t] = c;

  const sortedDomains = topEntries(domainCounts);
  const dominantDomain = sortedDomains.length ? sortedDomains[0][0] : "(unknown)";
  const domainBreakdown = Object.fromEntries(sortedDomains);

  const sortedAddressTypes = topEntries(addressTypeCounts);
  const dominantAddressType = sortedAddressTypes.length ? sortedAddressTypes[0][0] : "Other";
  const addressTypeBreakdown = Object.fromEntries(sortedAddressTypes);

  return {
    dominantTag, dominantTagKey, tagBreakdown,
    dominantDomain, domainBreakdown,
    dominantAddressType, addressTypeBreakdown,
  };
}

// Turns Thunderbird's REAL folder hierarchy (an account's rootFolder,
// with subFolders populated recursively - see accounts.list(true) in
// realListAccounts()) into a treemap-ready tree: one node per real
// folder, nested exactly the way the account's own folder pane nests
// them - not the flat "one entry per distinct full path" an earlier
// version of this file built, which showed a folder and its own
// subfolder as unrelated siblings instead of parent and child.
//
// A node's `messages` is the recursive union of its own direct messages
// plus every descendant folder's messages, so a parent's size and color
// reflect its whole subtree - the same convention a real disk-usage
// view uses (a directory's size includes its subdirectories'). A folder
// that has BOTH its own direct messages AND real subfolders gets one
// extra "(direct in this folder)" child so neither is silently folded
// into the other; a folder with no subfolders at all just has its own
// messages as its full content, same as before. Folders (and subtrees)
// with zero messages anywhere in them are dropped, same as the old
// behavior of only ever showing folders that actually matched something.
function buildFolderTree(rootFolder, messages, tagLabels, myAddresses) {
  const byFolderId = new Map();
  for (const m of messages) {
    const id = m.folder && m.folder.id;
    if (!id) continue;
    if (!byFolderId.has(id)) byFolderId.set(id, []);
    byFolderId.get(id).push(m);
  }

  function makeNode(folderId, path, label, allMessages, children) {
    let sizeBytes = 0;
    for (const m of allMessages) sizeBytes += m.size || 0;
    return {
      dimension: "folder",
      folderId,
      path,
      label,
      messages: allMessages,
      count: allMessages.length,
      size_mb: Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
      children,
      ...computeBreakdowns(allMessages, tagLabels, myAddresses),
    };
  }

  function build(folder) {
    const ownMessages = byFolderId.get(folder.id) || [];
    const children = (folder.subFolders || []).map(build).filter((c) => c.count > 0);
    // Computed from `children` before the synthetic node below is added
    // to it - that node's `messages` IS `ownMessages`, so adding it
    // first and then summing children's `.messages` would double-count
    // every direct message once as ownMessages and once via the child.
    const allMessages = ownMessages.concat(...children.map((c) => c.messages));

    if (ownMessages.length && children.length) {
      children.push(makeNode(folder.id, folder.path, "(direct in this folder)", ownMessages, []));
      children.sort((a, b) => b.count - a.count);
    }

    return makeNode(folder.id, folder.path, folder.name, allMessages, children);
  }

  return (rootFolder.subFolders || [])
    .map(build)
    .filter((n) => n.count > 0)
    .sort((a, b) => b.count - a.count);
}

// Depth-first search for the ancestor chain (root..target, inclusive)
// leading to a given real folder id, through a tree built by
// buildFolderTree() - used to auto-drill to a specific folder (e.g. from
// background.js's folder-pane context menu entry) by replaying
// drillInto() once per ancestor, so the breadcrumb ends up showing the
// real path instead of jumping there with no trail to climb back out on.
function findFolderPath(nodes, folderId) {
  for (const n of nodes) {
    if (n.folderId === folderId) return [n];
    if (n.children && n.children.length) {
      const sub = findFolderPath(n.children, folderId);
      if (sub) return [n, ...sub];
    }
  }
  return null;
}

// Picks which precomputed dimension a node is grouped/colored by right
// now - "tag" | "domain" | "addressType" - returning {group, breakdown}
// so render()/legend/tooltip don't need a big switch each time.
function groupFor(node, mode) {
  if (mode === "domain") return { group: node.dominantDomain, breakdown: node.domainBreakdown };
  if (mode === "addressType") return { group: node.dominantAddressType, breakdown: node.addressTypeBreakdown };
  return { group: node.dominantTag, breakdown: node.tagBreakdown };
}

// --- recursive drill-down, past the folder tree: content dimension -> sender ---
//
// buildFolderTree()/findFolderPath() (above) handle the first stretch of
// drilling - real subfolder -> real subfolder, exactly following the
// account's own folder structure, arbitrarily deep, the way real
// SequoiaView opens a directory into its actual subdirectories. Once
// that bottoms out (a folder with no real subfolders left, or the
// synthetic "(direct in this folder)" leaf - see drillInto()), THESE
// four functions take over: each further click regroups the SAME
// underlying message subset by a finer *content* dimension instead of a
// structural one, and every resulting node keeps its own `messages` so
// it can be drilled again.

// After a folder-tree leaf (currentDimension === null) the next level is
// whichever dimension "Group by" is currently set to - so drilling
// shows the same breakdown the treemap is already colored by, not an
// unrelated fixed one. After that: sender, then "message" - the actual
// bottom of this data (one cell per email) - then terminal.
function nextDimension(currentDimension, groupBy) {
  if (currentDimension === null || currentDimension === undefined) return groupBy;
  if (currentDimension === "sender") return "message";
  if (currentDimension === "message") return null;
  return "sender";
}

// The key a single message groups under for a given dimension. Tag
// grouping uses the message's first tag (or "" as the Uncategorized
// sentinel) rather than every tag it carries, so a drill level is a
// true partition (each message in exactly one cell) - contrast
// computeBreakdowns()'s tagBreakdown, which is a non-exclusive tally
// used only for the tooltip/legend at the folder level. "message" uses
// the message's own id, unique per message by construction - a message
// dimension's groups are always singletons.
function groupKeyFor(message, dimension, myAddresses) {
  if (dimension === "tag") return (message.tags || [])[0] || "";
  if (dimension === "domain") return senderDomain(message.author) || "(unknown)";
  if (dimension === "addressType") return classifyAddressType(message, myAddresses);
  if (dimension === "sender") return message.author || "(unknown)";
  if (dimension === "message") return message.id != null ? String(message.id) : `${message.author}|${message.subject}|${message.date}`;
  return "(unknown)";
}

// The DISPLAYED text for a group. Only "message" needs the actual
// message (its subject) rather than the key alone - `sampleMessage` is
// any one message from that group (message groups are always
// singletons, so it's simply that message).
function labelForKey(dimension, key, tagLabels, sampleMessage) {
  if (dimension === "tag") return key ? (tagLabels[key] || key) : "Uncategorized";
  if (dimension === "message") return (sampleMessage && sampleMessage.subject) || "(no subject)";
  return key;
}

// What colorForKey() should actually key off for a group. For every
// dimension except "message" this is the same string as the label
// (colorForKey's tag branch looks a label up in tagPalette, which is
// keyed by display name - not the raw tag key). "message" is the one
// exception: its label is the subject (unique per cell, useless for
// coloring), so a message cell colors by its own sender instead -
// visually clustering one sender's emails by hue even at the bottom
// level, the same hashColor() a "Sender domain"/sender-level cell uses.
function colorKeyFor(dimension, key, tagLabels, sampleMessage) {
  if (dimension === "message") return (sampleMessage && sampleMessage.author) || "(unknown)";
  return labelForKey(dimension, key, tagLabels);
}

// A dimension with many distinct groups (hundreds of senders, or every
// message in a large folder) would otherwise turn into one treemap cell
// PER group - hundreds of slivers, slow to lay out and useless to look
// at. Past this many, the smallest groups fold into one "(N more)" node
// instead of getting a cell each; the biggest count - 1 groups still
// show individually since those are what's actually worth seeing.
// "message" gets a much LOWER cap than every other dimension: unlike a
// domain or sender breakdown (sizes vary, so seeing many is genuinely
// informative), every individual message has the same count (1) - a
// wall of 199 identically-tiny tiles reads no better than a wall of 39,
// it's just slower to lay out and harder to click the right one.
const MAX_GROUP_NODES = 200;
const MAX_MESSAGE_NODES = 40;

// Regroups a message list by one dimension, one node per distinct key,
// each carrying its own message subset (so the result can be drilled
// into again) plus count/size for sizing and a jumpFilter-ready key.
function groupMessages(messages, dimension, tagLabels, myAddresses) {
  tagLabels = tagLabels || {};
  myAddresses = myAddresses || [];
  const byKey = new Map();
  for (const m of messages) {
    const key = groupKeyFor(m, dimension, myAddresses);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }

  const cap = dimension === "message" ? MAX_MESSAGE_NODES : MAX_GROUP_NODES;
  let entries = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length);
  let overflow = [];
  if (entries.length > cap) {
    overflow = entries.slice(cap - 1);
    entries = entries.slice(0, cap - 1);
  }

  const nodes = entries.map(([key, items]) => {
    let sizeBytes = 0;
    for (const m of items) sizeBytes += m.size || 0;
    return {
      dimension,
      groupKey: key,
      label: labelForKey(dimension, key, tagLabels, items[0]),
      colorKey: colorKeyFor(dimension, key, tagLabels, items[0]),
      messages: items,
      count: items.length,
      size_mb: Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
    };
  });

  if (overflow.length) {
    const restMessages = [].concat(...overflow.map(([, items]) => items));
    let sizeBytes = 0;
    for (const m of restMessages) sizeBytes += m.size || 0;
    nodes.push({
      dimension,
      groupKey: null,
      colorKey: null, // colorForKey() treats a null key as the muted "nothing specific" color
      label: `(${restMessages.length} more)`,
      messages: restMessages,
      count: restMessages.length,
      size_mb: Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
      isOverflow: true,
    });
  }

  return nodes.sort((a, b) => b.count - a.count);
}

// What refining "go to search" down to one drill node's group should
// add to the currently active filters. Tag and domain/sender all map
// onto a real mailTabs.setQuickFilter() facet; address-type and message
// have none - Thunderbird's quick filter has no "was this a Cc" match
// (see buildQuickFilterProps) and no "is exactly this one message"
// match either, so drilling into either can't narrow the search any
// further than the folder's own current filters.
function jumpFilterFor(dimension, groupKey) {
  if (dimension === "tag") return groupKey ? { tagKeys: [groupKey] } : {};
  if (dimension === "domain" || dimension === "sender") return { addressText: groupKey };
  return {};
}

// Color for one drill-level node (or a folder-level node's current
// group, called with `key` already resolved by groupFor) - `key` is
// always in display-label form, since that's what tagPalette (built
// from tag display names) is keyed by, and every other dimension's key
// equals its own label (see colorKeyFor() for the one exception,
// "message"). A null key (groupMessages()'s overflow "(N more)" node)
// gets the same muted color as an untagged/empty cell - it isn't a real
// category, just "everything past the cap".
function colorForKey(dimension, key, tagPalette) {
  if (key === EMPTY_LABEL || key == null) return "#5a5a57";
  if (dimension === "domain" || dimension === "sender" || dimension === "message") return hashColor(key);
  if (dimension === "addressType") {
    const idx = ADDRESS_TYPES.indexOf(key);
    return idx === -1 ? UNCATEGORIZED_COLOR : PALETTE_ORDER[idx % PALETTE_ORDER.length];
  }
  return (tagPalette && tagPalette[key]) || UNCATEGORIZED_COLOR;
}

// Squarified treemap layout (Bruls/Huizing/van Wijk). Pure function:
// takes {value}-bearing nodes and a rectangle, returns {node, x, y, w, h}.
function squarify(inputNodes, x, y, w, h) {
  const total = inputNodes.reduce((s, n) => s + n.value, 0) || 1;
  const scale = (w * h) / total;
  const sorted = [...inputNodes].sort((a, b) => b.value - a.value).map(n => ({ ...n, area: n.value * scale }));
  const rects = [];

  function worst(row, length) {
    if (!row.length) return Infinity;
    const sum = row.reduce((s, n) => s + n.area, 0);
    const maxA = Math.max(...row.map(n => n.area));
    const minA = Math.min(...row.map(n => n.area));
    return Math.max((length * length * maxA) / (sum * sum), (sum * sum) / (length * length * minA));
  }
  // A row is always built along the remaining rectangle's SHORTER side -
  // that's what keeps its cells close to square:
  //   wide (rect is wider than tall): the shorter side is the height,
  //     so a row is a VERTICAL COLUMN spanning the full height, its own
  //     width is sum(areas)/height, and its items stack top-to-bottom
  //     inside it.
  //   !wide (taller than wide): the shorter side is the width, so a row
  //     is a HORIZONTAL BAND spanning the full width, its own height is
  //     sum(areas)/width, and its items sit left-to-right inside it.
  function layoutRow(row, wide, rx, ry, rw, rh) {
    const sum = row.reduce((s, n) => s + n.area, 0);
    if (wide) {
      const colW = sum / rh;
      let cy = ry;
      for (const n of row) {
        const cellH = n.area / colW;
        rects.push({ node: n, x: rx, y: cy, w: colW, h: cellH });
        cy += cellH;
      }
    } else {
      const rowH = sum / rw;
      let cx = rx;
      for (const n of row) {
        const cellW = n.area / rowH;
        rects.push({ node: n, x: cx, y: ry, w: cellW, h: rowH });
        cx += cellW;
      }
    }
  }

  let cx = x, cy = y, cw = w, ch = h;
  let remaining = sorted;
  while (remaining.length) {
    const wide = cw >= ch;
    const length = wide ? ch : cw; // the shorter side, fixed while scoring candidate rows
    let i = 1;
    const currentRow = [remaining[0]];
    while (i < remaining.length && worst(currentRow, length) >= worst([...currentRow, remaining[i]], length)) {
      currentRow.push(remaining[i]);
      i++;
    }
    const rowSum = currentRow.reduce((s, n) => s + n.area, 0);
    // The row's thickness ALONG THE DIMENSION IT CONSUMES: a width when
    // `wide` (a column eating into cw), a height otherwise (a band
    // eating into ch) - the opposite of `length` above, which is the
    // FIXED perpendicular side used only for worst()'s scoring. An
    // earlier version of this function conflated the two - it correctly
    // used the shorter side for `length`/scoring, but then reused
    // `wide`'s condition backwards for the actual layout (building a
    // full-width band whenever wide==true instead of a full-height
    // column), which - self-consistently, so no test caught it with
    // simple 2-3-node cases - produced a real column/band every row but
    // always the WRONG orientation for the container's own shape. Once
    // one side starts shrinking, that self-reinforces (the container
    // gets progressively more lopsided in the same direction every
    // iteration), degenerating into a single-item-per-row stack with
    // grotesque aspect ratios on any real, more-than-a-few-items,
    // non-square dataset - exactly what surfaced live in Thunderbird,
    // not in the unit tests. See "squarify orientation" test below.
    const rowThickness = wide ? rowSum / ch : rowSum / cw;
    layoutRow(currentRow, wide, cx, cy, wide ? rowThickness : cw, wide ? ch : rowThickness);
    if (wide) { cx += rowThickness; cw -= rowThickness; }
    else { cy += rowThickness; ch -= rowThickness; }
    remaining = remaining.slice(currentRow.length);
  }
  return rects;
}

// Build the mailTabs.setQuickFilter() properties for a given filter
// selection - pure function, so the exact shape sent to Thunderbird's
// real API is unit-testable without a live mailTabs mock.
function buildQuickFilterProps(filters) {
  filters = filters || {};
  const tagKeys = filters.tagKeys || [];
  const addressText = (filters.addressText || "").trim();
  const props = {};
  if (tagKeys.length) {
    const tags = {};
    for (const k of tagKeys) tags[k] = true;
    props.tags = { mode: "any", tags };
  }
  if (addressText) {
    // author (From) + recipients (To/Cc/Bcc combined) together, so the
    // real search view matches the same From-or-To-or-Cc-or-Bcc scope
    // applyFilters() already used to build the treemap itself.
    props.text = { text: addressText, author: true, recipients: true };
  }
  props.show = Object.keys(props).length > 0;
  return props;
}

// --- the real boundaries: reading mail, and jumping to a search view. -----
// Swappable for tests.

async function realQueryAllMessages(accountId) {
  let list = await messenger.messages.query({ accountId, includeSubFolders: true });
  const all = [];
  while (list) {
    all.push(...list.messages);
    if (list.id) list = await messenger.messages.continueList(list.id);
    else break;
  }
  return all;
}
async function realListTags() {
  const tags = await messenger.messages.listTags();
  const map = {};
  for (const t of tags) map[t.key] = t.tag;
  return map;
}
async function realListAccounts() {
  // The boolean asks Thunderbird to populate each account's
  // rootFolder.subFolders recursively (nested, not flat) - this is the
  // real folder tree buildFolderTree() drills through. It does NOT
  // control identities (verified against webextension-api.thunderbird.net
  // - an earlier version of this comment claimed otherwise): every
  // MailAccount always carries its own `identities`, used for
  // myAddresses regardless of this flag.
  return messenger.accounts.list(true);
}

let jumpTabId = null;
async function realOpenFolderSearch(folderId, filters) {
  let tab = null;
  if (jumpTabId != null) {
    try {
      tab = await messenger.mailTabs.update(jumpTabId, { displayedFolder: folderId });
    } catch (e) {
      jumpTabId = null;
    }
  }
  if (!tab) {
    tab = await messenger.mailTabs.create({ displayedFolder: folderId });
    jumpTabId = tab.id;
  }
  await messenger.mailTabs.setQuickFilter(jumpTabId, buildQuickFilterProps(filters));
}

let queryAllMessagesImpl = realQueryAllMessages;
let listTagsImpl = realListTags;
let listAccountsImpl = realListAccounts;
let openFolderSearchImpl = realOpenFolderSearch;

// --- DOM wiring (real extension page only) ------------------------------

function initUi() {
  const statusEl = document.getElementById("status");
  const treemapEl = document.getElementById("treemap");
  const legendEl = document.getElementById("legend");
  const tooltipEl = document.getElementById("tooltip");
  const breadcrumbEl = document.getElementById("breadcrumb");
  const accountSelect = document.getElementById("account-select");
  const tagFiltersEl = document.getElementById("tag-filters");
  const addressInput = document.getElementById("address-filter");
  const filterCountEl = document.getElementById("filter-count");
  const clearFiltersBtn = document.getElementById("clear-filters");
  const groupByEls = {
    tag: document.getElementById("group-tag"),
    domain: document.getElementById("group-domain"),
    addressType: document.getElementById("group-address-type"),
  };
  const depthValueEl = document.getElementById("depth-value");

  let sizeMode = "count";
  let groupBy = "tag";
  // How many levels to show NESTED at once, starting from the current
  // stack's top level - depth 1 reproduces the original click-per-level
  // behavior exactly; anything higher draws each level's children
  // inside their own parent's cell (see layoutTree()), the way real
  // SequoiaView shows several levels of a directory tree in one static
  // picture rather than forcing a click per level. Clicking a cell
  // always still drills the stack forward by one step regardless of
  // depth - depth only changes how much is visible without clicking.
  let depth = 2;
  let stack = [];
  let accounts = [];
  let currentAccountId = null;
  let allMessages = [];
  let tagLabels = {};
  let myAddresses = [];
  let selectedTagKeys = new Set();
  // Set by background.js's folder-pane context menu entry
  // ("Open in Cussijn Tree View" -> cussijn.html?folder=<id>") so the
  // view opens already drilled into the folder that was right-clicked,
  // instead of always landing on the full "All folders" level. Consumed
  // once, by the first rebuild() after load - a later manual refresh or
  // filter change starts back over at the folder level like any other.
  let pendingFolderId = new URLSearchParams(location.search).get("folder");

  function fmtSize(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB"; }

  function currentFilters() {
    return { tagKeys: [...selectedTagKeys], addressText: addressInput.value };
  }

  function filterCount() {
    const f = currentFilters();
    return f.tagKeys.length + (f.addressText.trim() ? 1 : 0);
  }

  async function loadAccounts() {
    accounts = await listAccountsImpl(); // includes each account's real rootFolder.subFolders tree
    accountSelect.innerHTML = "";
    for (const a of accounts) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name;
      accountSelect.appendChild(opt);
    }
    if (accounts.length) {
      currentAccountId = accounts[0].id;
      myAddresses = (accounts[0].identities || []).map((i) => i.email).filter(Boolean);
    }
  }

  async function loadData() {
    statusEl.textContent = "Loading...";
    statusEl.hidden = false;
    try {
      const [messages, labels] = await Promise.all([
        queryAllMessagesImpl(currentAccountId),
        listTagsImpl(),
      ]);
      allMessages = messages;
      tagLabels = labels;
      renderTagFilterChips();
      rebuild();
      statusEl.hidden = true;
    } catch (e) {
      statusEl.hidden = false;
      statusEl.textContent = "Error: " + ((e && e.message) || e);
    }
  }

  function rebuild() {
    const filtered = applyFilters(allMessages, currentFilters());
    const account = accounts.find((a) => a.id === currentAccountId);
    const nodes = account ? buildFolderTree(account.rootFolder, filtered, tagLabels, myAddresses) : [];
    // A groupBy/filter change starts back over at the folder level -
    // any drill-down was into the previous nodes, which no longer exist.
    stack = [{ label: "All folders", nodes: withValue(nodes) }];
    updateFilterUi();
    if (pendingFolderId) {
      const path = findFolderPath(stack[0].nodes, pendingFolderId);
      pendingFolderId = null;
      if (path) {
        // Replays drillInto() once per ancestor so the breadcrumb ends
        // up showing the real path, not a single jump with no trail.
        for (const node of path) drillInto(node);
        return; // the last drillInto() already rendered
      }
    }
    render();
  }

  function withValue(nodes) {
    return nodes.map(n => ({ ...n, value: (sizeMode === "count" ? n.count : n.size_mb) || 0.01 }));
  }

  let tagPalette = { Uncategorized: UNCATEGORIZED_COLOR };

  function renderTagFilterChips() {
    tagFiltersEl.innerHTML = "";
    const names = Object.entries(tagLabels).sort((a, b) => a[1].localeCompare(b[1]));
    tagPalette = assignPalette(names.map(([, label]) => label));
    for (const [key, label] of names) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      const dot = document.createElement("span");
      dot.className = "dot";
      const swatchColor = tagPalette[label];
      dot.style.background = swatchColor;
      chip.append(dot, document.createTextNode(label));
      chip.addEventListener("click", () => {
        if (selectedTagKeys.has(key)) selectedTagKeys.delete(key);
        else selectedTagKeys.add(key);
        chip.classList.toggle("selected", selectedTagKeys.has(key));
        chip.style.background = selectedTagKeys.has(key) ? swatchColor : "";
        rebuild();
      });
      tagFiltersEl.appendChild(chip);
    }
  }

  function updateFilterUi() {
    const count = filterCount();
    filterCountEl.hidden = count === 0;
    filterCountEl.textContent = `${count} active`;
    clearFiltersBtn.hidden = count === 0;
  }

  // What one more level of drill-down looks like for a node, without
  // touching the stack - shared by drillInto() (a click, pushed onto the
  // stack) and layoutTree()'s inline "show N levels at once" expansion,
  // so both agree on exactly what's "inside" a given cell.
  function nextLevelNodes(n) {
    if (n.dimension === "folder" && n.children && n.children.length) {
      // A real folder with real subfolders (or the synthetic "(direct in
      // this folder)" entry alongside them) - drill structurally, into
      // Thunderbird's own folder tree, exactly like opening a
      // subdirectory in real SequoiaView. This can recurse arbitrarily
      // deep, following whatever the account's own folder nesting is,
      // not a fixed number of levels.
      return withValue(n.children.map((c) => ({ ...c })));
    }

    // A leaf folder (no real subfolders left) or a content-dimension
    // node: regroup its own messages one step finer instead - see the
    // comment above nextDimension().
    const currentDim = n.dimension === "folder" ? null : n.dimension;
    const next = nextDimension(currentDim, groupBy);
    if (!next || !n.messages || !n.messages.length) return [];

    const grouped = groupMessages(n.messages, next, tagLabels, myAddresses);
    return withValue(grouped).map((g) => ({
      ...g,
      folderId: n.folderId, // "go to search" always targets the folder we're inside
      // Refines the filters already active, rather than replacing them -
      // drilling into one domain should narrow, not lose, an active tag
      // filter.
      jumpFilter: { ...currentFilters(), ...jumpFilterFor(next, g.groupKey) },
    }));
  }

  // Gaps left around a cell's own edge when its children are drawn
  // nested inside it, and the minimum size a cell needs before it's
  // worth expanding further - below this it'd just be unreadable
  // slivers, so it stays collapsed (still drillable by a click).
  const NEST_INSET = 6;
  const MIN_EXPANDABLE_W = 70;
  const MIN_EXPANDABLE_H = 50;

  // Squarifies `nodes` into [x,y,w,h] and, for any cell with
  // `levelsLeft` > 1 and children, recurses INTO that cell's own
  // rectangle (inset by NEST_INSET) for its children - producing one
  // FLAT list of {node,x,y,w,h,depthIndex,hasInlineChildren} entries all
  // in the SAME coordinate space as the outer container, so every level
  // can be drawn as a plain sibling <div> (no nested DOM, no
  // measurement/reflow needed to position an inner level).
  function layoutTree(nodes, x, y, w, h, levelsLeft, depthIndex) {
    const rects = squarify(nodes.filter((n) => n.value > 0), x, y, w, h);
    const out = [];
    for (const r of rects) {
      // Never auto-expand FROM sender level INTO individual messages via
      // Depth - a sender can have hundreds of messages, all the same
      // size (count 1 each), so inline-expanding them produces one huge
      // near-blank "(N more)" overflow cell plus a wall of same-size
      // tiles: no more informative than the sender cell alone, and much
      // slower to lay out. Message-level detail stays a deliberate click
      // (drillInto()) regardless of how high Depth is set.
      const canExpand = levelsLeft > 1 && r.node.dimension !== "sender"
        && r.w >= MIN_EXPANDABLE_W && r.h >= MIN_EXPANDABLE_H;
      const kids = canExpand ? nextLevelNodes(r.node) : [];
      out.push({ node: r.node, x: r.x, y: r.y, w: r.w, h: r.h, depthIndex, hasInlineChildren: kids.length > 0 });
      if (kids.length) {
        out.push(...layoutTree(
          kids, r.x + NEST_INSET, r.y + NEST_INSET, r.w - NEST_INSET * 2, r.h - NEST_INSET * 2,
          levelsLeft - 1, depthIndex + 1
        ));
      }
    }
    return out;
  }

  function render() {
    const level = stack[stack.length - 1];
    const rect = treemapEl.getBoundingClientRect();
    const nodes = level.nodes.filter(n => n.value > 0);
    const flat = layoutTree(nodes, 0, 0, rect.width || 800, rect.height || 400, depth, 0);

    treemapEl.innerHTML = "";
    for (const entry of flat) {
      const n = entry.node;
      // Folder-level nodes still carry all three switchable breakdowns
      // (groupFor picks the one Group-by is set to); a drill-level node
      // (from groupMessages) is already a single dimension/key, colored
      // via its own colorKey (see colorKeyFor()).
      const isFolderLevel = n.dimension === "folder";
      const dimension = isFolderLevel ? groupBy : n.dimension;
      const { group, breakdown } = isFolderLevel ? groupFor(n, groupBy) : { group: n.label, breakdown: null };
      const colorGroup = isFolderLevel ? group : n.colorKey;
      const isEmpty = group === EMPTY_LABEL;
      const div = document.createElement("div");
      div.className = "cell" + (isEmpty ? " empty" : "") + (entry.w < 46 || entry.h < 34 ? " tiny" : "");
      div.style.left = entry.x + "px";
      div.style.top = entry.y + "px";
      div.style.width = Math.max(entry.w - 2, 0) + "px";
      div.style.height = Math.max(entry.h - 2, 0) + "px";
      if (!isEmpty) div.style.background = colorForKey(dimension, colorGroup, tagPalette);

      // A cell whose children are drawn nested inside it this render
      // skips its own label/go-btn - they'd sit underneath those
      // children (later siblings in #treemap paint on top) - real
      // SequoiaView doesn't label intermediate levels either, relying on
      // the nesting itself plus hover for identification.
      if (!entry.hasInlineChildren) {
        const label = document.createElement("div");
        label.className = "cell-label";
        label.textContent = n.label || folderName(n.path);
        const sub = document.createElement("div");
        sub.className = "cell-sub";
        sub.textContent = sizeMode === "count" ? `${n.count} msgs` : fmtSize(n.size_mb);
        div.append(label, sub);

        if (n.folderId) {
          const goBtn = document.createElement("button");
          goBtn.type = "button";
          goBtn.className = "go-btn";
          goBtn.title = "Open this in Thunderbird, with the current filters applied (or just right-click the cell)";
          goBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
          goBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openFolderSearchImpl(n.folderId, n.jumpFilter || currentFilters());
          });
          div.appendChild(goBtn);
        }
      }

      div.addEventListener("pointermove", (e) => showTooltip(e, n, group, breakdown));
      div.addEventListener("pointerenter", (e) => showTooltip(e, n, group, breakdown));
      div.addEventListener("pointerleave", () => tooltipEl.classList.remove("show"));
      div.addEventListener("click", () => drillInto(n));
      // Right-click jumps straight to that exact search, the same
      // action as the hover go-btn - without needing to hover first, and
      // reachable even on a "container" cell (one with inline children)
      // whose go-btn is hidden this render (see above).
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (n.folderId) openFolderSearchImpl(n.folderId, n.jumpFilter || currentFilters());
      });
      treemapEl.appendChild(div);
    }
    renderBreadcrumb();
    renderLegend(nodes);
  }

  function showTooltip(e, n, group, breakdown) {
    tooltipEl.textContent = "";
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = n.label || folderName(n.path);
    tooltipEl.appendChild(title);

    // The bottom of the drill chain: one specific email. "Group: <its
    // own subject>" would be a useless duplicate of the title, so show
    // what's actually useful about a single message instead.
    const m = n.dimension === "message" ? n.messages && n.messages[0] : null;
    const rows = m
      ? [["From", m.author || "-"], ["Date", m.date ? new Date(m.date).toLocaleString() : "-"], ["Size", fmtSize((m.size || 0) / 1024 / 1024)]]
      : [["Messages", n.count], ["Size", n.size_mb != null ? fmtSize(n.size_mb) : "-"], ["Group", group]];
    for (const [k, v] of rows) {
      const row = document.createElement("div");
      row.className = "t-row";
      const kEl = document.createElement("span");
      kEl.textContent = k;
      const vEl = document.createElement("b");
      vEl.textContent = String(v);
      row.append(kEl, vEl);
      tooltipEl.appendChild(row);
    }
    const entries = m ? [] : Object.entries(breakdown || {}).slice(0, 5);
    if (entries.length > 1) {
      for (const [key, count] of entries) {
        const row = document.createElement("div");
        row.className = "t-row";
        const kEl = document.createElement("span");
        kEl.textContent = key;
        const vEl = document.createElement("b");
        vEl.textContent = String(count);
        row.append(kEl, vEl);
        tooltipEl.appendChild(row);
      }
    }
    tooltipEl.classList.add("show");
    const x = e.clientX + 14, y = e.clientY + 14;
    tooltipEl.style.left = Math.min(x, window.innerWidth - 320) + "px";
    tooltipEl.style.top = Math.min(y, window.innerHeight - 160) + "px";
  }

  function drillInto(n) {
    const nodes = nextLevelNodes(n);
    if (!nodes.length) return;
    stack.push({ label: n.label || folderName(n.path), nodes });
    render();
  }

  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = "";
    stack.forEach((level, i) => {
      if (i > 0) breadcrumbEl.appendChild(document.createTextNode(" › "));
      const btn = document.createElement("button");
      btn.textContent = level.label;
      btn.addEventListener("click", () => { stack = stack.slice(0, i + 1); render(); });
      breadcrumbEl.appendChild(btn);
    });
  }

  function renderLegend(nodes) {
    legendEl.innerHTML = "";
    // Every node at a given render shares one level, so one dimension
    // covers the whole legend: the active Group-by at the folder level,
    // or whatever dimension the current drill level regrouped by. At
    // "message" level every group is a singleton (one row per email) -
    // a legend there would be one entry per message, not a legend -
    // hover each cell's tooltip instead.
    if (nodes.length && nodes[0].dimension === "message") return;
    const dimension = nodes.length && nodes[0].dimension !== "folder" ? nodes[0].dimension : groupBy;
    // Keyed by the DISPLAYED label (deduplicated), valued by what
    // actually colors it - normally the same string, but groupMessages()'s
    // overflow "(N more)" node has a null colorKey (a fixed muted color,
    // not a real category) and a very much non-null label.
    const seen = new Map();
    for (const n of nodes) {
      if (n.dimension === "folder") {
        const { group } = groupFor(n, groupBy);
        seen.set(group, group);
      } else {
        seen.set(n.label, n.colorKey);
      }
    }
    for (const [label, colorKey] of seen) {
      const item = document.createElement("div");
      item.className = "item";
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.background = label === EMPTY_LABEL ? "var(--grid)" : colorForKey(dimension, colorKey, tagPalette);
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      item.append(sw, labelEl);
      legendEl.appendChild(item);
    }
  }

  function setGroupBy(mode) {
    groupBy = mode;
    for (const [key, el] of Object.entries(groupByEls)) el.classList.toggle("active", key === mode);
    rebuild();
  }

  document.getElementById("mode-count").addEventListener("click", (e) => {
    sizeMode = "count";
    e.target.classList.add("active");
    document.getElementById("mode-size").classList.remove("active");
    rebuild();
  });
  document.getElementById("mode-size").addEventListener("click", (e) => {
    sizeMode = "size";
    e.target.classList.add("active");
    document.getElementById("mode-count").classList.remove("active");
    rebuild();
  });
  groupByEls.tag.addEventListener("click", () => setGroupBy("tag"));
  groupByEls.domain.addEventListener("click", () => setGroupBy("domain"));
  groupByEls.addressType.addEventListener("click", () => setGroupBy("addressType"));
  function setDepth(d) {
    depth = Math.max(1, Math.min(6, d)); // 6 comfortably covers folder(s) -> Group-by -> sender -> message
    depthValueEl.textContent = String(depth);
    render(); // depth only changes what's already-loaded data renders as - no re-fetch needed
  }
  document.getElementById("depth-minus").addEventListener("click", () => setDepth(depth - 1));
  document.getElementById("depth-plus").addEventListener("click", () => setDepth(depth + 1));
  document.getElementById("refresh").addEventListener("click", loadData);
  accountSelect.addEventListener("change", () => {
    currentAccountId = accountSelect.value;
    loadData();
  });
  addressInput.addEventListener("input", rebuild);
  clearFiltersBtn.addEventListener("click", () => {
    selectedTagKeys.clear();
    addressInput.value = "";
    for (const chip of tagFiltersEl.querySelectorAll(".chip")) {
      chip.classList.remove("selected");
      chip.style.background = "";
    }
    rebuild();
  });
  window.addEventListener("resize", () => { if (stack.length) render(); });

  loadAccounts().then(loadData);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeBreakdowns,
    buildFolderTree,
    findFolderPath,
    groupFor,
    squarify,
    assignPalette,
    applyFilters,
    buildQuickFilterProps,
    senderDomain,
    classifyAddressType,
    hashColor,
    nextDimension,
    groupMessages,
    jumpFilterFor,
    colorForKey,
    __setQueryAllMessagesImplForTests: (fn) => { queryAllMessagesImpl = fn; },
    __setListTagsImplForTests: (fn) => { listTagsImpl = fn; },
    __setListAccountsImplForTests: (fn) => { listAccountsImpl = fn; },
    __setOpenFolderSearchImplForTests: (fn) => { openFolderSearchImpl = fn; },
  };
} else {
  initUi();
}
