/**
 * The pipeline definitions the browser ships must be byte-for-byte the files
 * the engine runs (`.rocketride/*.pipe`). A mirror that has drifted is the
 * worst kind of bug: the app runs an older shape of the job and nothing says
 * so. Each job must also keep its own project id, or `useExisting` hands back
 * somebody else's pipeline.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mirrorDir = path.resolve(__dirname, "..", "pipelines");
const pipeDir = path.resolve(__dirname, "..", "..", "..", ".rocketride");

const mirrors = fs
  .readdirSync(mirrorDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("pipeline mirrors", () => {
  it("has a mirror for the browser to load", () => {
    expect(mirrors.length).toBeGreaterThan(0);
    expect(fs.existsSync(pipeDir)).toBe(true);
  });

  it.each(mirrors)("%s is an exact copy of the file the engine runs", (name) => {
    const pipe = path.join(pipeDir, `${path.basename(name, ".json")}.pipe`);
    expect(fs.existsSync(pipe)).toBe(true);
    const mirrored = fs.readFileSync(path.join(mirrorDir, name));
    const original = fs.readFileSync(pipe);
    // compared as bytes: whitespace and key order count, a reformat is drift
    expect(mirrored.equals(original)).toBe(true);
  });

  it("gives every job its own project id", () => {
    const seen = new Map<string, string>();
    for (const name of mirrors) {
      const raw = JSON.parse(fs.readFileSync(path.join(mirrorDir, name), "utf8")) as { project_id?: string };
      const id = raw.project_id ?? "";
      expect(id, `${name} has no project id`).toMatch(/\S/);
      expect(seen.get(id), `${name} reuses the project id of ${seen.get(id)}`).toBeUndefined();
      seen.set(id, name);
    }
    expect(seen.size).toBe(mirrors.length);
  });

  it("keeps the engine's own copies unique too", () => {
    const pipes = fs.readdirSync(pipeDir).filter((name) => name.endsWith(".pipe")).sort();
    const seen = new Map<string, string>();
    for (const name of pipes) {
      const raw = JSON.parse(fs.readFileSync(path.join(pipeDir, name), "utf8")) as { project_id?: string };
      const id = raw.project_id ?? "";
      expect(id, `${name} has no project id`).toMatch(/\S/);
      expect(seen.get(id), `${name} reuses the project id of ${seen.get(id)}`).toBeUndefined();
      seen.set(id, name);
    }
  });
});
