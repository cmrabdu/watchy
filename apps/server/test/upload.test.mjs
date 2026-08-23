import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchy-up-"));
process.env.MEDIA_DIR = dir;
process.env.SESSION_SECRET = "test-secret-abcdefgh";

const { appendUploadChunk, uploadStatus, abortUpload, sanitizeUploadName, saveUploadStream } =
  await import("../dist/upload.js");

const web = (buf) => Readable.toWeb(Readable.from([buf]));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("13 — un envoi coupé reprend là où il s'est arrêté, octet pour octet", async () => {
  const data = crypto.randomBytes(300_000);
  const total = data.length;
  const a = data.subarray(0, 100_000);
  const b = data.subarray(100_000, 250_000);
  const c = data.subarray(250_000);

  let r = await appendUploadChunk("Grand.mkv", web(a), 0, 99_999, total);
  assert.equal(r.complete, false);
  assert.equal(r.offset, 100_000);

  // La ligne casse ici : le serveur doit savoir où on en est.
  assert.equal((await uploadStatus("Grand.mkv")).offset, 100_000);

  r = await appendUploadChunk("Grand.mkv", web(b), 100_000, 249_999, total);
  assert.equal(r.offset, 250_000);
  r = await appendUploadChunk("Grand.mkv", web(c), 250_000, total - 1, total);
  assert.equal(r.complete, true);
  assert.equal(r.filename, "Grand.mkv");
  assert.equal(r.size, total);
  assert.equal(sha(fs.readFileSync(path.join(dir, "Grand.mkv"))), sha(data),
    "le fichier reconstitué est identique à l'original");
});

test("13 — une reprise désalignée est refusée avec l'offset réel", async () => {
  const data = crypto.randomBytes(50_000);
  await appendUploadChunk("Desal.mkv", web(data.subarray(0, 20_000)), 0, 19_999, 50_000);
  await assert.rejects(
    () => appendUploadChunk("Desal.mkv", web(data.subarray(0, 20_000)), 0, 19_999, 50_000),
    (err) => {
      assert.match(err.message, /désalignée/);
      assert.equal(err.offset, 20_000);
      return true;
    },
  );
  assert.equal((await uploadStatus("Desal.mkv")).offset, 20_000, "le .part est intact");
  assert.equal(await abortUpload("Desal.mkv"), true);
  assert.equal((await uploadStatus("Desal.mkv")).offset, 0);
});

test("7 — une vidéo de même nom n'est jamais écrasée en silence", async () => {
  fs.writeFileSync(path.join(dir, "Doublon.mkv"), "original qu'on regarde peut-être");
  const saved = await saveUploadStream("Doublon.mkv", web(Buffer.from("nouveau")), "suffix");
  assert.equal(saved.filename, "Doublon (2).mkv");
  assert.equal(saved.replaced, false);
  assert.equal(fs.readFileSync(path.join(dir, "Doublon.mkv"), "utf8"),
    "original qu'on regarde peut-être", "l'original est intact");
});

test("7 — un sous-titre de même nom est remplacé, et le dit", async () => {
  fs.writeFileSync(path.join(dir, "Film.ar.srt"), "vieux");
  const saved = await saveUploadStream("Film.ar.srt", web(Buffer.from("corrigé")), "overwrite");
  assert.equal(saved.filename, "Film.ar.srt");
  assert.equal(saved.replaced, true);
});

test("9 — les extensions de sous-titres acceptées", () => {
  for (const n of ["a.srt", "a.vtt", "a.ass", "a.ssa", "a.mkv", "a.mp4"]) {
    assert.ok(sanitizeUploadName(n), `${n} accepté`);
  }
  assert.equal(sanitizeUploadName("a.exe"), null);
  assert.equal(sanitizeUploadName("../../etc/passwd"), null);
});
