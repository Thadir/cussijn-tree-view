/*
 * Cussijn Tree View - the treemap itself.
 *
 * Squarified treemap (Bruls, Huizing, van Wijk, 2000 - see squarify())
 * of the mailbox's folder tree, sized by message count or MB. Drilling
 * goes structural first (buildFolderTree() - real subfolders, as deep
 * as the account's own tree goes), then, once that bottoms out, by
 * content: Group-by dimension -> sender -> message -> terminal (see
 * groupMessages()/nextDimension()). "Depth" (layoutTree()) shows
 * several of those levels nested at once instead of one click per
 * level; clicking a cell still drills one step further regardless.
 *
 * Calls messenger.accounts/messages/mailTabs directly - no dispatch
 * table, since nothing else calls into this extension.
 *
 * Also runs under plain Node for cussijn.test.js (module.exports guard
 * at the bottom): the pure layout/aggregation/filter/color functions
 * are unit-tested; DOM wiring and the real messenger.* calls aren't.
 */

const PALETTE_ORDER = [
  "#2a78d6", "#eb6834", "#e87ba4", "#4a3aa7", "#1baf7a", "#008300", "#9085e9", "#eda100",
  "#e34948", "#17a589", "#d55181", "#6b6a66", "#0c8f6a", "#8c7853", "#c98500", "#5598e7",
];
const UNCATEGORIZED_COLOR = "#898781";
const EMPTY_LABEL = "Empty";
const ADDRESS_TYPES = ["Direct (To)", "Cc", "Bcc", "Other"];
// Dimensions jumpFilterFor() can't add anything for - no matching
// mailTabs.setQuickFilter() facet exists for any of these.
const NO_SEARCH_FACET = new Set(["addressType", "year", "month"]);
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function folderName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

// A MailFolderId is "<accountId>://<path>" - lets a folder-pane deep
// link pick the right account instead of always defaulting to the
// first one.
function accountIdFromFolderId(folderId) {
  if (!folderId) return null;
  const idx = folderId.indexOf("://");
  return idx === -1 ? null : folderId.slice(0, idx);
}

// Shows the account's own identity email rather than account.name (an
// arbitrary display name that can collide - e.g. two accounts both
// just named "Mail").
function accountDisplayName(account) {
  const email = account.identities?.[0]?.email;
  return email || account.name;
}

function assignPalette(tagNames) {
  const palette = { Uncategorized: UNCATEGORIZED_COLOR, [EMPTY_LABEL]: "#5a5a57" };
  tagNames.forEach((name, i) => { palette[name] = PALETTE_ORDER[i % PALETTE_ORDER.length]; });
  return palette;
}

// Stable, automatically-distinct color per string - used where the set
// of values (domains, senders) isn't known ahead of time.
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

// Every address field, concatenated - lets an address filter match a
// Cc or Bcc, not just the sender.
function allAddressText(m) {
  return [m.author, ...(m.recipients || []), ...(m.ccList || []), ...(m.bccList || [])]
    .filter(Boolean).join(" ").toLowerCase();
}

// How the mailbox owner was addressed: Direct (To), Cc, Bcc, or Other
// (none of myAddresses appears at all - a mailing list post, e.g.).
function classifyAddressType(message, myAddresses) {
  const mine = new Set((myAddresses || []).map((a) => a.toLowerCase()));
  if (!mine.size) return "Other";
  const matches = (list) => (list || []).some((addr) => mine.has(extractEmail(addr)));
  if (matches(message.recipients)) return "Direct (To)";
  if (matches(message.ccList)) return "Cc";
  if (matches(message.bccList)) return "Bcc";
  return "Other";
}

// Was this message sent BY the mailbox owner? Used by "Hide sent by
// me" - Gmail's All Mail includes your own sent replies by IMAP
// definition, so there's no folder-level way to see received-only mail
// there the way Inbox gives you for free.
function isSentByMe(message, myAddresses) {
  const mine = new Set((myAddresses || []).map((a) => a.toLowerCase()));
  return mine.has(extractEmail(message.author));
}

// Calendar year a message was sent in, as a plain string ("2026").
function messageYear(message) {
  return message.date ? String(new Date(message.date).getFullYear()) : "(unknown)";
}

// Client-side pre-filter applied before buildFolderTree() - narrows
// the whole treemap, not just dims cells.
//   tagKeys: a message needs at least one (OR across a selection).
//   addressText: substring match across From/To/Cc/Bcc.
//   hideSentByMe: drops messages authored by one of myAddresses.
// All active filter types must pass (AND); within a type, any match is
// enough (OR).
function applyFilters(messages, filters, myAddresses) {
  filters = filters || {};
  const tagKeys = filters.tagKeys || [];
  const addressText = (filters.addressText || "").toLowerCase().trim();
  const hideSentByMe = !!filters.hideSentByMe;

  return messages.filter((m) => {
    if (tagKeys.length) {
      const mTags = m.tags || [];
      if (!tagKeys.some((t) => mTags.includes(t))) return false;
    }
    if (addressText && !allAddressText(m).includes(addressText)) return false;
    if (hideSentByMe && isSentByMe(m, myAddresses)) return false;
    return true;
  });
}

function topEntries(counter, n) {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n || Infinity);
}

// Tallies tag/domain/address-type/year breakdowns together so
// switching "Group by" is a re-render, not a re-fetch. Shared by every
// folder-tree level - a parent's breakdown covers its whole subtree,
// not just its own messages.
function computeBreakdowns(messages, tagLabels, myAddresses) {
  tagLabels = tagLabels || {};
  myAddresses = myAddresses || [];
  const tagCounts = new Map();
  const domainCounts = new Map();
  const addressTypeCounts = new Map();
  const yearCounts = new Map();
  for (const m of messages) {
    for (const t of m.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    const domain = senderDomain(m.author) || "(unknown)";
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    const addrType = classifyAddressType(m, myAddresses);
    addressTypeCounts.set(addrType, (addressTypeCounts.get(addrType) || 0) + 1);
    const year = messageYear(m);
    yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
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

  const sortedYears = topEntries(yearCounts);
  const dominantYear = sortedYears.length ? sortedYears[0][0] : "(unknown)";
  const yearBreakdown = Object.fromEntries(sortedYears);

  return {
    dominantTag, dominantTagKey, tagBreakdown,
    dominantDomain, domainBreakdown,
    dominantAddressType, addressTypeBreakdown,
    dominantYear, yearBreakdown,
  };
}

// Turns Thunderbird's real folder hierarchy into a treemap-ready tree,
// nested the same way the folder pane nests it. A node's `messages` is
// the union of its own direct messages plus every descendant's (like a
// disk-usage view's directory size). A folder with both its own
// messages and real subfolders gets a synthetic "(direct in this
// folder)" child so neither silently absorbs the other. Folders with
// zero messages anywhere in their subtree are dropped.
function buildFolderTree(rootFolder, messages, tagLabels, myAddresses) {
  const byFolderId = new Map();
  for (const m of messages) {
    const id = m.folder?.id;
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
    // Computed before the synthetic node below is added to `children` -
    // that node's messages ARE ownMessages, so summing after would
    // double-count them.
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

// Root..target ancestor chain for a folder id, through a
// buildFolderTree() tree - used to auto-drill to one folder (e.g. a
// folder-pane deep link) with a real breadcrumb trail, not a single
// jump with nothing to climb back out on.
function findFolderPath(nodes, folderId) {
  for (const n of nodes) {
    if (n.folderId === folderId) return [n];
    if (n.children?.length) {
      const sub = findFolderPath(n.children, folderId);
      if (sub) return [n, ...sub];
    }
  }
  return null;
}

// Picks which precomputed dimension a node is grouped/colored by right
// now - "tag" | "domain" | "addressType" | "year" - returning
// {group, breakdown} so render()/legend/tooltip don't need a big
// switch each time.
function groupFor(node, mode) {
  if (mode === "domain") return { group: node.dominantDomain, breakdown: node.domainBreakdown };
  if (mode === "addressType") return { group: node.dominantAddressType, breakdown: node.addressTypeBreakdown };
  if (mode === "year") return { group: node.dominantYear, breakdown: node.yearBreakdown };
  return { group: node.dominantTag, breakdown: node.tagBreakdown };
}

// --- content-dimension drilling, once the real folder tree bottoms out ---
// Each further click regroups the same message subset by a finer
// content dimension instead of a structural one; every resulting node
// keeps its own `messages` so it can be drilled again.

// After a folder leaf, the next level is whichever dimension Group-by
// is set to. "year" gets one extra hop first - "month" - since a year
// alone is fairly coarse. After that (or after any other starting
// dimension): sender, then "message" (one cell per email), then
// terminal.
function nextDimension(currentDimension, groupBy) {
  if (currentDimension === null || currentDimension === undefined) return groupBy;
  if (currentDimension === "year") return "month";
  if (currentDimension === "sender") return "message";
  if (currentDimension === "message") return null;
  return "sender";
}

// The key a message groups under for a dimension. "tag" uses only the
// message's first tag (so a level is a true partition, unlike
// computeBreakdowns()'s non-exclusive tagBreakdown tally); "message"
// uses the message's own id, always a singleton group.
function groupKeyFor(message, dimension, myAddresses) {
  if (dimension === "tag") return (message.tags || [])[0] || "";
  if (dimension === "domain") return senderDomain(message.author) || "(unknown)";
  if (dimension === "addressType") return classifyAddressType(message, myAddresses);
  if (dimension === "sender") return message.author || "(unknown)";
  if (dimension === "year") return messageYear(message);
  if (dimension === "month") return message.date ? MONTH_NAMES[new Date(message.date).getMonth()] : "(unknown)";
  if (dimension === "message") return message.id != null ? String(message.id) : `${message.author}|${message.subject}|${message.date}`;
  return "(unknown)";
}

// The displayed text for a group. Only "message" needs the actual
// message (its subject) rather than the key alone - `sampleMessage` is
// any one message from that group (always a singleton for "message").
function labelForKey(dimension, key, tagLabels, sampleMessage) {
  if (dimension === "tag") return key ? (tagLabels[key] || key) : "Uncategorized";
  if (dimension === "message") return sampleMessage?.subject || "(no subject)";
  return key;
}

// What colorForKey() keys off. Same as the label for every dimension
// except "message": a message's label is its subject (unique, useless
// for coloring), so it colors by its own sender instead - visually
// clustering one sender's mail even at the finest level.
function colorKeyFor(dimension, key, tagLabels, sampleMessage) {
  if (dimension === "message") return sampleMessage?.author || "(unknown)";
  return labelForKey(dimension, key, tagLabels);
}

// Past this many distinct groups, the smallest fold into one "(N
// more)" node instead of a cell each - otherwise a dimension with
// hundreds of values turns into hundreds of slivers. "message" gets a
// much lower cap: every message has the same count (1), so more tiles
// isn't more informative, just slower to lay out and click through.
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
    const restMessages = overflow.flatMap(([, items]) => items);
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

// What refining "go to search" for one drill node's group adds to the
// active filters. Tag/domain/sender map onto a real
// mailTabs.setQuickFilter() facet; address-type/year/month don't (no
// Cc-only or date/age match exists in that API), so drilling into any
// of them can't narrow the search past the folder's own current
// filters. "message" falls back to its own sender instead of nothing -
// a message group is always a singleton, so sampleMessage is right
// there.
//
// domain/sender/message all set `senderOnly: true`: they're computed
// from a message's author alone, so the search they jump to has to
// match author only too - otherwise your own address matches almost
// every message in the account, since you're also the recipient of
// most of them. buildQuickFilterProps() reads this flag to leave
// `recipients` out of the search.
function jumpFilterFor(dimension, groupKey, sampleMessage) {
  if (dimension === "tag") return groupKey ? { tagKeys: [groupKey] } : {};
  if (dimension === "domain" || dimension === "sender") return { addressText: groupKey, senderOnly: true };
  if (dimension === "message") {
    return sampleMessage?.author ? { addressText: sampleMessage.author, senderOnly: true } : {};
  }
  return {};
}

// Color for one drill-level node (or a folder-level node's current
// group, called with `key` already resolved by groupFor). A null key
// (groupMessages()'s overflow "(N more)" node) gets the same muted
// color as an untagged/empty cell - it isn't a real category.
function colorForKey(dimension, key, tagPalette) {
  if (key === EMPTY_LABEL || key == null) return "#5a5a57";
  if (dimension === "domain" || dimension === "sender" || dimension === "message" || dimension === "year") return hashColor(key);
  if (dimension === "addressType") {
    const idx = ADDRESS_TYPES.indexOf(key);
    return idx === -1 ? UNCATEGORIZED_COLOR : PALETTE_ORDER[idx % PALETTE_ORDER.length];
  }
  // month is a bounded set of 12, unlike year (open-ended) - a fixed
  // palette slot per value, same as addressType, rather than a hash.
  if (dimension === "month") {
    const idx = MONTH_NAMES.indexOf(key);
    return idx === -1 ? UNCATEGORIZED_COLOR : PALETTE_ORDER[idx % PALETTE_ORDER.length];
  }
  return tagPalette?.[key] || UNCATEGORIZED_COLOR;
}

// Worst aspect ratio in a candidate row laid along a side of `length`.
function worst(row, length) {
  if (!row.length) return Infinity;
  const sum = row.reduce((s, n) => s + n.area, 0);
  const maxA = Math.max(...row.map(n => n.area));
  const minA = Math.min(...row.map(n => n.area));
  return Math.max((length * length * maxA) / (sum * sum), (sum * sum) / (length * length * minA));
}

// Squarified treemap layout (Bruls/Huizing/van Wijk). Pure function:
// takes {value}-bearing nodes and a rectangle, returns {node, x, y, w, h}.
function squarify(inputNodes, x, y, w, h) {
  const total = inputNodes.reduce((s, n) => s + n.value, 0) || 1;
  const scale = (w * h) / total;
  const sorted = [...inputNodes].sort((a, b) => b.value - a.value).map(n => ({ ...n, area: n.value * scale }));
  const rects = [];

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
    // Thickness along the dimension this row CONSUMES: a width when
    // `wide` (eating into cw), a height otherwise (eating into ch) -
    // the opposite of `length` above, which is the fixed perpendicular
    // side used only for scoring. Mixing these two up produces a real
    // row every time, just oriented wrong for the container's own
    // shape - self-consistent enough that simple 2-3-node tests won't
    // catch it, but it degenerates badly on a real, many-item dataset.
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
    // Default (the free-text address filter bar): author + recipients
    // together, matching applyFilters()'s own From/To/Cc/Bcc scope.
    // `senderOnly` (set by jumpFilterFor() for domain/sender/message)
    // drops recipients instead - see there for why.
    props.text = { text: addressText, author: true, recipients: !filters.senderOnly };
  }
  props.show = Object.keys(props).length > 0;
  return props;
}

// A cheap fingerprint of exactly which messages are present - length
// alone can't tell one message being added apart from a different one
// being removed at the same total count.
function messageSignature(messages) {
  return messages.map((m) => m.id).sort().join(",");
}

// Does a freshly fetched account still match what the cache showed? If so
// the background refresh must not re-render: rebuild() resets navigation
// back to "All folders", which would kick the user out of wherever they'd
// drilled for no reason.
function cacheMatches(cached, messages, labels) {
  return cached?.messages.length === messages.length
    && messageSignature(messages) === messageSignature(cached.messages)
    && JSON.stringify(labels) === JSON.stringify(cached.tagLabels);
}

// An account with no Thunderbird tags at all (e.g. Gmail via IMAP) gets a
// different default Group-by and a "Label" button instead of "Tag".
function hasAnyTag(messages) {
  return messages.some((m) => (m.tags || []).length > 0);
}

function cacheKeyFor(accountId) {
  return `msgCache:${accountId}`;
}

// Adds the `value` squarify() sizes by: message count or MB. Never zero,
// or an empty group would vanish from the layout.
function withSizeValue(nodes, sizeMode) {
  return nodes.map((n) => ({ ...n, value: (sizeMode === "count" ? n.count : n.size_mb) || 0.01 }));
}

// What one more level of drill-down looks like for a node, without
// touching any navigation state - shared by drillInto() (a click) and
// layoutTree()'s inline "show N levels at once" expansion, so both agree
// on exactly what's "inside" a given cell.
//   ctx: { sizeMode, groupBy, tagLabels, myAddresses, filters }
function nextLevelNodesFor(n, ctx) {
  const { sizeMode, groupBy, tagLabels, myAddresses, filters } = ctx;
  if (n.dimension === "folder" && n.children?.length) {
    // A real folder with real subfolders (or the synthetic "(direct in
    // this folder)" entry) - drill structurally, arbitrarily deep,
    // following the account's own folder nesting.
    return withSizeValue(n.children.map((c) => ({ ...c })), sizeMode);
  }

  // A leaf folder or a content-dimension node: regroup its own messages
  // one step finer - see the comment above nextDimension().
  const currentDim = n.dimension === "folder" ? null : n.dimension;
  const next = nextDimension(currentDim, groupBy);
  if (!next || !n.messages?.length) return [];

  const grouped = groupMessages(n.messages, next, tagLabels, myAddresses);
  return withSizeValue(grouped, sizeMode).map((g) => ({
    ...g,
    folderId: n.folderId, // "go to search" always targets the folder we're inside
    // Refines the active filters rather than replacing them - drilling
    // into one domain should narrow, not lose, an active tag filter.
    jumpFilter: { ...filters, ...jumpFilterFor(next, g.groupKey, g.messages[0]) },
  }));
}

// Gap around a cell's edge when its children are drawn nested inside it,
// and the minimum size worth expanding into - below this it'd just be
// unreadable slivers, so it stays collapsed (still drillable by a click).
const NEST_INSET = 6;
const MIN_EXPANDABLE_W = 70;
const MIN_EXPANDABLE_H = 64; // must leave room for HEADER_H too
// A container's own label bar, reserved above its nested children -
// otherwise, once several containers are expanded inline at once (several
// years, each showing its own months), there's no way to tell which
// cluster of children belongs to which container.
const HEADER_H = 17;

// Squarifies `nodes` into the `box` {x,y,w,h} and, for any cell with `levelsLeft`
// > 1 and children (`expand(node)` returns them), recurses INTO that
// cell's own rectangle (inset by NEST_INSET) for its children - producing
// one FLAT list of {node,x,y,w,h,depthIndex,hasInlineChildren} entries
// all in the SAME coordinate space as the outer container, so every level
// can be drawn as a plain sibling <div> (no nested DOM, no
// measurement/reflow needed to position an inner level).
function layoutTree(nodes, box, levelsLeft, depthIndex, expand) {
  const rects = squarify(nodes.filter((n) => n.value > 0), box.x, box.y, box.w, box.h);
  const out = [];
  for (const r of rects) {
    // Never auto-expand sender level into individual messages via Depth -
    // every message has count 1, so it's a wall of same-size tiles, not
    // informative. Month gets the same treatment: it's meant to be the
    // max automatic step in the Year -> Month breakdown. Either way, an
    // explicit click can still go further (drillInto()).
    const canExpand = levelsLeft > 1 && r.node.dimension !== "sender" && r.node.dimension !== "month"
      && r.w >= MIN_EXPANDABLE_W && r.h >= MIN_EXPANDABLE_H;
    const kids = canExpand ? expand(r.node) : [];
    // A single child is the same 100%-of-area group just relabeled one
    // dimension finer - conveys nothing new, so only expand when there's
    // genuinely more than one group to show.
    const hasInlineChildren = kids.length > 1;
    out.push({ node: r.node, x: r.x, y: r.y, w: r.w, h: r.h, depthIndex, hasInlineChildren });
    if (hasInlineChildren) {
      // The header eats into the top inset only - left/right/bottom stay
      // a plain NEST_INSET.
      const inner = {
        x: r.x + NEST_INSET, y: r.y + NEST_INSET + HEADER_H,
        w: r.w - NEST_INSET * 2, h: r.h - NEST_INSET * 2 - HEADER_H,
      };
      out.push(...layoutTree(kids, inner, levelsLeft - 1, depthIndex + 1, expand));
    }
  }
  return out;
}

// One legend entry per DISPLAYED label (deduplicated): what actually
// colors it - normally the same string, but groupMessages()'s overflow
// "(N more)" node has a null colorKey - plus a running message-count
// total, since several folder-level nodes can share the same dominant
// group and need to add up rather than the last one overwriting the count.
function legendEntries(nodes, groupBy) {
  const seen = new Map();
  for (const n of nodes) {
    const isFolder = n.dimension === "folder";
    const label = isFolder ? groupFor(n, groupBy).group : n.label;
    const colorKey = isFolder ? label : n.colorKey;
    const prev = seen.get(label);
    seen.set(label, { colorKey, count: (prev ? prev.count : 0) + n.count });
  }
  return seen;
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
  // true populates rootFolder.subFolders recursively - the real folder
  // tree buildFolderTree() drills through. Identities are always
  // present on every account regardless of this flag.
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

// Per-account cache of the last fetched messages/tags, so reopening
// the view (or switching back to an account already seen this
// Thunderbird session) can show something instantly instead of waiting
// on a full re-fetch - loadData() shows this first, if present, then
// quietly re-fetches for real and only re-renders if anything actually
// changed (see messageSignature()). Caching is an optimization, not a
// requirement, so a storage failure (quota, disabled) just means no
// instant view this time, not a broken one.
async function realReadCache(accountId) {
  try {
    const key = cacheKeyFor(accountId);
    const stored = await browser.storage.local.get(key);
    return stored[key] || null;
  } catch (e) {
    // no cache is fine - the view just loads from scratch
    return null;
  }
}
async function realWriteCache(accountId, messages, tagLabels) {
  try {
    await browser.storage.local.set({
      [cacheKeyFor(accountId)]: { messages, tagLabels, fetchedAt: Date.now() },
    });
  } catch (e) {
    // ignored - see comment above
  }
}

let queryAllMessagesImpl = realQueryAllMessages;
let listTagsImpl = realListTags;
let listAccountsImpl = realListAccounts;
let openFolderSearchImpl = realOpenFolderSearch;
let readCacheImpl = realReadCache;
let writeCacheImpl = realWriteCache;

// --- DOM wiring (real extension page only) ------------------------------

function fmtSize(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB"; }

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
  const hideSentByMeBtn = document.getElementById("hide-sent-by-me");
  const groupByEls = {
    tag: document.getElementById("group-tag"),
    domain: document.getElementById("group-domain"),
    addressType: document.getElementById("group-address-type"),
    year: document.getElementById("group-year"),
  };
  const depthValueEl = document.getElementById("depth-value");

  let sizeMode = "count";
  let groupBy = "tag";
  // True until the user explicitly picks a Group-by - lets loadData()
  // choose a sensible default per account without overriding a real
  // choice the user already made.
  let groupByAutoPicked = true;
  // How many levels to show nested at once from the current stack top.
  // 1 is click-per-level; higher inline-expands each cell's children
  // inside it (layoutTree()). Clicking still drills one step forward
  // regardless of depth. MAX_DEPTH (6) covers folder(s) -> Group-by ->
  // sender -> message; "Max" jumps straight there.
  const MAX_DEPTH = 6;
  let depth = 2;
  let stack = [];
  let accounts = [];
  let currentAccountId = null;
  let allMessages = [];
  let tagLabels = {};
  let myAddresses = [];
  let selectedTagKeys = new Set();
  let hideSentByMe = false;
  // Set by background.js's folder-pane entry (?folder=<id>) so the
  // view opens already drilled into that folder and account. Consumed
  // once by the first rebuild(), which also strips it back out of the
  // visible address bar.
  let pendingFolderId = new URLSearchParams(location.search).get("folder");

  function currentFilters() {
    return { tagKeys: [...selectedTagKeys], addressText: addressInput.value, hideSentByMe };
  }

  function filterCount() {
    const f = currentFilters();
    return f.tagKeys.length + (f.addressText.trim() ? 1 : 0) + (f.hideSentByMe ? 1 : 0);
  }

  async function loadAccounts() {
    accounts = await listAccountsImpl(); // includes each account's real rootFolder.subFolders tree
    accountSelect.innerHTML = "";
    for (const a of accounts) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = accountDisplayName(a);
      accountSelect.appendChild(opt);
    }
    if (accounts.length) {
      // A deep-linked folder names its own account via the folder id
      // itself - honor that over defaulting to the first account.
      const pendingAccountId = accountIdFromFolderId(pendingFolderId);
      const chosen = (pendingAccountId && accounts.find((a) => a.id === pendingAccountId)) || accounts[0];
      currentAccountId = chosen.id;
      accountSelect.value = currentAccountId; // keep the <select> in sync with the deep-linked account
      myAddresses = (chosen.identities || []).map((i) => i.email).filter(Boolean);
    }
  }

  // An account with no Thunderbird tags at all (e.g. Gmail via IMAP)
  // would render every cell the same muted gray under Group-by: Tag -
  // default to Sender domain instead, without overriding a Group-by
  // the user actually picked. Also relabel the button "Label" for such
  // an account: Gmail's own labels are a different, folder-based
  // concept (already surfaced as real folders by buildFolderTree()),
  // so "Tag" is the wrong word here.
  function applyAutoGroupBy() {
    const anyTagged = hasAnyTag(allMessages);
    groupByEls.tag.textContent = anyTagged ? "Tag" : "Label";
    if (groupByAutoPicked) {
      const preferred = anyTagged ? "tag" : "domain";
      if (groupBy !== preferred) {
        groupBy = preferred;
        for (const [key, el] of Object.entries(groupByEls)) el.classList.toggle("active", key === preferred);
      }
    }
  }

  // Stale-while-revalidate: shows a cached account instantly if one
  // exists (readCacheImpl(), browser.storage.local), then fetches for
  // real in the background and only re-renders if anything actually
  // changed - so reopening the view on an account you've already
  // loaded this session doesn't reset an in-progress drill-down for no
  // reason.
  async function loadData() {
    const accountId = currentAccountId;
    const cached = await readCacheImpl(accountId);
    if (cached) {
      allMessages = cached.messages;
      tagLabels = cached.tagLabels;
      renderTagFilterChips();
      applyAutoGroupBy();
      rebuild();
      statusEl.hidden = true;
    } else {
      statusEl.textContent = "Loading...";
      statusEl.hidden = false;
    }

    try {
      const [messages, labels] = await Promise.all([
        queryAllMessagesImpl(accountId),
        listTagsImpl(),
      ]);
      if (accountId !== currentAccountId) return; // switched accounts again while this was in flight

      writeCacheImpl(accountId, messages, labels); // fire-and-forget

      if (cacheMatches(cached, messages, labels)) return;

      allMessages = messages;
      tagLabels = labels;
      renderTagFilterChips();
      applyAutoGroupBy();
      rebuild();
      statusEl.hidden = true;
    } catch (e) {
      if (!cached) {
        statusEl.hidden = false;
        statusEl.textContent = "Error: " + (e?.message || e);
      } // else: keep showing the cached view rather than replace it with an error
    }
  }

  function rebuild() {
    const filtered = applyFilters(allMessages, currentFilters(), myAddresses);
    const account = accounts.find((a) => a.id === currentAccountId);
    const nodes = account ? buildFolderTree(account.rootFolder, filtered, tagLabels, myAddresses) : [];
    // A groupBy/filter change starts over at the folder level - the
    // previous drill-down was into nodes that no longer exist.
    stack = [{ label: "All folders", nodes: withValue(nodes) }];
    updateFilterUi();
    if (pendingFolderId) {
      const path = findFolderPath(stack[0].nodes, pendingFolderId);
      pendingFolderId = null;
      // Already done its job (picking the account, drilling below) -
      // strip it from the visible address bar rather than leaving a
      // raw internal id on display.
      if (typeof history !== "undefined" && history.replaceState) {
        history.replaceState(null, "", location.pathname);
      }
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
    return withSizeValue(nodes, sizeMode);
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
    hideSentByMeBtn.classList.toggle("active", hideSentByMe);
  }

  function nextLevelNodes(n) {
    return nextLevelNodesFor(n, { sizeMode, groupBy, tagLabels, myAddresses, filters: currentFilters() });
  }

  // A container (children drawn inline) gets a slim header instead of its
  // normal bottom label - layoutTree() reserved HEADER_H of space above
  // its children for exactly this. Clicking a container still drills into
  // just that one node (e.g. focus on 2012 alone); the hint sits right
  // after the label in the header's own flex row.
  function makeCellHeader(n) {
    const header = document.createElement("div");
    header.className = "cell-header";
    const headerLabel = document.createElement("span");
    headerLabel.className = "cell-header-label";
    headerLabel.textContent = n.label || folderName(n.path);
    const headerHint = document.createElement("span");
    headerHint.className = "cell-header-hint";
    headerHint.textContent = "▸";
    header.append(headerLabel, headerHint);
    return header;
  }

  function makeGoButton(n, dimension) {
    const goBtn = document.createElement("button");
    goBtn.type = "button";
    goBtn.className = "go-btn";
    // addressType/year/month have no matching Thunderbird quick-filter
    // facet (see jumpFilterFor()) - say so up front rather than let it
    // look broken when this opens the whole folder unfiltered.
    goBtn.title = NO_SEARCH_FACET.has(dimension)
      ? "Open this in Thunderbird - Thunderbird has no date/address-type search filter, so this opens the whole folder unless another filter (tag, address) is also active"
      : "Open this in Thunderbird, with the current filters applied (or just right-click the cell)";
    goBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
    goBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFolderSearchImpl(n.folderId, n.jumpFilter || currentFilters());
    });
    return goBtn;
  }

  function appendCellBody(div, n, dimension) {
    const label = document.createElement("div");
    label.className = "cell-label";
    label.textContent = n.label || folderName(n.path);
    const sub = document.createElement("div");
    sub.className = "cell-sub";
    sub.textContent = sizeMode === "count" ? `${n.count} msgs` : fmtSize(n.size_mb);
    div.append(label, sub);

    if (n.folderId) div.appendChild(makeGoButton(n, dimension));

    // A quiet "there's more inside" mark for a cell that isn't expanded
    // inline (Depth too low, too small, or already a single-group dead
    // end) but could still be drilled by a click. Skipped for a true
    // terminal (nextLevelNodes() empty).
    if (nextLevelNodes(n).length) {
      const hint = document.createElement("div");
      hint.className = "drill-hint";
      hint.textContent = "▸";
      div.appendChild(hint);
    }
  }

  function wireCell(div, n, group, breakdown) {
    div.addEventListener("pointermove", (e) => showTooltip(e, n, group, breakdown));
    div.addEventListener("pointerenter", (e) => showTooltip(e, n, group, breakdown));
    div.addEventListener("pointerleave", () => tooltipEl.classList.remove("show"));
    div.addEventListener("click", () => drillInto(n));
    // Right-click jumps straight to that exact search, same as the hover
    // go-btn - reachable even on a container cell, whose go-btn is hidden
    // this render.
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (n.folderId) openFolderSearchImpl(n.folderId, n.jumpFilter || currentFilters());
    });
  }

  function buildCell(entry) {
    const n = entry.node;
    // Folder-level nodes still carry all four switchable breakdowns
    // (groupFor picks the one Group-by is set to); a drill-level node
    // (from groupMessages) is already a single dimension/key, colored via
    // its own colorKey (see colorKeyFor()).
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

    if (entry.hasInlineChildren) div.appendChild(makeCellHeader(n));
    else appendCellBody(div, n, dimension);
    wireCell(div, n, group, breakdown);
    return div;
  }

  function render() {
    const level = stack.at(-1);
    const rect = treemapEl.getBoundingClientRect();
    const nodes = level.nodes.filter(n => n.value > 0);
    const box = { x: 0, y: 0, w: rect.width || 800, h: rect.height || 400 };
    const flat = layoutTree(nodes, box, depth, 0, nextLevelNodes);

    treemapEl.innerHTML = "";
    for (const entry of flat) treemapEl.appendChild(buildCell(entry));
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
    const m = n.dimension === "message" ? n.messages?.[0] : null;
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
    // `source` is the node this level was drilled from - lets
    // setGroupBy() recompute it later if Group-by changes.
    stack.push({ label: n.label || folderName(n.path), nodes, source: n });
    render();
  }

  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = "";
    // No separate "›" between levels - each button is its own
    // arrow-shaped chip (see the .breadcrumb CSS), interlocking into
    // one ribbon on its own.
    stack.forEach((level, i) => {
      const btn = document.createElement("button");
      btn.textContent = level.label;
      btn.addEventListener("click", () => { stack = stack.slice(0, i + 1); render(); });
      breadcrumbEl.appendChild(btn);
    });
  }

  function renderLegend(nodes) {
    legendEl.innerHTML = "";
    // Every node at a given render shares one level, so one dimension
    // covers the whole legend. At "message" level every group is a
    // singleton (one row per email) - hover each cell's tooltip
    // instead of a legend there.
    if (nodes.length && nodes[0].dimension === "message") return;
    const dimension = nodes.length && nodes[0].dimension !== "folder" ? nodes[0].dimension : groupBy;
    const seen = legendEntries(nodes, groupBy);
    for (const [label, { colorKey, count }] of seen) {
      const item = document.createElement("div");
      item.className = "item";
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.style.background = label === EMPTY_LABEL ? "var(--grid)" : colorForKey(dimension, colorKey, tagPalette);
      const labelEl = document.createElement("span");
      labelEl.textContent = `${label} (${count})`;
      item.append(sw, labelEl);
      legendEl.appendChild(item);
    }
  }

  function setGroupBy(mode) {
    groupByAutoPicked = false; // the user just made an explicit choice - loadData() stops overriding it
    groupBy = mode;
    for (const [key, el] of Object.entries(groupByEls)) el.classList.toggle("active", key === mode);
    // Re-render in place rather than rebuild(): switching Group-by only
    // changes how already-computed nodes are colored/grouped, not
    // which messages exist (a filter change does, hence rebuild()
    // there). A content-dimension level already on the stack (a folder
    // leaf regrouped by whichever Group-by was active at drill time) is
    // baked with that old dimension though - recompute every level from
    // its own `source` node so it follows the new one too. A no-op for
    // real folder-tree levels, whose nodes don't depend on Group-by.
    for (let i = 1; i < stack.length; i++) {
      if (stack[i].source) stack[i] = { ...stack[i], nodes: nextLevelNodes(stack[i].source) };
    }
    if (stack.length) render();
    else rebuild();
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
  groupByEls.year.addEventListener("click", () => setGroupBy("year"));
  hideSentByMeBtn.addEventListener("click", () => {
    hideSentByMe = !hideSentByMe;
    rebuild();
  });
  function setDepth(d) {
    depth = Math.max(1, Math.min(MAX_DEPTH, d));
    depthValueEl.textContent = String(depth);
    render(); // depth only changes what's already-loaded data renders as - no re-fetch needed
  }
  document.getElementById("depth-max").addEventListener("click", () => setDepth(MAX_DEPTH));
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
    hideSentByMe = false;
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
    accountIdFromFolderId,
    accountDisplayName,
    computeBreakdowns,
    buildFolderTree,
    findFolderPath,
    groupFor,
    legendEntries,
    withSizeValue,
    nextLevelNodesFor,
    layoutTree,
    folderName,
    fmtSize,
    groupKeyFor,
    labelForKey,
    colorKeyFor,
    realQueryAllMessages,
    realListTags,
    realListAccounts,
    realOpenFolderSearch,
    realReadCache,
    realWriteCache,
    squarify,
    assignPalette,
    applyFilters,
    buildQuickFilterProps,
    senderDomain,
    classifyAddressType,
    isSentByMe,
    messageYear,
    hashColor,
    nextDimension,
    groupMessages,
    jumpFilterFor,
    colorForKey,
    messageSignature,
    cacheKeyFor,
    cacheMatches,
    hasAnyTag,
    __setQueryAllMessagesImplForTests: (fn) => { queryAllMessagesImpl = fn; },
    __setListTagsImplForTests: (fn) => { listTagsImpl = fn; },
    __setListAccountsImplForTests: (fn) => { listAccountsImpl = fn; },
    __setOpenFolderSearchImplForTests: (fn) => { openFolderSearchImpl = fn; },
    __setReadCacheImplForTests: (fn) => { readCacheImpl = fn; },
    __setWriteCacheImplForTests: (fn) => { writeCacheImpl = fn; },
  };
} else {
  initUi();
}
