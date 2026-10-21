import { test } from "node:test";
import assert from "node:assert/strict";
import { ConditionError, evaluate, factsRead, holds, parseCondition, Playbook } from "../src/index.js";

const facts = { "a.n": 3, "a.word": "broad", "a.flag": true, "a.none": null };

test("literals, comparisons, in, and/or/not", () => {
  assert.equal(holds("a.n == 3", facts), true);
  assert.equal(holds("a.n >= 4", facts), false);
  assert.equal(holds('a.word in ["broad", "masked"]', facts), true);
  assert.equal(holds('a.word != "drill" and a.flag', facts), true);
  assert.equal(holds("not a.flag or a.n < 2", facts), false);
  assert.equal(holds("(a.n > 1 or a.n < 0) and not (a.flag == false)", facts), true);
  assert.equal(holds("a.n > -1", facts), true);
});

test("a fact nobody published reads as null, and ordering with null is false", () => {
  assert.equal(holds("b.x == null", facts), true);
  assert.equal(holds("b.x > 1", facts), false);
  assert.equal(holds("a.none < 1", facts), false);
});

test("the facts a condition reads are listed", () => {
  assert.deepEqual(factsRead(parseCondition('a.n > 1 and b.x in ["u", c.y]')).sort(), ["a.n", "b.x", "c.y"]);
});

test("bad conditions are refused with a reason, and nothing can be called or assigned", () => {
  for (const bad of ["a.n =", "a.n = 3", "foo", "a.b.c == 1", "f(1)", "a.n == 'x", "a.n == 1 )", "a.n in 3", "and", "a.n == 1 2"]) {
    assert.throws(() => parseCondition(bad), ConditionError, bad);
  }
});

const base = { name: "p", description: "d" };
const compute = (id: string, extra: object = {}) => ({ id, compute: "persistence", ...extra });

test("a playbook's rules are checked when it is read: syntax, targets, a closing else", () => {
  assert.ok(Playbook.safeParse({ ...base, steps: [compute("a", { next: [{ if: "a.persistent > 0", then: "b" }, { else: "b" }] }), compute("b")] }).success);
  const noElse = Playbook.safeParse({ ...base, steps: [compute("a", { next: [{ if: "a.persistent > 0", then: "b" }] }), compute("b")] });
  assert.ok(!noElse.success && /must be an/.test(noElse.error.message));
  const unknown = Playbook.safeParse({ ...base, steps: [compute("a", { next: [{ else: "zzz" }] })] });
  assert.ok(!unknown.success && /not a step/.test(unknown.error.message));
  const syntax = Playbook.safeParse({ ...base, steps: [compute("a", { when: "a.persistent >" })] });
  assert.ok(!syntax.success);
  const both = Playbook.safeParse({ ...base, steps: [compute("a", { next: [{ if: "a.x == 1", else: "a" }] })] });
  assert.ok(!both.success);
});

test("evaluate does not need facts for literals", () => {
  assert.equal(evaluate(parseCondition("1 < 2"), {}), true);
});
