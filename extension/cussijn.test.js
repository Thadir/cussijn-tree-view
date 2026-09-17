/*
 * Unit tests for cussijn.js's pure logic: the real folder-tree drill-down
 * (buildFolderTree/findFolderPath), tag/domain/address-type aggregation,
 * filtering, the squarified treemap layout, and the
 * mailTabs.setQuickFilter() property builder. messenger.* is never
 * called here - these are plain data-in, data-out functions. Run via
 * node --test (see CLAUDE.md "Build & test").
 */

const test = require("node:test");
const assert = require("node:assert/strict");

function freshCussijn() {
  delete require.cache[require.resolve("./cussijn.js")];
  return require("./cussijn.js");
}

const ME = "me@mine.com";

test("computeBreakdowns finds the dominant tag and tallies tag/domain/address-type/year breakdowns together", () => {
  const { computeBreakdowns } = freshCussijn();
  const messages = [
    { author: "a@bank.nl", tags: ["$cat_banking"], recipients: [ME], date: "2025-03-01" },
    { author: "a@bank.nl", tags: ["$cat_banking"], recipients: [ME], date: "2025-06-01" },
    { author: "b@other.nl", tags: ["$cat_travel"], ccList: [ME], date: "2026-01-01" },
  ];
  const b = computeBreakdowns(messages, { $cat_banking: "Banking", $cat_travel: "Travel" }, [ME]);
  assert.equal(b.dominantTag, "Banking");
  assert.deepEqual(b.tagBreakdown, { Banking: 2, Travel: 1 });
  assert.equal(b.dominantDomain, "bank.nl");
  assert.deepEqual(b.domainBreakdown, { "bank.nl": 2, "other.nl": 1 });
  assert.deepEqual(b.addressTypeBreakdown, { "Direct (To)": 2, Cc: 1 });
  assert.equal(b.dominantYear, "2025");
  assert.deepEqual(b.yearBreakdown, { "2025": 2, "2026": 1 });
});

test("computeBreakdowns falls back to Uncategorized/Other/(unknown) with no tags, no known own-address, or no date", () => {
  const { computeBreakdowns } = freshCussijn();
  const b = computeBreakdowns([{ author: "c@gmail.com", tags: [] }], {}, []);
  assert.equal(b.dominantTag, "Uncategorized");
  assert.equal(b.dominantAddressType, "Other");
  assert.equal(b.dominantYear, "(unknown)");
});

// A small two-level fixture mirroring accounts.list(true)'s real shape:
// account.rootFolder.subFolders, nested recursively. "finance" has its
// own direct messages AND two real subfolders (Paypal, KPN); "empty" has
// none anywhere in its subtree and should disappear entirely.
function fixtureRootFolder(financeOwnMessages) {
  return {
    subFolders: [
      {
        id: "finance", name: "finance", path: "/finance",
        subFolders: [
          { id: "paypal", name: "Paypal", path: "/finance/Paypal", subFolders: [] },
          { id: "kpn", name: "KPN", path: "/finance/KPN", subFolders: [] },
        ],
      },
      {
        id: "empty", name: "empty", path: "/empty", subFolders: [
          { id: "empty-child", name: "child", path: "/empty/child", subFolders: [] },
        ],
      },
    ],
  };
}
function fixtureMessages(financeOwnCount) {
  const messages = [
    { folder: { id: "paypal" }, author: "a@paypal.com", size: 1000, tags: [] },
    { folder: { id: "paypal" }, author: "b@paypal.com", size: 1000, tags: [] },
    { folder: { id: "kpn" }, author: "c@kpn.com", size: 1000, tags: [] },
  ];
  for (let i = 0; i < financeOwnCount; i++) {
    messages.push({ folder: { id: "finance" }, author: "d@finance-hq.com", size: 1000, tags: [] });
  }
  return messages;
}

test("buildFolderTree nests real subfolders under their real parent instead of flattening every distinct path", () => {
  const { buildFolderTree } = freshCussijn();
  const tree = buildFolderTree(fixtureRootFolder(), fixtureMessages(0), {}, []);

  assert.equal(tree.length, 1); // "empty" has zero messages anywhere - dropped
  const finance = tree[0];
  assert.equal(finance.folderId, "finance");
  assert.equal(finance.count, 3); // recursive union of Paypal + KPN
  assert.equal(finance.dimension, "folder");
  const childIds = finance.children.map((c) => c.folderId).sort();
  assert.deepEqual(childIds, ["kpn", "paypal"]);
  const paypal = finance.children.find((c) => c.folderId === "paypal");
  assert.equal(paypal.count, 2);
  assert.deepEqual(paypal.children, []); // no real subfolders of its own - a leaf
});

test("buildFolderTree's dominant-group breakdowns are computed over the whole subtree, not just a folder's own messages", () => {
  const { buildFolderTree } = freshCussijn();
  const tree = buildFolderTree(fixtureRootFolder(), fixtureMessages(0), {}, []);
  const finance = tree[0];
  assert.deepEqual(finance.domainBreakdown, { "paypal.com": 2, "kpn.com": 1 });
});

test("buildFolderTree adds a synthetic \"(direct in this folder)\" child when a folder has both its own messages and real subfolders", () => {
  const { buildFolderTree } = freshCussijn();
  const tree = buildFolderTree(fixtureRootFolder(), fixtureMessages(2), {}, []);
  const finance = tree[0];
  assert.equal(finance.count, 5); // 2 (own) + 2 (Paypal) + 1 (KPN)
  const own = finance.children.find((c) => c.label === "(direct in this folder)");
  assert.ok(own, "expected a synthetic own-messages child");
  assert.equal(own.folderId, "finance"); // "go to search" still targets the real folder
  assert.equal(own.count, 2);
  assert.deepEqual(own.children, []);
  assert.equal(finance.children.length, 3); // Paypal, KPN, and the synthetic node
});

test("buildFolderTree treats a folder with no real subfolders as a plain leaf - no synthetic node needed", () => {
  const { buildFolderTree } = freshCussijn();
  const root = { subFolders: [{ id: "sent", name: "Sent", path: "/Sent", subFolders: [] }] };
  const messages = [{ folder: { id: "sent" }, author: "me@mine.com", size: 1, tags: [] }];
  const [sent] = buildFolderTree(root, messages, {}, []);
  assert.deepEqual(sent.children, []);
  assert.equal(sent.count, 1);
});

test("findFolderPath returns the root..target ancestor chain through a real nested tree", () => {
  const { buildFolderTree, findFolderPath } = freshCussijn();
  const tree = buildFolderTree(fixtureRootFolder(), fixtureMessages(0), {}, []);
  const path = findFolderPath(tree, "paypal");
  assert.equal(path.length, 2);
  assert.equal(path[0].folderId, "finance");
  assert.equal(path[1].folderId, "paypal");
});

test("findFolderPath returns null when the folder id isn't anywhere in the tree", () => {
  const { buildFolderTree, findFolderPath } = freshCussijn();
  const tree = buildFolderTree(fixtureRootFolder(), fixtureMessages(0), {}, []);
  assert.equal(findFolderPath(tree, "does-not-exist"), null);
});

test("classifyAddressType prefers To over Cc over Bcc, falls back to Other", () => {
  const { classifyAddressType } = freshCussijn();
  assert.equal(classifyAddressType({ recipients: [ME], ccList: [ME] }, [ME]), "Direct (To)");
  assert.equal(classifyAddressType({ ccList: [`"Me" <${ME}>`] }, [ME]), "Cc");
  assert.equal(classifyAddressType({ bccList: [ME] }, [ME]), "Bcc");
  assert.equal(classifyAddressType({ recipients: ["other@x.com"] }, [ME]), "Other");
  assert.equal(classifyAddressType({ recipients: [ME] }, []), "Other"); // no known "me" addresses
});

test("isSentByMe matches the author against the account's own identities", () => {
  const { isSentByMe } = freshCussijn();
  assert.equal(isSentByMe({ author: `"Me" <${ME}>` }, [ME]), true);
  assert.equal(isSentByMe({ author: "other@x.com" }, [ME]), false);
  assert.equal(isSentByMe({ author: ME }, []), false); // no known "me" addresses
});

test("messageYear reads the calendar year out of a message's date, falls back to (unknown)", () => {
  const { messageYear } = freshCussijn();
  assert.equal(messageYear({ date: "2026-01-15" }), "2026");
  assert.equal(messageYear({}), "(unknown)");
});

test("messageSignature is order-independent and changes when the message set actually changes", () => {
  const { messageSignature } = freshCussijn();
  const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const bSameOrderShuffled = [{ id: 3 }, { id: 1 }, { id: 2 }];
  assert.equal(messageSignature(a), messageSignature(bSameOrderShuffled));

  const oneSwapped = [{ id: 1 }, { id: 2 }, { id: 4 }]; // same count, different message
  assert.notEqual(messageSignature(a), messageSignature(oneSwapped));
});

test("cacheKeyFor namespaces the per-account cache key", () => {
  const { cacheKeyFor } = freshCussijn();
  assert.equal(cacheKeyFor("account4"), "msgCache:account4");
  assert.notEqual(cacheKeyFor("account4"), cacheKeyFor("account5"));
});

test("senderDomain extracts the domain from a plain or Name<addr> author string", () => {
  const { senderDomain } = freshCussijn();
  assert.equal(senderDomain("service@paypal.nl"), "paypal.nl");
  assert.equal(senderDomain('"PayPal" <service@paypal.nl>'), "paypal.nl");
  assert.equal(senderDomain(""), "");
});

test("hashColor is stable for the same input and spreads different inputs across hues", () => {
  const { hashColor } = freshCussijn();
  assert.equal(hashColor("paypal.com"), hashColor("paypal.com"));
  assert.notEqual(hashColor("paypal.com"), hashColor("abnamro.nl"));
  assert.match(hashColor("paypal.com"), /^hsl\(\d+, 58%, 46%\)$/);
});

test("applyFilters ORs within a multi-tag selection, ANDs tag and address filters together", () => {
  const { applyFilters } = freshCussijn();
  const messages = [
    { tags: ["$a"], author: "x@paypal.com" },
    { tags: ["$b"], author: "y@paypal.com" },
    { tags: ["$a"], author: "z@other.com" },
    { tags: [], author: "w@paypal.com" },
  ];
  const byTagOnly = applyFilters(messages, { tagKeys: ["$a", "$b"] });
  assert.equal(byTagOnly.length, 3);

  const byTagAndAddress = applyFilters(messages, { tagKeys: ["$a", "$b"], addressText: "paypal.com" });
  assert.equal(byTagAndAddress.length, 2); // x and y - z has the tag but not the domain
});

test("applyFilters' address match spans From, To, Cc and Bcc - not just the sender", () => {
  const { applyFilters } = freshCussijn();
  const messages = [
    { author: "a@paypal.com" },                                   // matches via From
    { author: "a@other.com", recipients: ["b@paypal.com"] },      // matches via To
    { author: "a@other.com", ccList: ["c@paypal.com"] },          // matches via Cc
    { author: "a@other.com", bccList: ["d@paypal.com"] },         // matches via Bcc
    { author: "a@other.com", recipients: ["b@other.com"] },       // no match anywhere
  ];
  const result = applyFilters(messages, { addressText: "paypal.com" });
  assert.equal(result.length, 4);
});

test("applyFilters' hideSentByMe drops messages the account's own identity authored, needs myAddresses to do anything", () => {
  const { applyFilters } = freshCussijn();
  const messages = [
    { author: `"Me" <${ME}>` },  // my own reply
    { author: "other@x.com" },   // received
  ];
  const filtered = applyFilters(messages, { hideSentByMe: true }, [ME]);
  assert.deepEqual(filtered, [{ author: "other@x.com" }]);
  // Without myAddresses there's no "me" to match against - nothing gets hidden.
  assert.equal(applyFilters(messages, { hideSentByMe: true }).length, 2);
});

test("buildQuickFilterProps mirrors the same From/To/Cc/Bcc scope applyFilters used", () => {
  const { buildQuickFilterProps } = freshCussijn();
  const props = buildQuickFilterProps({ tagKeys: ["$cat_banking"], addressText: "paypal.com" });
  assert.deepEqual(props, {
    tags: { mode: "any", tags: { $cat_banking: true } },
    text: { text: "paypal.com", author: true, recipients: true },
    show: true,
  });
});

test("buildQuickFilterProps with nothing active just clears the quick filter", () => {
  const { buildQuickFilterProps } = freshCussijn();
  assert.deepEqual(buildQuickFilterProps({}), { show: false });
});

test("buildQuickFilterProps drops recipients for a senderOnly filter (domain/sender/message jump filters)", () => {
  const { buildQuickFilterProps } = freshCussijn();
  const props = buildQuickFilterProps({ addressText: "thadir@gmail.com", senderOnly: true });
  assert.deepEqual(props, {
    text: { text: "thadir@gmail.com", author: true, recipients: false },
    show: true,
  });
});

test("groupFor picks the right precomputed dimension", () => {
  const { groupFor } = freshCussijn();
  const node = {
    dominantTag: "Banking", tagBreakdown: { Banking: 3 },
    dominantDomain: "paypal.com", domainBreakdown: { "paypal.com": 3 },
    dominantAddressType: "Direct (To)", addressTypeBreakdown: { "Direct (To)": 3 },
    dominantYear: "2026", yearBreakdown: { "2026": 3 },
  };
  assert.deepEqual(groupFor(node, "tag"), { group: "Banking", breakdown: { Banking: 3 } });
  assert.deepEqual(groupFor(node, "domain"), { group: "paypal.com", breakdown: { "paypal.com": 3 } });
  assert.deepEqual(groupFor(node, "addressType"), { group: "Direct (To)", breakdown: { "Direct (To)": 3 } });
  assert.deepEqual(groupFor(node, "year"), { group: "2026", breakdown: { "2026": 3 } });
});

test("squarify covers the full rectangle and never overlaps", () => {
  const { squarify } = freshCussijn();
  const nodes = [{ id: "a", value: 50 }, { id: "b", value: 30 }, { id: "c", value: 20 }];
  const rects = squarify(nodes, 0, 0, 200, 100);

  assert.equal(rects.length, 3);
  const totalArea = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(totalArea - 200 * 100) < 1, `expected ~20000, got ${totalArea}`);

  for (const r of rects) {
    assert.ok(r.x >= -0.01 && r.x + r.w <= 200.01, "x out of bounds");
    assert.ok(r.y >= -0.01 && r.y + r.h <= 100.01, "y out of bounds");
  }
});

test("squarify gives more area to a larger value", () => {
  const { squarify } = freshCussijn();
  const rects = squarify([{ id: "big", value: 90 }, { id: "small", value: 10 }], 0, 0, 100, 100);
  const big = rects.find(r => r.node.id === "big");
  const small = rects.find(r => r.node.id === "small");
  assert.ok(big.w * big.h > small.w * small.h * 5);
});

// Regression test for a real bug: a wide container (a browser window's
// treemap area is much wider than tall) with realistic, skewed folder
// counts produced single-item-per-row bands with aspect ratios in the
// THOUSANDS - visibly broken in Thunderbird, not caught by the two small
// tests above (a 200x100 box with 2-3 similar-sized nodes never hits the
// bug, since the orientation error only compounds once a row's shrinking
// dimension keeps shrinking the SAME way every iteration - see the
// comment in squarify() itself). A correct squarified layout never lets
// aspect ratios run away like that, regardless of value skew or how
// non-square the container is.
test("squarify keeps cells close to square even for skewed values in a wide container", () => {
  const { squarify } = freshCussijn();
  const values = [1052, 268, 208, 131, 113, 90, 30, 25, 20, 18, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1];
  const nodes = values.map((v, i) => ({ id: "n" + i, value: v }));
  const W = 1900, H = 700;
  const rects = squarify(nodes, 0, 0, W, H);

  assert.equal(rects.length, values.length);
  const totalArea = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(totalArea - W * H) < 1, `expected ~${W * H}, got ${totalArea}`);

  for (const r of rects) {
    const aspect = Math.max(r.w, r.h) / Math.min(r.w, r.h);
    assert.ok(aspect < 6, `cell ${r.node.id} has aspect ratio ${aspect.toFixed(1)} - not remotely square`);
  }
});

test("nextDimension: folder -> active Group-by dimension -> sender -> message -> terminal, year -> month first", () => {
  const { nextDimension } = freshCussijn();
  assert.equal(nextDimension(null, "domain"), "domain");
  assert.equal(nextDimension(undefined, "tag"), "tag");
  assert.equal(nextDimension("tag", "tag"), "sender");
  assert.equal(nextDimension("domain", "domain"), "sender");
  assert.equal(nextDimension("addressType", "addressType"), "sender");
  assert.equal(nextDimension("year", "year"), "month"); // year's one extra hop
  assert.equal(nextDimension("month", "year"), "sender"); // then the chain resumes as usual
  assert.equal(nextDimension("sender", "domain"), "message");
  assert.equal(nextDimension("message", "domain"), null);
});

test("groupMessages partitions messages by domain and keeps each group's own message subset", () => {
  const { groupMessages } = freshCussijn();
  const messages = [
    { author: "a@paypal.com", size: 1000 },
    { author: "b@paypal.com", size: 2000 },
    { author: "c@klm.com", size: 500 },
  ];
  const nodes = groupMessages(messages, "domain", {}, []);
  const paypal = nodes.find((n) => n.groupKey === "paypal.com");
  assert.equal(paypal.count, 2);
  assert.equal(paypal.label, "paypal.com");
  assert.equal(paypal.messages.length, 2);
  assert.equal(paypal.size_mb, Math.round((3000 / 1024 / 1024) * 100) / 100);
  assert.equal(nodes[0].groupKey, "paypal.com"); // sorted by count descending
});

test("groupMessages by tag uses the message's first tag and falls back to Uncategorized", () => {
  const { groupMessages } = freshCussijn();
  const messages = [
    { tags: ["$cat_banking"] },
    { tags: ["$cat_banking", "$cat_travel"] },
    { tags: [] },
  ];
  const nodes = groupMessages(messages, "tag", { $cat_banking: "Banking" }, []);
  const banking = nodes.find((n) => n.label === "Banking");
  assert.equal(banking.count, 2);
  assert.equal(banking.groupKey, "$cat_banking"); // raw key, for jumpFilterFor
  const uncategorized = nodes.find((n) => n.label === "Uncategorized");
  assert.equal(uncategorized.groupKey, "");
});

test("groupMessages by sender and address type", () => {
  const { groupMessages } = freshCussijn();
  const senderNodes = groupMessages([{ author: "a@x.com" }, { author: "a@x.com" }], "sender", {}, []);
  assert.equal(senderNodes[0].groupKey, "a@x.com");
  assert.equal(senderNodes[0].count, 2);

  const addrNodes = groupMessages([{ recipients: [ME] }, { ccList: [ME] }], "addressType", {}, [ME]);
  assert.deepEqual(new Set(addrNodes.map((n) => n.label)), new Set(["Direct (To)", "Cc"]));
});

test("groupMessages by year partitions by calendar year, colored by hashColor like domain/sender", () => {
  const { groupMessages } = freshCussijn();
  const nodes = groupMessages(
    [{ date: "2025-01-01" }, { date: "2025-06-01" }, { date: "2026-01-01" }],
    "year", {}, []
  );
  const y2025 = nodes.find((n) => n.groupKey === "2025");
  assert.equal(y2025.count, 2);
  assert.equal(y2025.label, "2025");
});

test("groupMessages by month partitions by calendar month name - the extra hop after year", () => {
  const { groupMessages } = freshCussijn();
  const nodes = groupMessages(
    [{ date: "2025-01-05" }, { date: "2025-01-20" }, { date: "2025-06-01" }],
    "month", {}, []
  );
  const jan = nodes.find((n) => n.groupKey === "January");
  assert.equal(jan.count, 2);
  assert.equal(jan.label, "January");
  assert.ok(nodes.some((n) => n.groupKey === "June"));
});

test("groupMessages by message: one node per email, labeled by subject, colored by its own sender", () => {
  const { groupMessages } = freshCussijn();
  const messages = [
    { id: 1, author: "a@paypal.com", subject: "Your receipt" },
    { id: 2, author: "b@klm.com", subject: "Boarding pass" },
  ];
  const nodes = groupMessages(messages, "message", {}, []);
  assert.equal(nodes.length, 2); // always a true partition - one email per cell
  const receipt = nodes.find((n) => n.label === "Your receipt");
  assert.equal(receipt.groupKey, "1");
  assert.equal(receipt.colorKey, "a@paypal.com"); // colored by sender, not the (unique, useless-for-color) message id
  assert.equal(receipt.count, 1);
});

test("groupMessages folds groups past the cap into one overflow node instead of one cell each", () => {
  const { groupMessages } = freshCussijn();
  const messages = [];
  for (let i = 0; i < 250; i++) messages.push({ id: i, author: `sender${i}@x.com` });
  const nodes = groupMessages(messages, "sender", {}, []);
  assert.equal(nodes.length, 200); // MAX_GROUP_NODES - the top 199 individually, plus 1 overflow node
  const overflow = nodes.find((n) => n.isOverflow);
  assert.ok(overflow, "expected an overflow node");
  assert.equal(overflow.groupKey, null);
  assert.equal(overflow.colorKey, null);
  assert.equal(overflow.count, 250 - 199);
});

test("groupMessages caps 'message' groups much lower than other dimensions - every message is the same size, unlike a domain/sender breakdown", () => {
  const { groupMessages } = freshCussijn();
  const messages = [];
  for (let i = 0; i < 60; i++) messages.push({ id: i, author: `a${i}@x.com`, subject: `msg ${i}` });
  const nodes = groupMessages(messages, "message", {}, []);
  assert.equal(nodes.length, 40); // MAX_MESSAGE_NODES - the top 39 individually, plus 1 overflow node
  const overflow = nodes.find((n) => n.isOverflow);
  assert.ok(overflow, "expected an overflow node");
  assert.equal(overflow.count, 60 - 39);
});

test("jumpFilterFor: tag and domain/sender refine the search, addressType can't - message falls back to its own sender", () => {
  const { jumpFilterFor } = freshCussijn();
  assert.deepEqual(jumpFilterFor("tag", "$cat_banking"), { tagKeys: ["$cat_banking"] });
  assert.deepEqual(jumpFilterFor("tag", ""), {}); // Uncategorized has no tag to filter by
  // domain/sender/message are computed from a message's author alone, so their
  // jump filter is marked senderOnly - buildQuickFilterProps() reads this to
  // search the sender field only, not sender+recipients (see there for why:
  // your own address as a "sender" bucket would otherwise match nearly every
  // message in the account, since you're also the recipient of most of them).
  assert.deepEqual(jumpFilterFor("domain", "paypal.com"), { addressText: "paypal.com", senderOnly: true });
  assert.deepEqual(jumpFilterFor("sender", "a@x.com"), { addressText: "a@x.com", senderOnly: true });
  assert.deepEqual(jumpFilterFor("addressType", "Cc"), {}); // no CC-only quick filter match
  assert.deepEqual(jumpFilterFor("year", "2026"), {}); // no date/age quick filter match
  // No "is exactly this one message" quick filter match exists, but a message
  // group is always a singleton - its own sender is right there, so use that
  // instead of giving up on narrowing entirely (found live: right-clicking a
  // drilled-into message opened the folder with no filter at all).
  assert.deepEqual(
    jumpFilterFor("message", "1", { author: "Steam <noreply@steampowered.com>" }),
    { addressText: "Steam <noreply@steampowered.com>", senderOnly: true }
  );
  assert.deepEqual(jumpFilterFor("message", "1", null), {});
});

test("colorForKey: tag looks up the tag palette by label, domain/sender/message/year hash, addressType uses a fixed slot, null is muted", () => {
  const { colorForKey } = freshCussijn();
  const tagPalette = { Banking: "#2a78d6" };
  assert.equal(colorForKey("tag", "Banking", tagPalette), "#2a78d6");
  assert.equal(colorForKey("tag", "Unknown", tagPalette), "#898781"); // UNCATEGORIZED_COLOR fallback
  assert.equal(colorForKey("domain", "paypal.com", {}), colorForKey("sender", "paypal.com", {}));
  assert.equal(colorForKey("sender", "paypal.com", {}), colorForKey("message", "paypal.com", {}));
  assert.equal(colorForKey("year", "2026", {}), colorForKey("domain", "2026", {})); // same hashColor() mechanism
  assert.match(colorForKey("domain", "paypal.com", {}), /^hsl\(/);
  assert.match(colorForKey("addressType", "Cc", {}), /^#[0-9a-f]{6}$/);
  // month is a bounded set of 12, like addressType - a fixed palette slot, not a hash.
  assert.match(colorForKey("month", "March", {}), /^#[0-9a-f]{6}$/);
  assert.notEqual(colorForKey("month", "March", {}), colorForKey("month", "April", {}));
  assert.equal(colorForKey("sender", null, {}), "#5a5a57"); // groupMessages()'s overflow node
});

test("accountIdFromFolderId reads the account id encoded in a real MailFolderId (\"<accountId>://<path>\")", () => {
  const { accountIdFromFolderId } = freshCussijn();
  assert.equal(accountIdFromFolderId("account4://INBOX"), "account4");
  assert.equal(accountIdFromFolderId("account1://Some/Nested/Path"), "account1");
  assert.equal(accountIdFromFolderId(null), null);
  assert.equal(accountIdFromFolderId(""), null);
  assert.equal(accountIdFromFolderId("not-a-folder-id"), null);
});

test("accountDisplayName prefers the account's own identity email over its Thunderbird display name", () => {
  const { accountDisplayName } = freshCussijn();
  assert.equal(
    accountDisplayName({ name: "My IMAP account", identities: [{ email: "thadir@thadir.net" }] }),
    "thadir@thadir.net"
  );
  assert.equal(accountDisplayName({ name: "No identities here", identities: [] }), "No identities here");
  assert.equal(accountDisplayName({ name: "No identities key" }), "No identities key");
});

test("assignPalette gives every tag a distinct, stable color", () => {
  const { assignPalette } = freshCussijn();
  const palette = assignPalette(["Banking", "Travel", "Personal"]);
  const colors = Object.values(palette);
  assert.equal(new Set(colors).size, colors.length, "colors should be unique");
  assert.equal(palette.Uncategorized, "#898781");
});
