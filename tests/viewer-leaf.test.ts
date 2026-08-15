import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceLeaf } from "obsidian";
import { buildAtomicPasteChanges, ViewerLeafController, type RoutableViewerView } from "../src/viewer-leaf";

type FakeLeaf = {
  id: number;
  view: FakeView;
  deferred?: boolean;
  setViewState(state: { state?: { url?: string } }): Promise<void>;
  getViewState(): { state?: unknown };
};

class FakeView implements RoutableViewerView {
  url: string | null = null;
  origin: FakeLeaf | null = null;

  matchesNote(url: string): boolean {
    return this.url === url;
  }

  setReturnMarkdownLeaf(leaf: WorkspaceLeaf | null): void {
    this.origin = leaf as unknown as FakeLeaf | null;
  }
}

function fixture() {
  const leaves: FakeLeaf[] = [];
  const calls: string[] = [];
  const pending = new Map<number, () => void>();
  let nextId = 1;
  let active: FakeLeaf | null = null;
  const autoRelease = new Set<number>();
  const workspace = {
    getLeavesOfType() { return leaves as never[]; },
    getMostRecentLeaf() { return active as never; },
    getLeaf(kind: string, direction?: string) {
      calls.push(`get:${kind}${direction ? `:${direction}` : ""}`);
      const leaf: FakeLeaf = {
        id: nextId++,
        view: new FakeView(),
        getViewState() { return { state: leaf.view.url ? { url: leaf.view.url } : {} }; },
        async setViewState(state) {
          calls.push(`set:${leaf.id}:${state.state?.url ?? "blank"}`);
          await new Promise<void>((resolve) => {
            if (autoRelease.has(leaf.id)) resolve();
            else pending.set(leaf.id, resolve);
          });
          leaf.view.url = state.state?.url ?? null;
          leaves.push(leaf);
        }
      };
      return leaf as never;
    },
    async revealLeaf(leaf: FakeLeaf) { calls.push(`reveal:${leaf.id}`); },
    setActiveLeaf(leaf: FakeLeaf, options: { focus?: boolean }) {
      calls.push(`${options.focus === false ? "prefer" : "focus"}:${leaf.id}`);
      active = leaf;
    }
  };
  const controller = new ViewerLeafController(
    workspace as never,
    "viewer",
    (leaf) => {
      const fake = leaf as unknown as FakeLeaf;
      return fake.deferred ? null : fake.view as unknown as RoutableViewerView;
    }
  );
  return {
    workspace,
    controller,
    leaves,
    calls,
    release(id: number) { pending.get(id)?.(); pending.delete(id); },
    autoRelease(id: number) { autoRelease.add(id); },
    setActive(leaf: FakeLeaf | null) { active = leaf; },
    addLeaf(url: string | null) {
      const leaf = {
        id: nextId++,
        view: new FakeView(),
        async setViewState() {},
        getViewState() { return { state: leaf.view.url ? { url: leaf.view.url } : {} }; }
      } as FakeLeaf;
      leaf.view.url = url;
      leaves.push(leaf);
      return leaf;
    }
  };
}

test("every explicit blank open creates an unlimited tab after the first vertical split", async () => {
  const { controller, calls, release, autoRelease } = fixture();
  const first = controller.openBlank();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["get:split:vertical", "set:1:blank"]);
  release(1);
  await first;

  autoRelease(2);
  await controller.openBlank();
  autoRelease(3);
  await controller.openBlank();
  assert.deepEqual(calls, [
    "get:split:vertical", "set:1:blank", "reveal:1", "focus:1",
    "prefer:1", "get:tab", "set:2:blank", "reveal:2", "focus:2",
    "prefer:2", "get:tab", "set:3:blank", "reveal:3", "focus:3"
  ]);
});

test("concurrent blank opens stay distinct while serializing first-split placement", async () => {
  const { controller, calls, release } = fixture();
  const first = controller.openBlank();
  const second = controller.openBlank();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["get:split:vertical", "prefer:1", "get:tab", "set:1:blank", "set:2:blank"]);
  release(1);
  release(2);
  assert.notEqual(await first, await second);
  assert.equal(calls.filter((call) => call === "get:split:vertical").length, 1);
  assert.equal(calls.filter((call) => call === "get:tab").length, 1);
});

test("same-note concurrent opens share one creation while distinct notes create concurrently", async () => {
  const { controller, calls, release } = fixture();
  const urlA = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const urlB = "https://notability.com/app/note/11111111-2222-3333-4444-555555555555";
  const firstA = controller.openForNote(urlA);
  const secondA = controller.openForNote(urlA);
  const firstB = controller.openForNote(urlB);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter((call) => call.startsWith("set:")).length, 2);
  assert.ok(calls.includes(`set:1:${urlA}`));
  assert.ok(calls.includes(`set:2:${urlB}`));
  release(1);
  release(2);
  assert.equal(await firstA, await secondA);
  assert.notEqual(await firstA, await firstB);
});

test("active then MRU same-note leaves win and different-note leaves are never retargeted", async () => {
  const { controller, calls, addLeaf, setActive } = fixture();
  const urlA = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const urlB = "https://notability.com/app/note/11111111-2222-3333-4444-555555555555";
  const firstA = addLeaf(urlA);
  const secondA = addLeaf(urlA);
  const different = addLeaf(urlB);

  controller.recordLeafActivity(secondA as never);
  setActive(different);
  assert.equal(await controller.openForNote(urlA), secondA as never);
  setActive(firstA);
  assert.equal(await controller.openForNote(urlA), firstA as never);
  assert.equal(different.view.url, urlB);
  assert.equal(calls.some((call) => call.startsWith(`set:${different.id}:`)), false);
});

test("a null routing placeholder never clears an existing viewer's Markdown origin", async () => {
  const { controller, addLeaf } = fixture();
  const url = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const viewer = addLeaf(url);
  const originA = { id: 901 } as FakeLeaf;
  const originB = { id: 902 } as FakeLeaf;
  viewer.view.origin = originA;

  assert.equal(await controller.openForNote(url, null), viewer as never);
  assert.equal(viewer.view.origin, originA);

  assert.equal(await controller.openForNote(url, originB as never), viewer as never);
  assert.equal(viewer.view.origin, originB);
});

test("closed leaves are pruned from MRU routing", async () => {
  const { controller, leaves, addLeaf, setActive } = fixture();
  const url = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const closed = addLeaf(url);
  const live = addLeaf(url);
  controller.recordLeafActivity(closed as never);
  leaves.splice(leaves.indexOf(closed), 1);
  setActive(null);
  assert.equal(await controller.openForNote(url), live as never);
});

test("deferred restored legacy and v2 leaves match by persisted state without materializing", async () => {
  const { controller, addLeaf, setActive } = fixture();
  const url = "https://notability.com/app/note/11111111-2222-4333-8444-555555555555";
  const legacy = addLeaf(null);
  legacy.deferred = true;
  legacy.getViewState = () => ({ state: { url } });
  legacy.view.matchesNote = () => false;
  setActive(null);
  assert.equal(await controller.openForNote(url), legacy as never);

  legacy.getViewState = () => ({ state: { v: 2, mode: "area", url: null } });
  const restored = addLeaf(null);
  restored.deferred = true;
  restored.getViewState = () => ({ state: { v: 2, mode: "text", url, page: 7 } });
  restored.view.matchesNote = () => false;
  assert.equal(await controller.openForNote(url), restored as never);
});

test("paste changes cover all selections atomically and fail closed", () => {
  const selections = [
    { anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 4 } },
    { anchor: { line: 2, ch: 7 }, head: { line: 2, ch: 2 } }
  ];
  const changes = buildAtomicPasteChanges(
    selections,
    ({ anchor, head }) => ({
      from: anchor.ch <= head.ch ? anchor : head,
      to: anchor.ch <= head.ch ? head : anchor
    }),
    (range) => `${range.from.line}:${range.from.ch}-${range.to.ch}`
  );
  assert.deepEqual(changes, [
    { from: { line: 0, ch: 1 }, to: { line: 0, ch: 4 }, text: "0:1-4" },
    { from: { line: 2, ch: 2 }, to: { line: 2, ch: 7 }, text: "2:2-7" }
  ]);
  assert.equal(buildAtomicPasteChanges(selections, ({ anchor, head }) => ({ from: anchor, to: head }), () => null), null);
});
