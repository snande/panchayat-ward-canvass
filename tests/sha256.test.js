import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sha256Hex } from "../src/decoder/sha256.js";

test("sha256Hex matches the FIPS 180-4 vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // 56 bytes: the padding spills into a second block.
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("sha256Hex agrees with node:crypto across block boundaries and UTF-8", () => {
  for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
    const bytes = randomBytes(n);
    assert.equal(sha256Hex(new Uint8Array(bytes)), createHash("sha256").update(bytes).digest("hex"), `length ${n}`);
  }
  const s = "M 102,-31|Q 102,210 350,210 नाम";
  assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"));
});
