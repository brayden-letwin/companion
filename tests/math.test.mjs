import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression as value, sampleExpression as sample } from '../src/core/math.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≈ ${expected}`);

test('arithmetic, right associative powers, unary precedence, and scientific notation', () => {
  assert.equal(value('2 + 3 * 4'), 14);
  assert.equal(value('(2 + 3) * 4'), 20);
  assert.equal(value('2^3^2'), 512);
  assert.equal(value('-x^2', 3), -9);
  assert.equal(value('(-x)^2', 3), 9);
  assert.equal(value('2^-2'), 0.25);
  assert.equal(value('2^--2'), 4);
  close(value('1e-3 + 2E+2 + .5'), 200.501);
});

test('supported functions and constants use radians and natural logarithms', () => {
  close(value('sin(pi/2) + cos(0)'), 2);
  close(value('tan(pi/4)'), 1);
  close(value('sqrt(abs(-9))'), 3);
  close(value('ln(e) + log(e) + exp(0)'), 3);
  assert.equal(value('X + PI', 2), 2 + Math.PI);
});

test('arbitrary JavaScript, properties, unsupported names and ambiguous input are rejected', () => {
  for (const expression of [
    'globalThis', 'process.exit()', 'x.constructor', 'Math.sin(x)', 'alert(1)',
    'x[0]', '(()=>1)()', '1;2', '`x`', '1/* comment */+2', 'sin(x,x)',
    '2x', '2(x+1)', 'sin x', '1e', '1..2', '(x+1', 'x+1)', '', ' ',
  ]) assert.throws(() => value(expression), SyntaxError, expression);
  assert.throws(() => value('x'.repeat(513)), /characters/);
  assert.throws(() => value('1+'.repeat(129) + '1'), /too many parts/);
  assert.throws(() => value('('.repeat(60) + 'x' + ')'.repeat(60)), /nested/);
  assert.throws(() => value('1e999'), /too large/);
});

test('undefined or non-real evaluations have readable errors', () => {
  assert.throws(() => value('1/x', 0), /Division by zero/);
  assert.throws(() => value('sqrt(x)', -1), /nonnegative/);
  assert.throws(() => value('ln(x)', 0), /positive/);
  assert.throws(() => value('tan(pi/2)'), /undefined/);
  assert.throws(() => value('(-1)^0.5'), /finite real/);
  assert.throws(() => value('exp(1000)'), /finite real/);
  assert.throws(() => value('0^-1'), /positive exponent/);
  assert.throws(() => value('0^0'), /positive exponent/);
  for (const x of [NaN, Infinity, '2', null]) assert.throws(() => value('x', x), /finite number/);
});

test('sampling validates inputs and returns padded domains and constant curves', () => {
  const curve = sample('x^2', -2, 2, 41);
  assert.equal(curve.points.length, 41);
  assert.equal(curve.segments.length, 1);
  assert.deepEqual(curve.points[0], { x: -2, y: 4 });
  assert.deepEqual(curve.points.at(-1), { x: 2, y: 4 });
  assert.ok(curve.minY < 0 && curve.maxY > 4);
  assert.equal(curve.minX, -2);
  assert.equal(curve.maxX, 2);
  const constant = sample('5', -1, 1);
  assert.ok(constant.minY < 5 && constant.maxY > 5);
  for (const args of [[0, 0], [2, 1], [NaN, 1], [-Infinity, 1], ['0', 1], [-1e308, 1e308]]) {
    assert.throws(() => sample('x', ...args), RangeError);
  }
  for (const count of [0, 1, 2.5, 2002, Infinity, '401']) assert.throws(() => sample('x', -1, 1, count), /sample points/);
  assert.throws(() => sample('sqrt(x)', -2, -1), /no finite real values/);
});

test('domain holes become null without losing the valid portion of a graph', () => {
  const curve = sample('sqrt(x)', -1, 1, 5);
  assert.deepEqual(curve.points.map(point => point.y), [null, null, 0, Math.sqrt(0.5), 1]);
  assert.equal(curve.segments.length, 1);
  assert.equal(curve.segments[0][0].x, 0);
});

test('reciprocal poles on and between sample positions never get joined', () => {
  for (const count of [100, 101]) {
    const curve = sample('1/x', -1, 1, count);
    assert.equal(curve.segments.length, 2);
    assert.ok(curve.segments.every(segment => segment.every(point => point.x < 0) || segment.every(point => point.x > 0)));
    assert.ok(curve.minY > -50 && curve.maxY < 50);
  }
  const offset = sample('1/(x-0.123)^2', -1, 1, 100);
  assert.equal(offset.segments.length, 2);
  assert.ok(offset.segments.every(segment => segment.every(point => point.x < 0.123) || segment.every(point => point.x > 0.123)));
  assert.ok(offset.maxY < 1000);
});

test('tangent poles and fractional-power domain gaps split paths', () => {
  const tangent = sample('tan(x)', -Math.PI, Math.PI, 200);
  assert.equal(tangent.segments.length, 3);
  for (const segment of tangent.segments) {
    for (const pole of [-Math.PI / 2, Math.PI / 2]) {
      assert.ok(!(segment[0].x < pole && segment.at(-1).x > pole));
    }
  }
  const root = sample('x^0.5', -1, 1, 11);
  assert.equal(root.segments.length, 1);
  assert.equal(root.segments[0][0].x, 0);
  assert.ok(root.points.slice(0, 5).every(point => point.y === null));
});

test('ordinary smooth curves are not split or trimmed like singular curves', () => {
  for (const expression of ['sin(x)', '1/(x^2+1)', 'exp(x)', 'x^4', '-x^2']) {
    const curve = sample(expression, -2, 2);
    assert.equal(curve.segments.length, 1, expression);
    assert.ok(curve.points.every(point => point.y >= curve.minY && point.y <= curve.maxY), expression);
  }
});
