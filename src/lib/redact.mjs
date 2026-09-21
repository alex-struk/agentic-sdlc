// Egress rule E-2 keeps the machine a run happened on out of the repository the run
// commits to. Agent turns, container logs, test errors and npm's own output all carry
// absolute paths — `/home/<person>/…`, `/Users/<person>/…`, `C:\Users\<person>\…` — and a
// check that only catches them once they are committed catches them too late.
//
// The project's own directory becomes a relative path, because a reader of the repository
// is standing in it; any other local home path keeps its tail and loses the root that
// names a machine and a person.
//
// It lives here, rather than beside the first thing that needed it, because every writer
// of agent-produced text into a committed file needs the same answer: the journal, a
// proposal page, a ruling's rationale and conditions, a verify result, the run record, and
// the whole published site. One of them applying a different rule to the same string is
// how a path that was scrubbed in one place reaches the branch through another.
export function redactLocalPaths(text, projectDir) {
  return String(text)
    .split(projectDir).join(".")
    .replace(/(?<![A-Za-z0-9._-])\/home\/[A-Za-z0-9._-]+/g, "~")
    .replace(/(?<![A-Za-z0-9._-])\/Users\/[A-Za-z0-9._-]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, "~");
}
