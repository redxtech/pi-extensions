import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch } from "../parser.ts";

test("parses add, update, move, and delete actions", () => {
	const patch = parsePatch(`*** Begin Patch
*** Add File: added.txt
+hello
*** Update File: source.txt
*** Move to: moved.txt
@@ function run()
-old
+new
*** Delete File: removed.txt
*** End Patch`);
	assert.equal(patch.actions.length, 3);
	assert.deepEqual(patch.actions.map((action) => action.kind), ["add", "update", "delete"]);
	assert.equal(patch.actions[0]?.kind === "add" && patch.actions[0].content, "hello\n");
	assert.equal(patch.actions[1]?.kind === "update" && patch.actions[1].moveTo, "moved.txt");
});

test("accepts the first update chunk without an explicit hunk header", () => {
	const patch = parsePatch(`*** Begin Patch
*** Update File: file.txt
-old
+new
*** End Patch`);
	assert.equal(patch.actions[0]?.kind === "update" && patch.actions[0].chunks.length, 1);
});

test("rejects add lines without a plus marker", () => {
	assert.throws(
		() => parsePatch(`*** Begin Patch
*** Add File: file.txt
invalid
*** End Patch`),
		/each line must start with '\+'/,
	);
});

test("rejects update hunks without a change", () => {
	assert.throws(
		() => parsePatch(`*** Begin Patch
*** Update File: file.txt
@@
 unchanged
*** End Patch`),
		/has no changes/,
	);
});

test("rejects unmarked lines after an end-of-file marker", () => {
	assert.throws(
		() => parsePatch(`*** Begin Patch
*** Update File: file.txt
@@
-old
+new
*** End of File
invalid
*** End Patch`),
		/Expected an update hunk header/,
	);
});
