# Changelog

## v1.0.1 - bugfix

From #17.

## v1.0.0 - major

First public release: a SequoiaView-style treemap of your Thunderbird
mailbox. Each folder is a rectangle sized by message count or size,
colored by tag, sender domain, To/Cc/Bcc address type, or year - drill
in through the real folder tree, then by whichever dimension you're
grouping by, down to individual messages, with a "Depth" control to
show several of those levels nested at once. Filter by tag, address,
or "Hide sent by me", and jump from any cell straight to a live,
filtered Thunderbird search. Entirely local and read-only: no network
access, no companion process.

Entries below are added automatically by `.github/workflows/release.yml`
when a `release/vX.Y.Z` bump PR merges - see that file for how a
major/minor/bugfix release gets triggered.
