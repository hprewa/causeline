/**
 * The small language a playbook uses to decide what to do next. It reads facts that earlier steps published and does nothing else:
 * literals, `step.fact` references, comparisons (== != < <= > >=), `in [..]`, and / or / not. Nothing in it can invoke a function or assign a value, so
 * a condition can be checked when the playbook loads and cannot run code.
 */
export type Value = string | number | boolean | null;

export type Expr =
  | { kind: "lit"; value: Value }
  | { kind: "fact"; name: string }
  | { kind: "not"; arg: Expr }
  | { kind: "and" | "or"; left: Expr; right: Expr }
  | { kind: "cmp"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; left: Expr; right: Expr }
  | { kind: "in"; left: Expr; items: Expr[] };

export class ConditionError extends Error {
  constructor(message: string, readonly source: string) {
    super(`${message} in condition "${source}"`);
  }
}

type Token = { t: "num" | "str" | "id" | "op" | "end"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ConditionError("unterminated string", src);
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (["==", "!=", "<=", ">="].includes(two)) {
        out.push({ t: "op", v: two });
        i += 2;
      } else if ("<>()[],".includes(c)) {
        out.push({ t: "op", v: c });
        i++;
      } else throw new ConditionError(`unexpected "${c}"`, src);
    }
  }
  out.push({ t: "end", v: "" });
  return out;
}

const KEYWORDS = new Set(["and", "or", "not", "in", "true", "false", "null"]);

/** Parse a condition once, at load. */
export function parseCondition(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().t === "op" && peek().v === v;
  const isKw = (v: string) => peek().t === "id" && peek().v === v;
  const fail = (m: string): never => {
    throw new ConditionError(m, src);
  };

  function orExpr(): Expr {
    let left = andExpr();
    while (isKw("or")) {
      p++;
      left = { kind: "or", left, right: andExpr() };
    }
    return left;
  }
  function andExpr(): Expr {
    let left = notExpr();
    while (isKw("and")) {
      p++;
      left = { kind: "and", left, right: notExpr() };
    }
    return left;
  }
  function notExpr(): Expr {
    if (isKw("not")) {
      p++;
      return { kind: "not", arg: notExpr() };
    }
    return cmpExpr();
  }
  function cmpExpr(): Expr {
    const left = primary();
    const t = peek();
    if (t.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      p++;
      return { kind: "cmp", op: t.v as Extract<Expr, { kind: "cmp" }>["op"], left, right: primary() };
    }
    if (isKw("in")) {
      p++;
      if (!isOp("[")) fail('"in" needs a list like [a, b]');
      p++;
      const items: Expr[] = [];
      while (!isOp("]")) {
        items.push(primary());
        if (isOp(",")) p++;
        else if (!isOp("]")) fail('expected "," or "]"');
      }
      p++;
      return { kind: "in", left, items };
    }
    return left;
  }
  function primary(): Expr {
    const t = peek();
    if (t.t === "num") return p++, { kind: "lit", value: Number(t.v) };
    if (t.t === "str") return p++, { kind: "lit", value: t.v };
    if (t.t === "id") {
      p++;
      if (t.v === "true" || t.v === "false") return { kind: "lit", value: t.v === "true" };
      if (t.v === "null") return { kind: "lit", value: null };
      if (KEYWORDS.has(t.v)) fail(`unexpected "${t.v}"`);
      if (t.v.split(".").length !== 2) fail(`"${t.v}" is not a fact; facts are written step.name`);
      return { kind: "fact", name: t.v };
    }
    if (isOp("(")) {
      p++;
      const e = orExpr();
      if (!isOp(")")) fail('expected ")"');
      p++;
      return e;
    }
    return fail(t.t === "end" ? "the condition ends too soon" : `unexpected "${t.v}"`);
  }

  const e = orExpr();
  if (peek().t !== "end") fail(`unexpected "${peek().v}"`);
  return e;
}

/** Every fact a condition reads. */
export function factsRead(e: Expr): string[] {
  switch (e.kind) {
    case "lit":
      return [];
    case "fact":
      return [e.name];
    case "not":
      return factsRead(e.arg);
    case "and":
    case "or":
    case "cmp":
      return [...factsRead(e.left), ...factsRead(e.right)];
    case "in":
      return [...factsRead(e.left), ...e.items.flatMap(factsRead)];
  }
}

/** Evaluate against the facts published so far. A fact nobody published reads as null; ordering comparisons with null are false. */
export function evaluate(e: Expr, facts: Record<string, Value>): Value {
  switch (e.kind) {
    case "lit":
      return e.value;
    case "fact":
      return facts[e.name] ?? null;
    case "not":
      return !evaluate(e.arg, facts);
    case "and":
      return !!evaluate(e.left, facts) && !!evaluate(e.right, facts);
    case "or":
      return !!evaluate(e.left, facts) || !!evaluate(e.right, facts);
    case "in": {
      const v = evaluate(e.left, facts);
      return e.items.some((i) => evaluate(i, facts) === v);
    }
    case "cmp": {
      const a = evaluate(e.left, facts);
      const b = evaluate(e.right, facts);
      if (e.op === "==") return a === b;
      if (e.op === "!=") return a !== b;
      if (typeof a !== typeof b || a === null || b === null) return false;
      if (e.op === "<") return a < b;
      if (e.op === "<=") return a <= b;
      if (e.op === ">") return a > b;
      return a >= b;
    }
  }
}

/** Convenience: parse and evaluate to a yes/no. */
export const holds = (src: string, facts: Record<string, Value>): boolean => !!evaluate(parseCondition(src), facts);
