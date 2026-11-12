// Invariants of the busybox cursor primitives. These are the rules that three
// separate bugs violated when they were hand-rolled at call sites.
import * as C from "../src/engine/cursor.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

console.log("\n\x1b[1mright / left never cross a line boundary\x1b[0m");
eq("right at the last char of a line parks on the newline", C.right("ab\ncd", 1), 2);
eq("right at the last char of the buffer stops", C.right("ab", 1), 1);
eq("right on an empty line stays", C.right("a\n\nb", 2), 2);
eq("right on a newline stays", C.right("ab\ncd", 2), 2);
eq("left at column 1 stays", C.left("ab\ncd", 3), 3);
// moving left FROM a newline lands on the previous line's last character, which
// is busybox's dot_left (dot[-1] is not a newline there)
eq("left from a newline reaches the previous line", C.left("ab\ncd", 2), 1);
eq("left mid-line moves", C.left("abcd", 2), 1);
eq("left at the buffer start stays", C.left("ab", 0), 0);

console.log("\n\x1b[1mline primitives\x1b[0m");
eq("beginLine", C.beginLine("ab\ncd", 4), 3);
eq("endLine is the last character", C.endLine("ab\ncd", 0), 1);
eq("endLine on an empty line is the line start", C.endLine("a\n\nb", 2), 2);
eq("endLine on the last line", C.endLine("ab\ncd", 3), 4);
eq("nextLine", C.nextLine("ab\ncd", 1), 3);
eq("nextLine at the last line stays", C.nextLine("ab\ncd", 4), 4);
eq("prevLine", C.prevLine("ab\ncd", 4), 0);
eq("prevLine on the first line stays", C.prevLine("ab\ncd", 1), 1);
eq("skipBlank", C.skipBlank("   ab", 0), 3);

console.log("\n\x1b[1mthe cases that used to be bugs\x1b[0m");
eq("a on an empty line stays on it", C.right("\n", 0), 0);
eq("a on an empty middle line", C.right("a\n\nb", 2), 2);
eq("leaving insert at column 1 stays", C.left("ab\ncd", 3), 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
