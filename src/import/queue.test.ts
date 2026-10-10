import { createOrderedQueue, type QueueState } from "./queue";

/** Controllable async work: each `run` call parks until the test settles it. */
function harness(concurrency = 2) {
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  const committed: string[] = [];
  const failed: string[] = [];
  const states = new Map<string, QueueState[]>();
  let running = 0;
  let maxRunning = 0;

  const queue = createOrderedQueue<string, string>({
    concurrency,
    run: (name) =>
      new Promise<string>((resolve, reject) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        pending.set(name, {
          resolve: (v) => {
            running -= 1;
            resolve(v);
          },
          reject: (e) => {
            running -= 1;
            reject(e);
          },
        });
      }),
    commit: (item, outcome) => {
      (outcome.ok ? committed : failed).push(item.payload);
    },
    onState: (id, s) => states.set(id, [...(states.get(id) ?? []), s]),
  });
  const items = (...names: string[]) => names.map((n) => ({ id: n, payload: n }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { queue, pending, committed, failed, states, items, tick, max: () => maxRunning };
}

describe("ordered import queue", () => {
  it("never reads more than two files at once", async () => {
    const h = harness(2);
    h.queue.add(h.items("a", "b", "c", "d", "e"));
    await h.tick();
    expect([...h.pending.keys()]).toEqual(["a", "b"]);
    expect(h.queue.active).toBe(2);

    h.pending.get("a")!.resolve("a");
    await h.tick();
    expect([...h.pending.keys()]).toEqual(["a", "b", "c"]); // c started when a finished
    expect(h.queue.active).toBe(2);

    for (const n of ["b", "c", "d", "e"]) {
      await h.tick();
      h.pending.get(n)?.resolve(n);
    }
    await h.tick();
    expect(h.max()).toBe(2);
    expect(h.committed).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("commits in drop order even when later files finish first", async () => {
    const h = harness(2);
    h.queue.add(h.items("slow", "fast"));
    await h.tick();

    h.pending.get("fast")!.resolve("fast");
    await h.tick();
    expect(h.committed).toEqual([]); // "fast" is ready but must wait for "slow"
    expect(h.states.get("fast")).toContain("ready");

    h.pending.get("slow")!.resolve("slow");
    await h.tick();
    expect(h.committed).toEqual(["slow", "fast"]);
  });

  it("a failing file does not stop the others, and still frees its slot", async () => {
    const h = harness(1);
    h.queue.add(h.items("bad", "good"));
    await h.tick();
    h.pending.get("bad")!.reject(new Error("not a media file"));
    await h.tick();
    expect(h.failed).toEqual(["bad"]);
    h.pending.get("good")!.resolve("good");
    await h.tick();
    expect(h.committed).toEqual(["good"]);
  });

  it("calls onDone once per batch, after its last file", async () => {
    const h = harness(2);
    const done: string[] = [];
    h.queue.add(h.items("a1", "a2"), () => done.push("A"));
    h.queue.add(h.items("b1"), () => done.push("B"));
    await h.tick();
    h.pending.get("a1")!.resolve("a1");
    await h.tick();
    expect(done).toEqual([]);
    h.pending.get("a2")!.resolve("a2");
    await h.tick();
    expect(done).toEqual(["A"]);
    h.pending.get("b1")!.resolve("b1");
    await h.tick();
    expect(done).toEqual(["A", "B"]);
  });

  it("an empty batch completes immediately", () => {
    const h = harness();
    const onDone = vi.fn();
    h.queue.add([], onDone);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
