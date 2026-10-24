/** A small, dependency-free real-number expression engine. Never executes source code. */
const LIMITS = Object.freeze({ length: 512, tokens: 256, depth: 48, samples: 2001 });
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'sqrt', 'abs', 'log', 'ln', 'exp']);
const TAU = 2 * Math.PI;

function syntax(message, position) {
  return new SyntaxError(`${message}${position === undefined ? '' : ` at character ${position + 1}`}.`);
}

function tokenize(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw syntax('Enter an expression, such as sin(x)');
  if (expression.length > LIMITS.length) throw syntax(`Keep expressions under ${LIMITS.length + 1} characters`);
  const tokens = [];
  let position = 0;
  while (position < expression.length) {
    if (/\s/.test(expression[position])) { position++; continue; }
    const rest = expression.slice(position);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    let token;
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw syntax('That number is too large', position);
      token = { type: 'number', value, position };
      position += number[0].length;
    } else {
      const identifier = /^[a-zA-Z]+/.exec(rest);
      if (identifier) {
        const value = identifier[0].toLowerCase();
        if (!FUNCTIONS.has(value) && !['x', 'pi', 'e'].includes(value)) {
          throw syntax(`Unknown name “${identifier[0]}”; use x, pi, e, or a supported function`, position);
        }
        token = { type: 'name', value, position };
        position += identifier[0].length;
      } else {
        const value = expression[position];
        if (!'+-*/^()'.includes(value)) throw syntax(`Unsupported character “${value}”`, position);
        token = { type: value, position };
        position++;
      }
    }
    tokens.push(token);
    if (tokens.length > LIMITS.tokens) throw syntax('That expression has too many parts; simplify it first');
  }
  tokens.push({ type: 'end', position: expression.length });
  return tokens;
}

/** Parse once when evaluating the same expression repeatedly. The AST is data only. */
export function parseExpression(expression) {
  const tokens = tokenize(expression);
  let cursor = 0;
  let depth = 0;
  const peek = () => tokens[cursor];
  const take = (type) => peek().type === type ? tokens[cursor++] : null;
  function nested(read) {
    if (++depth > LIMITS.depth) throw syntax(`Expressions may be nested at most ${LIMITS.depth} levels`);
    try { return read(); } finally { depth--; }
  }
  function addition() {
    let node = multiplication();
    while (peek().type === '+' || peek().type === '-') {
      const op = tokens[cursor++].type;
      node = { type: 'binary', op, left: node, right: multiplication() };
    }
    return node;
  }
  function multiplication() {
    let node = unary();
    while (peek().type === '*' || peek().type === '/') {
      const op = tokens[cursor++].type;
      node = { type: 'binary', op, left: node, right: unary() };
    }
    return node;
  }
  // Powers bind more tightly than a leading sign, but accept a signed exponent.
  function unary() {
    return nested(() => {
      const sign = take('+') || take('-');
      return sign ? { type: 'unary', op: sign.type, child: unary() } : power();
    });
  }
  function power() {
    const left = primary();
    return take('^') ? { type: 'binary', op: '^', left, right: unary() } : left;
  }
  function primary() {
    const token = peek();
    if (take('number')) return { type: 'number', value: token.value };
    if (take('(')) {
      const node = addition();
      if (!take(')')) throw syntax('Missing closing parenthesis', peek().position);
      return node;
    }
    if (take('name')) {
      if (token.value === 'x') return { type: 'variable' };
      if (token.value === 'pi' || token.value === 'e') {
        return { type: 'number', value: token.value === 'pi' ? Math.PI : Math.E };
      }
      if (!take('(')) throw syntax(`Write ${token.value}(...) with parentheses`, peek().position);
      const child = addition();
      if (!take(')')) throw syntax('Missing closing parenthesis', peek().position);
      return { type: 'function', name: token.value, child };
    }
    throw syntax('Expected a number, x, function, or opening parenthesis', token.position);
  }
  const ast = addition();
  if (peek().type !== 'end') throw syntax('Unexpected input; use * for multiplication', peek().position);
  return ast;
}

function finite(value) {
  if (!Number.isFinite(value)) throw new RangeError('The expression has no finite real value here.');
  return value;
}

function evaluate(ast, x) {
  if (ast.type === 'number') return ast.value;
  if (ast.type === 'variable') return x;
  if (ast.type === 'unary') {
    const value = evaluate(ast.child, x);
    return ast.op === '-' ? -value : value;
  }
  if (ast.type === 'function') {
    const value = evaluate(ast.child, x);
    switch (ast.name) {
      case 'sin': return Math.sin(value);
      case 'cos': return Math.cos(value);
      case 'tan':
        if (Math.abs(Math.cos(value)) < 1e-12) throw new RangeError('tan is undefined at this angle.');
        return finite(Math.tan(value));
      case 'sqrt':
        if (value < 0) throw new RangeError('sqrt needs a nonnegative value for a real result.');
        return Math.sqrt(value);
      case 'abs': return Math.abs(value);
      case 'log':
      case 'ln':
        if (value <= 0) throw new RangeError('log and ln need a positive value.');
        return Math.log(value);
      case 'exp': return finite(Math.exp(value));
    }
  }
  const left = evaluate(ast.left, x);
  const right = evaluate(ast.right, x);
  switch (ast.op) {
    case '+': return finite(left + right);
    case '-': return finite(left - right);
    case '*': return finite(left * right);
    case '/':
      if (right === 0) throw new RangeError('Division by zero is undefined.');
      return finite(left / right);
    case '^':
      if (left === 0 && right <= 0) throw new RangeError('Zero needs a positive exponent.');
      return finite(left ** right);
  }
}

/** log and ln both mean the natural logarithm. Angles are in radians. */
export function evaluateExpression(expression, x = 0) {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new RangeError('x must be a finite number.');
  return finite(evaluate(parseExpression(expression), x));
}

// Conservative interval arithmetic keeps paths from bridging poles between samples.
// Returning null means continuity could not be established across that interval.
function bounded(low, high) {
  return Number.isFinite(low) && Number.isFinite(high) ? [Math.min(low, high), Math.max(low, high)] : null;
}
function product(a, b) {
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return bounded(Math.min(...values), Math.max(...values));
}
function trigRange(a, cosine = false) {
  if (a[1] - a[0] >= TAU) return [-1, 1];
  const shift = cosine ? 0 : Math.PI / 2;
  const fn = cosine ? Math.cos : Math.sin;
  const values = [fn(a[0]), fn(a[1])];
  const first = Math.ceil((a[0] - shift) / Math.PI);
  const last = Math.floor((a[1] - shift) / Math.PI);
  // Argument reduction loses reliability at enormous angles; avoid false guarantees.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return [-1, 1];
  for (let k = first; k <= last; k++) values.push(k % 2 === 0 ? 1 : -1);
  return [Math.min(...values), Math.max(...values)];
}
function interval(ast, low, high) {
  if (ast.type === 'number') return [ast.value, ast.value];
  if (ast.type === 'variable') return [low, high];
  if (ast.type === 'unary') {
    const a = interval(ast.child, low, high);
    return a && (ast.op === '-' ? [-a[1], -a[0]] : a);
  }
  if (ast.type === 'function') {
    const a = interval(ast.child, low, high);
    if (!a) return null;
    switch (ast.name) {
      case 'sin': return trigRange(a);
      case 'cos': return trigRange(a, true);
      case 'tan': {
        const cos = trigRange(a, true);
        if (cos[0] <= 0 && cos[1] >= 0) return null;
        return bounded(Math.tan(a[0]), Math.tan(a[1]));
      }
      case 'sqrt': return a[0] < 0 ? null : bounded(Math.sqrt(a[0]), Math.sqrt(a[1]));
      case 'log':
      case 'ln': return a[0] <= 0 ? null : bounded(Math.log(a[0]), Math.log(a[1]));
      case 'abs': return [a[0] <= 0 && a[1] >= 0 ? 0 : Math.min(Math.abs(a[0]), Math.abs(a[1])), Math.max(Math.abs(a[0]), Math.abs(a[1]))];
      case 'exp': return bounded(Math.exp(a[0]), Math.exp(a[1]));
    }
  }
  const a = interval(ast.left, low, high);
  const b = interval(ast.right, low, high);
  if (!a || !b) return null;
  switch (ast.op) {
    case '+': return bounded(a[0] + b[0], a[1] + b[1]);
    case '-': return bounded(a[0] - b[1], a[1] - b[0]);
    case '*': return product(a, b);
    case '/': return b[0] <= 0 && b[1] >= 0 ? null : product(a, [1 / b[1], 1 / b[0]]);
    case '^': {
      if (b[0] === b[1] && Number.isInteger(b[0])) {
        const exponent = b[0];
        if (a[0] <= 0 && a[1] >= 0 && exponent <= 0) return null;
        const ends = [a[0] ** exponent, a[1] ** exponent];
        if (exponent > 0 && exponent % 2 === 0 && a[0] <= 0 && a[1] >= 0) ends.push(0);
        return bounded(Math.min(...ends), Math.max(...ends));
      }
      if (a[0] < 0 || (a[0] === 0 && b[0] <= 0)) return null;
      const values = [a[0] ** b[0], a[0] ** b[1], a[1] ** b[0], a[1] ** b[1]];
      return bounded(Math.min(...values), Math.max(...values));
    }
  }
  return null;
}

/** Sample a real curve. Undefined values are null; each segment can be drawn separately. */
export function sampleExpression(expression, min, max, count = 401) {
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw new RangeError('Choose finite x bounds with the minimum smaller than the maximum.');
  }
  if (!Number.isFinite(max - min)) throw new RangeError('The x range is too large; choose closer bounds.');
  if (!Number.isInteger(count) || count < 2 || count > LIMITS.samples) {
    throw new RangeError(`Choose between 2 and ${LIMITS.samples} sample points.`);
  }
  const ast = parseExpression(expression);
  const points = [];
  const segments = [];
  let segment = [];
  let hasPole = false;
  for (let i = 0; i < count; i++) {
    const x = i === count - 1 ? max : min + (max - min) * (i / (count - 1));
    let y = null;
    try { y = finite(evaluate(ast, x)); } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    const point = { x, y };
    points.push(point);
    const previous = points[points.length - 2];
    const unsafe = previous && previous.y !== null && y !== null && !interval(ast, previous.x, x);
    if (unsafe) hasPole = true;
    if (y === null || unsafe) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (y !== null) segment.push(point);
  }
  if (segment.length) segments.push(segment);
  const values = points.filter(point => point.y !== null).map(point => point.y).sort((a, b) => a - b);
  if (!values.length) throw new RangeError('This expression has no finite real values in that x range.');
  // An invalid point between two valid ones can be a pole exactly on the sample grid.
  hasPole ||= points.some((point, i) => point.y === null && i > 0 && i < count - 1 && points[i - 1].y !== null && points[i + 1].y !== null);
  let minY = values[0];
  let maxY = values[values.length - 1];
  if (hasPole && values.length >= 10) {
    const q10 = values[Math.floor((values.length - 1) * 0.1)];
    const q90 = values[Math.ceil((values.length - 1) * 0.9)];
    const spread = q90 - q10;
    if (Number.isFinite(spread) && spread > 0) {
      minY = Math.max(minY, q10 - 2 * spread);
      maxY = Math.min(maxY, q90 + 2 * spread);
    }
  }
  const span = maxY - minY;
  if (!Number.isFinite(span)) throw new RangeError('The y values are too large to graph; try a smaller x range.');
  const padding = span === 0 ? Math.max(Math.abs(minY) * 0.1, 1) : Math.max(span * 0.08, Number.EPSILON);
  const paddedMin = minY - padding;
  const paddedMax = maxY + padding;
  if (!Number.isFinite(paddedMin) || !Number.isFinite(paddedMax) || paddedMin === paddedMax) {
    throw new RangeError('The y values are too large to graph; try a smaller x range.');
  }
  return { points, segments, minX: min, maxX: max, minY: paddedMin, maxY: paddedMax, expression: expression.trim() };
}
