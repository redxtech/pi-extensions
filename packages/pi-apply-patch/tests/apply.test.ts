import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyPatch } from "../apply.ts";

function temporaryDirectory(): string {
	return mkdtempSync(join(tmpdir(), "local-pi-apply-patch-"));
}

const options = (cwd: string, allowAbsolutePaths = false) => ({ cwd, allowAbsolutePaths });

test("adds, updates, moves, and deletes files", async () => {
	const cwd = temporaryDirectory();
	writeFileSync(join(cwd, "source.txt"), "header\nold\nfooter\n");
	writeFileSync(join(cwd, "removed.txt"), "remove me\n");

	const result = await applyPatch(`*** Begin Patch
*** Add File: added.txt
+hello
+world
*** Update File: source.txt
*** Move to: moved.txt
@@
 header
-old
+new
 footer
*** Delete File: removed.txt
*** End Patch`, options(cwd));

	assert.equal(readFileSync(join(cwd, "added.txt"), "utf8"), "hello\nworld\n");
	assert.equal(readFileSync(join(cwd, "moved.txt"), "utf8"), "header\nnew\nfooter\n");
	assert.equal(existsSync(join(cwd, "source.txt")), false);
	assert.equal(existsSync(join(cwd, "removed.txt")), false);
	assert.equal(result.files.length, 3);
});

test("uses a hunk context header for a pure insertion", async () => {
	const cwd = temporaryDirectory();
	writeFileSync(join(cwd, "file.txt"), "class First\nclass Second\n");
	await applyPatch(`*** Begin Patch
*** Update File: file.txt
@@ class First
+inserted
*** End Patch`, options(cwd));
	assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "class First\ninserted\nclass Second\n");
});

test("rejects ambiguous exact context", async () => {
	const cwd = temporaryDirectory();
	writeFileSync(join(cwd, "file.txt"), "same\nsame\n");
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Update File: file.txt
@@
-same
+changed
*** End Patch`, options(cwd)),
		/ambiguous/,
	);
	assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "same\nsame\n");
});

test("plans the complete patch before it writes files", async () => {
	const cwd = temporaryDirectory();
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Add File: added.txt
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch`, options(cwd)),
		/file does not exist/,
	);
	assert.equal(existsSync(join(cwd, "added.txt")), false);
});

test("rejects add and move overwrites", async () => {
	const cwd = temporaryDirectory();
	writeFileSync(join(cwd, "existing.txt"), "existing\n");
	writeFileSync(join(cwd, "source.txt"), "old\n");
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Add File: existing.txt
+new
*** End Patch`, options(cwd)),
		/already exists/,
	);
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Update File: source.txt
*** Move to: existing.txt
@@
-old
+new
*** End Patch`, options(cwd)),
		/destination already exists/,
	);
});

test("preserves CRLF and missing final newlines", async () => {
	const cwd = temporaryDirectory();
	writeFileSync(join(cwd, "crlf.txt"), "old\r\nend\r\n");
	writeFileSync(join(cwd, "no-newline.txt"), "old");
	await applyPatch(`*** Begin Patch
*** Update File: crlf.txt
@@
-old
+new
 end
*** Update File: no-newline.txt
@@
-old
+new
*** End Patch`, options(cwd));
	assert.equal(readFileSync(join(cwd, "crlf.txt"), "utf8"), "new\r\nend\r\n");
	assert.equal(readFileSync(join(cwd, "no-newline.txt"), "utf8"), "new");
});

test("rejects mixed carriage returns", async () => {
	const cwd = temporaryDirectory();
	writeFileSync(join(cwd, "mixed.txt"), "first\r\nsecond\rthird\r\n");
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Update File: mixed.txt
@@
-second
+changed
*** End Patch`, options(cwd)),
		/unsupported carriage returns/,
	);
});

test("enforces end-of-file markers for pure insertions", async () => {
	const cwd = temporaryDirectory();
	writeFileSync(join(cwd, "file.txt"), "first\nsecond\n");
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Update File: file.txt
@@ first
+inserted
*** End of File
*** End Patch`, options(cwd)),
		/does not match the end/,
	);
});

test("rejects relative traversal and symlink escapes", async () => {
	const cwd = temporaryDirectory();
	const outside = temporaryDirectory();
	symlinkSync(outside, join(cwd, "outside"), "dir");
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Add File: ../escape.txt
+no
*** End Patch`, options(cwd)),
		/escapes the workspace/,
	);
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Add File: outside/escape.txt
+no
*** End Patch`, options(cwd)),
		/through a symlink/,
	);
	assert.equal(existsSync(join(outside, "escape.txt")), false);
});

test("allows configured absolute paths but still rejects relative traversal", async () => {
	const cwd = temporaryDirectory();
	const outside = join(temporaryDirectory(), "absolute.txt");
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Add File: ${outside}
+no
*** End Patch`, options(cwd)),
		/Absolute patch paths are disabled/,
	);
	await assert.rejects(
		applyPatch(`*** Begin Patch
*** Add File: ../relative.txt
+no
*** End Patch`, options(cwd, true)),
		/escapes the workspace/,
	);
	await applyPatch(`*** Begin Patch
*** Add File: ${outside}
+yes
*** End Patch`, options(cwd, true));
	assert.equal(readFileSync(outside, "utf8"), "yes\n");
	assert.equal(dirname(outside) === cwd, false);
});

test("queues every target path in sorted order", async () => {
	const cwd = temporaryDirectory();
	const queued: string[] = [];
	await applyPatch(`*** Begin Patch
*** Add File: z.txt
+z
*** Add File: a.txt
+a
*** End Patch`, {
		...options(cwd),
		queueMutation: async (path, operation) => {
			queued.push(path);
			return operation();
		},
	});
	assert.deepEqual(queued, [join(cwd, "a.txt"), join(cwd, "z.txt")]);
});
