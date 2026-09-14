"""Generates a throwaway Thunderbird profile seeded with a synthetic
Local Folders account and a handful of entirely made-up messages -
fake senders, fake domains (all *.test, IANA-reserved for exactly this:
https://www.rfc-editor.org/rfc/rfc2606), fake subjects. Nothing here is
derived from anyone's real mailbox; that's what makes it safe to use
for a screenshot at all.

Verified live, not assumed: a raw mbox file dropped into a fresh
profile's Mail/Local Folders/ is NOT auto-indexed by Thunderbird on
startup - CussijnLibrary.index_local_inbox() has to call the real
nsIMsgLocalMailFolder.parseFolder() (chrome-only XPCOM, not reachable
via any messenger.* WebExtension API) to force it, found by trial
against a real Thunderbird before writing this fixture generator
around it.

Thunderbird's five default tag keys ($label1-$label5 ->
Important/Work/Personal/To Do/Later) are built in and don't need
declaring in prefs.js - confirmed live (the filter bar showed all five
chips despite this fixture never mentioning most of them).
"""

import email.utils
import os
import random
import time

PREFS = """\
user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.server.server1.type", "none");
user_pref("mail.server.server1.userName", "nobody");
user_pref("mail.server.server1.hostname", "Local Folders");
user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/Local Folders");
user_pref("mail.server.server1.name", "Local Folders");
user_pref("mail.identity.id1.fullName", "Test User");
user_pref("mail.identity.id1.useremail", "test.user@example.test");
user_pref("mail.identity.id1.valid", true);
user_pref("mail.accountmanager.accounts", "account1");
user_pref("mail.accountmanager.localfoldersserver", "server1");
user_pref("mail.accountmanager.defaultaccount", "account1");
// Suppresses Thunderbird's first-run "your rights" notification bar,
// which otherwise sits at the bottom of every screenshot.
user_pref("mail.rights.version", 1);
"""

IMPORTANT, WORK, PERSONAL, TODO, LATER = (
    "$label1", "$label2", "$label3", "$label4", "$label5"
)

# (sender, [(subject, [tag keys]), ...]) - entirely fictional, *.test domains.
SENDERS = [
    ("billing@examplepay.test", [
        ("Your monthly statement is ready", [WORK]),
        ("Payment received - thank you", [WORK]),
        ("Receipt for your recent purchase", []),
        ("Payment failed - please update your card", [IMPORTANT]),
    ]),
    ("newsletter@examplenews.test", [
        ("This week in tech", []),
        ("Weekly digest #42", []),
        ("Breaking: something happened", []),
    ]),
    ("alerts@exampletravel.test", [
        ("Your booking is confirmed", [IMPORTANT]),
        ("Check-in opens in 24 hours", [LATER]),
        ("Itinerary for your upcoming trip", [LATER]),
    ]),
    ("noreply@examplesocial.test", [
        ("You have 3 new notifications", []),
        ("Someone mentioned you in a comment", []),
    ]),
    ("team@examplework.test", [
        ("Sprint planning notes", [WORK]),
        ("Meeting rescheduled to Thursday", [WORK, TODO]),
        ("Q3 roadmap draft", [WORK]),
        ("Please review this PR", [WORK, TODO]),
    ]),
    ("hr@examplework.test", [
        ("Reminder: benefits enrollment", [WORK]),
        ("Holiday schedule for next year", []),
    ]),
    ("family@examplemail.test", [
        ("Dinner this weekend?", [PERSONAL]),
        ("Photos from the trip", [PERSONAL]),
    ]),
    ("support@exampleisp.test", [
        ("Your service ticket has been resolved", []),
        ("Scheduled maintenance notice", [LATER]),
    ]),
]


def _fake_message(frm, to, subject, tags, days_ago, uid):
    date = email.utils.formatdate(time.time() - days_ago * 86400)
    lines = [
        f"From - {date}",
        f"From: {frm}",
        f"To: {to}",
        f"Subject: {subject}",
        f"Date: {date}",
        f"Message-ID: <{uid}.fake@example.test>",
    ]
    if tags:
        lines.append(f"X-Mozilla-Keys: {' '.join(tags)}")
    lines.append("")
    lines.append(f"This is a fake fixture message: {subject}")
    lines.append("")
    return "\n".join(lines) + "\n"


def generate(profile_dir, seed=42):
    """Writes prefs.js and Mail/Local Folders/Inbox into profile_dir."""
    random.seed(seed)

    with open(os.path.join(profile_dir, "prefs.js"), "w") as f:
        f.write(PREFS)

    mail_dir = os.path.join(profile_dir, "Mail", "Local Folders")
    os.makedirs(mail_dir, exist_ok=True)

    messages = []
    uid = 0
    day = 0
    for frm, subjects in SENDERS:
        for subject, tags in subjects:
            day += random.randint(1, 3)
            messages.append(_fake_message(
                frm, "test.user@example.test", subject, tags, day, uid
            ))
            uid += 1

    with open(os.path.join(mail_dir, "Inbox"), "w") as f:
        f.write("".join(messages))

    return len(messages)


if __name__ == "__main__":
    import sys
    target = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cussijn-fixture-profile"
    os.makedirs(target, exist_ok=True)
    n = generate(target)
    print(f"Wrote a {n}-message fixture profile to {target}")
