# llm-safety-gate

**Fail-closed content safety for LLM apps.**

The ugliest part of shipping a user-content feature on top of a vision/language model is that the
classifier deciding "is this safe to publish" is itself an unreliable LLM. It returns malformed
JSON, it changes its mind at temperature 0, it gets refused by its own upstream safety layer — and
every one of those failure modes has to fail **closed** without turning ordinary noise into a wall
of false blocks for real users.

This library is the state machine that survived that problem in production. It was rebuilt from a
live publish gate (a shipped consumer app); each design decision below is annotated with the
incident that caused it.

- **Zero runtime dependencies** — plain ESM, Node 18+.
- **Classifier-agnostic** — you inject `classify(items)`; the library owns the voting, retry, and
  degradation logic. Your policy prompt, your model, your transport.
- **Unit-tested** — every invariant carries a test; `classify` is injectable, so every failure
  path (noise, refusal, thrown errors, wrong-shape verdicts) is covered without a network.

```js
import { createSafetyGate, validateVerdict, classifyFailure, planPublish } from 'llm-safety-gate';

const gate = createSafetyGate({
  classify: async (items) => {
    const raw = await callYourModel(items);          // any vision/LLM classifier
    if (raw.blocked) return { ok: false, blocked: true };
    return validateVerdict(parse(raw), items.length); // enforces the verdict contract
  },
});

const verdict = await gate.checkPerItem(images);
if (!verdict.ok) {
  // 'refusal' -> the model declined to assess: treat as a real block.
  // 'noise'   -> parse/transport glitch: tell the user to retry, never accuse them.
  showMessage(classifyFailure(verdict.reason));
} else {
  const plan = planPublish(verdict.flags, { primaryIndex: 0, minItems: 3 });
  if (plan.ok) publish(plan.keptIdx); // flagged items dropped, the rest ships
}
```

## What it guarantees

1. **A lone flag is one vote, not a verdict.** Batch mode returns clean first calls immediately
   (one classifier call, ever); a flagged first call triggers confirmation voting (2-of-3 by
   default) with a short-circuit the moment quorum is reached.
2. **Block is signal; noise is not.** A classifier-level refusal fails closed instantly, with no
   retry — the model declining to look is information. Malformed output is retried, but only on
   the first vote.
3. **Failed revotes are fail-closed pressure.** A confirmation vote that errors counts toward
   flagging, never toward publishing.
4. **Per-item degradation instead of all-or-nothing.** `checkPerItem` votes every item
   independently (no short-circuit — each item gets the full vote count), and `planPublish` drops
   only the flagged items, promotes a clean substitute when the primary item is flagged, and
   enforces a floor of survivors.
5. **Two-way failure taxonomy for your UX.** `classifyFailure(reason)` separates `refusal` from
   `noise`, so your interface never shows an accusatory message for a parse glitch.

## Incident-driven design

**The isolated judge.** Text embedded in a submitted image could steer the generation prompt
(classic indirect injection). The gate exists as a fully isolated classifier call sharing no
persona or system prompt with the creative call: hijacking the entertainer must not also hijack
the judge.

**The 23-minute outage.** The classifier's reasoning tokens shared a budget with its answer; at a
1,024-token cap the model spent 982 thinking and had 27 left for the verdict JSON. Truncated
verdict, structural failure, and the gate — correctly — blocked every publish in production until
the budget was fixed. Fail-closed means your outage is loud instead of your safety being silent.
Size verdict budgets for reasoning *plus* answer.

**The false positive that wasn't.** Majority voting was added after the same clean batch passed,
then flagged twenty minutes later at temperature 0 — apparent nondeterministic noise. The
follow-up investigation found the "noise" flag was a *true positive* on one fixture image. Both
lessons shipped: 2-of-3 voting absorbs real nondeterminism, and a confirmed gate verdict deserves
respect, not an override.

**One bad item used to kill the whole publish.** The original whole-batch gate 403'd an entire
submission over a single flagged item. Per-item voting plus `planPublish` replaced it: drop the
flagged item, promote a substitute primary, ship the rest — safety without collective punishment.

**The 3-of-13 day.** Under the original design, a real flag got 2-of-3 benefit of the doubt, but a
first-call parse failure had zero retries and failed closed instantly — so on one production day,
3 of 13 publishes of fully clean content were rejected over malformed JSON. The fix is the
asymmetry this library encodes: retry noise (first vote only), never retry a refusal, and keep the
two failure classes visibly distinct all the way up to the UI copy.

**Policy is yours; red-team it.** The production policy behind this gate was narrowed once — the
original classification bar over-flagged youthful-looking adults — and the replacement was
adversarially reviewed the same day it shipped. That is why this library ships the *machine* and
not the *policy*: the policy prompt lives with your `classify()`, where you can tune and red-team
it without touching the failure semantics.

## What this is not

- **Not a content policy.** You supply the classifier and the policy prompt; the library supplies
  the failure-mode discipline around them.
- **Not a biometric system.** No face-recognition or age-estimation model is included or called.
  The pattern was built for a pipeline that sends images to a general vision-language model for
  classification — your items still go wherever your `classify()` sends them, so state your own
  data-handling story accordingly.

## Install

```bash
npm i llm-safety-gate
```

Node 18+.

## API

- `createSafetyGate({ classify, votes = 3, quorum = 2, firstCallRetries = 2 })` →
  `{ checkBatch(items), checkPerItem(items) }`
- `validateVerdict(parsed, itemCount)` → `{ok:true, perItem} | {ok:false, reason}` — enforces the
  verdict contract (`{ items: [{ index, flagged }] }`, exactly one row per index).
- `classifyFailure(reason)` → `'refusal' | 'noise'`
- `planPublish(flags, { primaryIndex = 0, minItems = 3 })` →
  `{ok, keptIdx, dropped, primaryFlagged, promotedFrom}`

## License

MIT

## Related

- [yapoleons-court](https://github.com/abouchard11/yapoleons-court) — shipped game that needs this fail-closed posture
- [graphiti-neo4j-ops](https://github.com/abouchard11/graphiti-neo4j-ops) — fail-closed ops for the Graphiti store
