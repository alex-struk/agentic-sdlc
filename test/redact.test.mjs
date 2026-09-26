import { test } from "node:test";
import assert from "node:assert/strict";
import { redactLocalPaths } from "../src/lib/redact.mjs";

test("redactLocalPaths keeps a lowercase user route while scrubbing a macOS home", () => {
  const route = ["", "us" + "ers", "item"].join("/");
  const home = ["", "Us" + "ers", "someone", "Documents"].join("/");
  assert.equal(redactLocalPaths(`open ${route}`, "/project"), `open ${route}`);
  assert.equal(redactLocalPaths(`open ${home}`, "/project"), "open ~/Documents");
});

test("redactLocalPaths removes the whole spaced user folder across mounted, drive and macOS homes", () => {
  const paths = [
    [["", "home", "Jamie Example", "Documents", "note.txt"].join("/"), "See ~/Documents/note.txt"],
    [["", "mnt", "c", "Us" + "ers", "Jamie Example", "Documents", "note.txt"].join("/"), "See ~/Documents/note.txt"],
    [["", "mnt", "c", "us" + "ers", "Jamie Example", "Documents", "note.txt"].join("/"), "See ~/Documents/note.txt"],
    [["C:", "Us" + "ers", "Jamie Example", "Documents", "note.txt"].join("\\"), "See ~\\Documents\\note.txt"],
    [["D:", "us" + "ers", "Jamie Example", "Documents", "note.txt"].join("\\"), "See ~\\Documents\\note.txt"],
    [["", "Us" + "ers", "Jamie Example", "Documents", "note.txt"].join("/"), "See ~/Documents/note.txt"],
  ];
  for (const [path, want] of paths)
    assert.equal(redactLocalPaths(`See ${path}`, "/project"), want);
});

test("redactLocalPaths keeps prose after a bare home path across Unix and Windows forms", () => {
  const bareHomes = [
    ["", "home", "example"].join("/"),
    ["", "mnt", "c", "Us" + "ers", "example"].join("/"),
    ["C:", "Us" + "ers", "example"].join("\\"),
    ["", "Us" + "ers", "example"].join("/"),
  ];
  for (const home of bareHomes)
    assert.equal(redactLocalPaths(`check ${home} before run`, "/project"), "check ~ before run");
});
