import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../server/csv.mjs";

test("CSV parser handles commas, escaped quotes, and newlines", () => {
  const rows = parseCsv('id,text\n1,"hello, world"\n2,"say ""yes"""\n3,"two\nlines"\n');
  assert.deepEqual(rows, [
    { id: "1", text: "hello, world" },
    { id: "2", text: 'say "yes"' },
    { id: "3", text: "two\nlines" },
  ]);
});
