import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import {
  GUEST_CAPTURE_ESCAPE_MESSAGE,
  buildGuestCaptureEscapeSealScript,
  buildGuestCaptureEscapeScript,
  buildSelectionScrollLockScript,
  selectionModeLocksScrolling
} from "../src/selection-scroll-lock";

test("only capture modes request the guest scrolling lock", () => {
  assert.equal(selectionModeLocksScrolling("browse"), false);
  assert.equal(selectionModeLocksScrolling("area"), true);
  assert.equal(selectionModeLocksScrolling("text"), true);
});

test("guest lock is idempotent, generation-ordered, and preserves plugin-owned synthetic movement", () => {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const messages: string[] = [];
  const fakeWindow: Record<PropertyKey, unknown> & {
    addEventListener(type: string, listener: (event: any) => void): void;
  } = {
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    }
  };
  class FakeElement {
    closest(): null { return null; }
  }
  const context = vm.createContext({
    window: fakeWindow,
    Symbol,
    Set,
    Element: FakeElement,
    console: { info: (message: string) => messages.push(message) }
  });
  const run = (locked: boolean, generation: number) => vm.runInContext(
    buildSelectionScrollLockScript(locked, generation),
    context
  ) as { generation: number; locked: boolean };

  assert.deepEqual({ ...run(true, 7) }, { generation: 7, locked: true });
  assert.deepEqual({ ...run(false, 6) }, { generation: 7, locked: true });
  assert.deepEqual({ ...run(true, 7) }, { generation: 7, locked: true });
  assert.equal(listeners.get("wheel")?.length, 1);
  assert.equal(listeners.get("touchmove")?.length, 1);
  assert.equal(listeners.get("keydown")?.length, 1);

  const counts = { prevented: 0, stopped: 0 };
  const wheel = (trusted: boolean) => ({
    isTrusted: trusted,
    preventDefault: () => { counts.prevented += 1; },
    stopImmediatePropagation: () => { counts.stopped += 1; }
  });
  listeners.get("wheel")![0]!(wheel(true));
  assert.deepEqual(counts, { prevented: 1, stopped: 1 });
  listeners.get("wheel")![0]!(wheel(false));
  assert.deepEqual(counts, { prevented: 1, stopped: 1 }, "plugin-owned synthetic alignment stays available");

  const keyEvent = {
    ...wheel(true),
    key: "PageDown",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: new FakeElement()
  };
  listeners.get("keydown")![0]!(keyEvent);
  assert.deepEqual(counts, { prevented: 2, stopped: 2 });

  const armed = vm.runInContext(
    buildGuestCaptureEscapeScript("capture:nr-fixture", 3),
    context
  ) as { available: boolean; generation: number; id: string | null };
  assert.deepEqual({ ...armed }, { available: true, generation: 3, id: "capture:nr-fixture" });
  listeners.get("keydown")![0]!({
    ...wheel(true),
    key: "Escape",
    isComposing: false,
    target: new FakeElement()
  });
  assert.deepEqual(counts, { prevented: 2, stopped: 2 }, "capture Escape is reported without trapping guest input");
  assert.deepEqual(messages, [`${GUEST_CAPTURE_ESCAPE_MESSAGE}capture:nr-fixture`]);

  const sealed = vm.runInContext(
    buildGuestCaptureEscapeSealScript("capture:nr-fixture", 3, 4),
    context
  ) as {
    available: boolean;
    generation: number;
    id: string | null;
    matched: boolean;
    requested: boolean;
  };
  assert.deepEqual({ ...sealed }, {
    available: true,
    generation: 4,
    id: null,
    matched: true,
    requested: true
  });

  const staleDisarm = vm.runInContext(buildGuestCaptureEscapeScript(null, 2), context) as {
    available: boolean;
    generation: number;
    id: string | null;
  };
  assert.deepEqual({ ...staleDisarm }, { available: true, generation: 4, id: null });
  const disarmed = vm.runInContext(buildGuestCaptureEscapeScript(null, 5), context) as {
    available: boolean;
    generation: number;
    id: string | null;
  };
  assert.deepEqual({ ...disarmed }, { available: true, generation: 5, id: null });

  assert.deepEqual({ ...run(false, 8) }, { generation: 8, locked: false });
  listeners.get("touchmove")![0]!(wheel(true));
  assert.deepEqual(counts, { prevented: 2, stopped: 2 });

  assert.throws(() => buildSelectionScrollLockScript(true, -1), /generation is invalid/);
  assert.throws(() => buildSelectionScrollLockScript(true, 1.5), /generation is invalid/);
  assert.throws(() => buildGuestCaptureEscapeScript("bad id", 1), /identifier is invalid/);
  assert.throws(() => buildGuestCaptureEscapeScript(null, -1), /generation is invalid/);
  assert.throws(() => buildGuestCaptureEscapeSealScript("bad id", 1, 2), /identifier is invalid/);
  assert.throws(() => buildGuestCaptureEscapeSealScript("capture:nr-fixture", 2, 2), /must advance/);
});
