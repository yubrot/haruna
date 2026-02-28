# dump — Session Recording

Binary format for recording and replaying terminal sessions. A dump file
is a sequence of framed records: a header (session metadata), followed by
keyframes (full snapshots) and deltas (incremental diffs), each tagged
with a timestamp and encoded via MessagePack.
