/**
 * The queued writer is what stands between a producer's rapid changes and a
 * file that ends up holding the wrong one. It must never let a slow first
 * write land on top of a newer second one, must collapse a burst into one
 * write of the newest work, and must keep one file's trouble away from
 * another's.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  flushQueuedSaves,
  getQueuedSaveState,
  reframeLayoutOf,
  resetQueuedSaves,
  saveJsonQueued,
  setQueuedWriter,
  subscribeQueuedSave,
} from "../engine";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  setQueuedWriter(null);
  resetQueuedSaves();
});

describe("saveJsonQueued", () => {
  it("collapses a burst into one write of the newest work while the first is still in the air", async () => {
    const writes: [string, unknown][] = [];
    const first = deferred();
    let n = 0;
    setQueuedWriter(async (path, value) => {
      writes.push([path, value]);
      if (n++ === 0) await first.promise;
    });

    const a = saveJsonQueued("clip", "edits.json", { v: 1 });
    const b = saveJsonQueued("clip", "edits.json", { v: 2 });
    const c = saveJsonQueued("clip", "edits.json", { v: 3 });
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(getQueuedSaveState("clip").queued).toBe(true);

    first.resolve();
    await Promise.all([a, b, c]);
    await flushQueuedSaves("clip");

    // v2 was overtaken by v3 and never written; the file holds the newest work.
    expect(writes.map(([, value]) => value)).toEqual([{ v: 1 }, { v: 3 }]);
    expect(getQueuedSaveState("clip").saving).toBe(false);
    expect(getQueuedSaveState("clip").error).toBeNull();
  });

  it("never lets a slow first write land after a faster second one", async () => {
    const landed: number[] = [];
    let slow = true;
    setQueuedWriter(async (_path, value) => {
      if (slow) {
        slow = false;
        await new Promise((r) => setTimeout(r, 20));
      }
      landed.push((value as { v: number }).v);
    });
    const first = saveJsonQueued("k", "f.json", { v: 1 });
    const second = saveJsonQueued("k", "f.json", { v: 2 });
    await Promise.all([first, second]);
    expect(landed).toEqual([1, 2]);
  });

  it("keeps keys apart: two files write at the same time", async () => {
    const gate = deferred();
    const order: string[] = [];
    setQueuedWriter(async (path) => {
      order.push(`start ${path}`);
      if (path === "slow.json") await gate.promise;
      order.push(`end ${path}`);
    });
    const slow = saveJsonQueued("a", "slow.json", 1);
    const quick = saveJsonQueued("b", "quick.json", 2);
    await quick;
    expect(order).toContain("end quick.json");
    expect(order).not.toContain("end slow.json");
    gate.resolve();
    await slow;
  });

  it("tells the screen a write failed without claiming anything was saved", async () => {
    setQueuedWriter(async () => {
      throw new Error("the connection went away");
    });
    let seen = 0;
    const stop = subscribeQueuedSave("t", () => {
      seen++;
    });
    await expect(saveJsonQueued("t", "t.json", { a: 1 })).rejects.toThrow("the connection went away");
    expect(getQueuedSaveState("t").error).toBe("the connection went away");
    expect(getQueuedSaveState("t").savedAt).toBeNull();
    expect(seen).toBeGreaterThan(0);
    stop();
  });
});

describe("reframeLayoutOf", () => {
  it("sends every upright shape to the vertical output and 16:9 to the wide one", () => {
    expect(reframeLayoutOf("9:16")).toBe("vertical");
    expect(reframeLayoutOf("4:5")).toBe("vertical");
    expect(reframeLayoutOf("1:1")).toBe("vertical");
    expect(reframeLayoutOf("16:9")).toBe("wide");
  });
});
