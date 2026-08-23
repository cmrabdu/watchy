import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchy-os-"));
process.env.MEDIA_DIR = dir;
process.env.SESSION_SECRET = "test-secret-abcdefgh";
delete process.env.OPENSUBTITLES_API_KEY;

const { movieHash, decodeSubtitle, hasOpenSubtitles, searchSubtitles, OpenSubtitlesDisabled } =
  await import("../dist/opensubtitles.js");

/** Référence écrite depuis la spec publiée, indépendante de l'implémentation. */
function referenceHash(file) {
  const CHUNK = 65536;
  const size = fs.statSync(file).size;
  const mask = (1n << 64n) - 1n;
  let h = BigInt(size) & mask;
  const fd = fs.openSync(file, "r");
  try {
    for (const off of [0, size - CHUNK]) {
      const buf = Buffer.alloc(CHUNK);
      fs.readSync(fd, buf, 0, CHUNK, off);
      for (let i = 0; i < CHUNK; i += 8) h = (h + buf.readBigUInt64LE(i)) & mask;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.toString(16).padStart(16, "0");
}

test("15 — le hash OpenSubtitles suit la spec", async () => {
  const file = path.join(dir, "rip.mkv");
  fs.writeFileSync(file, crypto.randomBytes(200_000));
  const got = await movieHash(file);
  assert.equal(got.hash, referenceHash(file));
  assert.equal(got.hash.length, 16);
  assert.equal(got.size, 200_000);
});

test("15 — un fichier plus petit que 128 Ko n'a pas de hash", async () => {
  const file = path.join(dir, "petit.mkv");
  fs.writeFileSync(file, Buffer.alloc(1000));
  await assert.rejects(() => movieHash(file), /trop petit/);
});

test("15 — un sous-titre arabe en windows-1256 devient lisible", () => {
  // مرحبا encodé en cp1256 : illisible si on le prend pour de l'UTF-8.
  const cp1256 = Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]);
  assert.equal(decodeSubtitle(cp1256, "ar"), "مرحبا");
  // Un fichier déjà en UTF-8 n'est pas abîmé au passage.
  assert.equal(decodeSubtitle(Buffer.from("مرحبا", "utf8"), "ar"), "مرحبا");
  assert.equal(decodeSubtitle(Buffer.from("Bonjour", "utf8"), "fr"), "Bonjour");
});

test("15 — sans clé, la fonctionnalité se désactive proprement", async () => {
  assert.equal(hasOpenSubtitles(), false);
  await assert.rejects(
    () => searchSubtitles({ query: "matrix", languages: ["ar"] }),
    OpenSubtitlesDisabled,
    "pas d'appel réseau, une erreur typée",
  );
});
