/**
 * A tiny boolean search language for the console's free-text filter boxes.
 *
 * People type a filter the way they'd say it, and no two people say it the same way: 与 / and /
 * AND / &, 或 / or / OR / |, 非 / not / NOT / ~, and parentheses to group. This compiles such a
 * string into a predicate over a haystack (the row's searchable text), so 设备 / 消息 搜索 can
 * accept e.g. `agv-a01 and 康城 Airy 路网` — read as `agv-a01 AND 康城 AND Airy AND 路网`, because
 * adjacent terms are an implicit AND (the common search-box rule).
 *
 * Deliberately forgiving: a malformed query (dangling operator, stray paren) never throws — it
 * falls back to matching the whole raw string as one literal term, which is what a non-power-user
 * typing punctuation by accident expects anyway.
 *
 * Precedence is the usual NOT > AND > OR. Matching is case-insensitive substring (CJK has no case;
 * Latin is lowercased on both sides). Operator *words* (and/or/not/与/或/非) only act as operators
 * when they stand alone as whitespace-delimited tokens, so a scene named 「参与区」 keeps its 与;
 * the symbol operators (& | ~) are punctuation and split wherever they appear.
 */

type Token =
  | { type: "term"; value: string }
  | { type: "and" }
  | { type: "or" }
  | { type: "not" }
  | { type: "lparen" }
  | { type: "rparen" };

type Node =
  | { term: string }
  | { op: "not"; operand: Node }
  | { op: "and"; left: Node; right: Node }
  | { op: "or"; left: Node; right: Node };

const WORD_OPERATORS: Record<string, "and" | "or" | "not"> = {
  and: "and",
  与: "and",
  or: "or",
  或: "or",
  not: "not",
  非: "not",
};

/** `&`→and, `|`→or, `~`→not, and both ASCII and fullwidth parens. Everything else accretes a word. */
const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let word = "";
  const flush = (): void => {
    if (!word) return;
    const op = WORD_OPERATORS[word.toLowerCase()];
    tokens.push(
      op ? { type: op } : { type: "term", value: word.toLowerCase() },
    );
    word = "";
  };
  for (const char of input) {
    if (/\s/.test(char)) {
      flush();
    } else if (char === "(" || char === "（") {
      flush();
      tokens.push({ type: "lparen" });
    } else if (char === ")" || char === "）") {
      flush();
      tokens.push({ type: "rparen" });
    } else if (char === "&") {
      flush();
      tokens.push({ type: "and" });
    } else if (char === "|") {
      flush();
      tokens.push({ type: "or" });
    } else if (char === "~") {
      flush();
      tokens.push({ type: "not" });
    } else {
      word += char;
    }
  }
  flush();
  return tokens;
};

/** Recursive-descent parser. Throws on anything malformed; the caller turns that into a fallback. */
const parse = (tokens: Token[]): Node => {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  const parseAtom = (): Node => {
    const token = next();
    if (!token) throw new Error("unexpected end");
    if (token.type === "lparen") {
      const inner = parseOr();
      if (peek()?.type === "rparen") next(); // tolerate a missing close paren
      return inner;
    }
    if (token.type === "term") return { term: token.value };
    throw new Error("unexpected operator");
  };

  const parseNot = (): Node => {
    if (peek()?.type === "not") {
      next();
      return { op: "not", operand: parseNot() };
    }
    return parseAtom();
  };

  const parseAnd = (): Node => {
    let node = parseNot();
    for (;;) {
      const token = peek();
      if (!token || token.type === "or" || token.type === "rparen") break;
      if (token.type === "and") next(); // explicit AND; otherwise implicit between operands
      node = { op: "and", left: node, right: parseNot() };
    }
    return node;
  };

  function parseOr(): Node {
    let node = parseAnd();
    while (peek()?.type === "or") {
      next();
      node = { op: "or", left: node, right: parseAnd() };
    }
    return node;
  }

  const root = parseOr();
  if (pos !== tokens.length) throw new Error("trailing tokens");
  return root;
};

const evaluate = (node: Node, haystack: string): boolean => {
  if ("term" in node) return node.term === "" || haystack.includes(node.term);
  if (node.op === "not") return !evaluate(node.operand, haystack);
  if (node.op === "and")
    return evaluate(node.left, haystack) && evaluate(node.right, haystack);
  return evaluate(node.left, haystack) || evaluate(node.right, haystack);
};

export type SearchPredicate = (haystack: string) => boolean;

/**
 * Compile a query string into a predicate. An empty query matches everything; a malformed one
 * matches the raw string as a single literal term. The predicate lower-cases the haystack itself,
 * so call sites pass the row's concatenated searchable text as-is.
 */
export const compileSearch = (query: string): SearchPredicate => {
  const trimmed = query.trim();
  if (!trimmed) return () => true;
  let node: Node;
  try {
    const tokens = tokenize(trimmed);
    node = tokens.length ? parse(tokens) : { term: trimmed.toLowerCase() };
  } catch {
    node = { term: trimmed.toLowerCase() };
  }
  return (haystack: string) => evaluate(node, haystack.toLowerCase());
};
