// @effect-diagnostics globalDate:off globalJsonInEffect:off - probe windows are wall-clock; the probe types its own JSON.
/**
 * mobile:metrics' interactions. Each measured step opens a probe window, makes one real tap,
 * swipe or typed string through agent-device, waits until the app is quiet, and reads the window.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { Device, ProbeState } from "../mobile-behavior/device.ts";
import type { Session } from "../mobile-behavior/session.ts";
import { stepOf, type PerfWindow, type Step } from "./report.ts";

export class CaseFailure extends Schema.TaggedError<CaseFailure>()("CaseFailure", {
  message: Schema.String,
}) {}

/** Threads the seed creates, by the title their Home row shows. */
export interface Fixtures {
  readonly short: { readonly id: ThreadId; readonly title: string };
  readonly long: { readonly id: ThreadId; readonly title: string };
  readonly working: { readonly id: ThreadId; readonly title: string };
}

export interface CaseContext {
  readonly session: Session;
  readonly device: Device;
  readonly fixtures: Fixtures;
  readonly round: number;
  /** Threads opened so far in this app launch, for first visit versus revisit. */
  readonly visited: Set<string>;
}

/** How long the app must stay without input, commits or new content to end a step. */
const QUIET_MS = 1_000;
/** A working thread commits on every streamed chunk, so its steps end this long after content. */
const AFTER_CONTENT_MS = 1_200;
const STEP_TIMEOUT_MS = 15_000;

const Peek = Schema.fromJsonString(
  Schema.Struct({
    now: Schema.Number,
    last: Schema.Number,
    inputs: Schema.Number,
    content: Schema.Array(Schema.String),
  }),
);
const decodePeek = Schema.decodeUnknownEffect(Peek);

/** Runs `act` inside a probe window and returns what it measured. */
const measure = Effect.fn("metrics.measure")(function* (
  ctx: CaseContext,
  step: Pick<Step, "case" | "step" | "visit">,
  act: Effect.Effect<unknown, { readonly message: string }>,
  options: { readonly thread?: string } = {},
) {
  const { device } = ctx;
  yield* device.evaluate("__t3Behavior.perfStart()");
  const acted = yield* Effect.result(act);
  const deadline = (yield* Clock.currentTimeMillis) + STEP_TIMEOUT_MS;
  let contentSince: number | null = null;
  while (acted._tag === "Success" && (yield* Clock.currentTimeMillis) < deadline) {
    const peek = yield* device.evaluate("__t3Behavior.perfPeek()").pipe(
      Effect.flatMap((value) => decodePeek(value)),
      Effect.orElseSucceed(() => null),
    );
    if (peek) {
      const shown = options.thread
        ? peek.content.some((thread) => thread.endsWith(options.thread!))
        : true;
      if (shown && options.thread) contentSince ??= peek.now;
      const quiet = peek.inputs > 0 && peek.now - peek.last > QUIET_MS;
      if (shown && (quiet || (contentSince !== null && peek.now - contentSince > AFTER_CONTENT_MS)))
        break;
    }
    yield* Effect.sleep("250 millis");
  }
  const window = JSON.parse(
    String(yield* device.evaluate("__t3Behavior.perfStop()")),
  ) as PerfWindow;
  if (acted._tag === "Failure")
    return yield* new CaseFailure({
      message: `${step.case} ${step.step}: ${acted.failure.message}`,
    });
  return stepOf(window, { ...step, round: ctx.round }, options.thread ?? null);
});

const isThread = (state: ProbeState, threadId: string) =>
  state.route?.name === "Thread" && state.route.params.threadId === threadId;

/** Back to Home, unmeasured: phones stack threads over the list. */
const toHome = Effect.fn("metrics.toHome")(function* (ctx: CaseContext) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = yield* ctx.device.state;
    if (state.route?.name === "Home") return;
    yield* ctx.device.back;
    yield* Effect.sleep("800 millis");
  }
  yield* ctx.device.waitFor("Home", (state) => state.route?.name === "Home", 5_000);
});

const rowSelector = (title: string) => `label="${title}"`;

/** Waits for a Home row, opening the Working shelf if the row folded into it. */
const waitForRow = Effect.fn("metrics.waitForRow")(function* (ctx: CaseContext, title: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const nodes = yield* ctx.device.nodes;
    if (nodes.some((node) => node.label === title)) return;
    const shelf = nodes.find((node) => /^\d+ working threads?$/.test(node.label ?? ""));
    if (shelf?.label && attempt % 4 === 1) yield* ctx.device.press(`label="${shelf.label}"`);
    yield* Effect.sleep("500 millis");
  }
  return yield* new CaseFailure({ message: `Row "${title}" never appeared on Home.` });
});

/** Opens a thread by tapping its Home row, measured from the tap to its rows on screen. */
const switchTo = (name: keyof Fixtures) =>
  Effect.fn(`metrics.switch.${name}`)(function* (ctx: CaseContext) {
    const thread = ctx.fixtures[name];
    yield* toHome(ctx);
    yield* waitForRow(ctx, thread.title);
    const visit = ctx.visited.has(thread.id) ? "revisit" : "first";
    ctx.visited.add(thread.id);
    const step = yield* measure(
      ctx,
      { case: `switch-${name}`, step: "open", visit },
      ctx.device.press(rowSelector(thread.title)),
      { thread: thread.id },
    );
    yield* ctx.device.waitFor("the tapped thread", (state) => isThread(state, thread.id), 10_000);
    return [step];
  });

/** Opens a thread, unmeasured, and waits for its feed. */
const openThread = Effect.fn("metrics.openThread")(function* (
  ctx: CaseContext,
  thread: Fixtures[keyof Fixtures],
) {
  yield* toHome(ctx);
  yield* waitForRow(ctx, thread.title);
  yield* ctx.device.press(rowSelector(thread.title));
  ctx.visited.add(thread.id);
  yield* ctx.device.waitFor(
    "the thread's feed",
    (state) => isThread(state, thread.id) && state.feed?.ready === true,
    20_000,
  );
  yield* Effect.sleep("1 second");
});

const TYPED = "check the helpers";

type CaseRun = (ctx: CaseContext) => Effect.Effect<ReadonlyArray<Step>, { readonly message: string }>;

export const CASES = {
  "switch-short": switchTo("short"),
  "switch-long": switchTo("long"),
  "switch-working": switchTo("working"),

  /** The tab bar: pull requests, usage, then back to chats. */
  tabs: Effect.fn("metrics.tabs")(function* (ctx: CaseContext) {
    yield* toHome(ctx);
    const steps: Step[] = [];
    for (const [step, label] of [
      ["pulls", "PRs"],
      ["usage", "Usage"],
      ["chats", "Chats"],
    ] as const) {
      steps.push(
        yield* measure(ctx, { case: "tabs", step, visit: "step" }, ctx.device.press(`label="${label}"`)),
      );
    }
    return steps;
  }),

  /** The pull request list, then the branch's pull request with its body, files and comments. */
  "pull-request": Effect.fn("metrics.pullRequest")(function* (ctx: CaseContext) {
    yield* toHome(ctx);
    const steps: Step[] = [];
    steps.push(
      yield* measure(ctx, { case: "pull-request", step: "list", visit: "step" }, ctx.device.press('label="PRs"')),
    );
    const row = (yield* ctx.device.nodes).find((node) => node.label?.includes("Bench change 1"));
    if (!row?.label)
      return yield* new CaseFailure({ message: "No pull request row for Bench change 1." });
    steps.push(
      yield* measure(
        ctx,
        { case: "pull-request", step: "details", visit: "step" },
        ctx.device.press(`label="${row.label}"`),
      ),
    );
    yield* ctx.device.back;
    yield* Effect.sleep("800 millis");
    yield* ctx.device.press('label="Chats"');
    return steps;
  }),

  /** Keys typed into a short thread's composer, each to its next JS frame. */
  type: Effect.fn("metrics.type")(function* (ctx: CaseContext) {
    yield* openThread(ctx, ctx.fixtures.short);
    const editor = (yield* ctx.device.nodes).find(
      (node) => node.kind === "text-view" && node.editable === true,
    );
    if (!editor?.rect) return yield* new CaseFailure({ message: "No composer on screen." });
    const { x, y } = ctx.device.center(editor);
    yield* ctx.device.pressAt(x, y);
    yield* ctx.device.waitFor("the keyboard", (state) => state.composer.keyboard, 10_000);
    yield* Effect.sleep("1 second");
    const step = yield* measure(
      ctx,
      { case: "type", step: "keys", visit: "step" },
      ctx.device.type(TYPED),
    );
    // Clear the draft so the next round types into the same empty composer.
    yield* ctx.device.run(["fill", String(x), String(y), ""]).pipe(Effect.ignore);
    yield* ctx.device.run(["keyboard", "dismiss"]).pipe(Effect.ignore);
    return [step];
  }),

  /** Drags the long timeline up through history: frames while the list lays out older rows. */
  "scroll-long": Effect.fn("metrics.scrollLong")(function* (ctx: CaseContext) {
    yield* openThread(ctx, ctx.fixtures.long);
    const root = (yield* ctx.device.nodes)[0]?.rect ?? { x: 0, y: 0, width: 400, height: 870 };
    const x = Math.round(root.width / 2);
    const drag = Effect.gen(function* () {
      for (let swipe = 0; swipe < 4; swipe++)
        yield* ctx.device.swipe(x, Math.round(root.height * 0.3), Math.round(root.height * 0.8));
    });
    return [yield* measure(ctx, { case: "scroll-long", step: "drag-up", visit: "step" }, drag)];
  }),
} satisfies Record<string, CaseRun>;

export type CaseName = keyof typeof CASES;
export const CASE_NAMES = Object.keys(CASES) as ReadonlyArray<CaseName>;
