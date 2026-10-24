export const concepts = {
  'Cauchy sequences': 'cauchy',
  'Completeness': 'complete',
  'Geometric series': 'geometric',
  'Metric spaces': 'metric',
};
export const familiarityLevels = ['Not set', 'New to me', 'A little familiar', 'Comfortable'];

export function cleanFamiliarity(value) {
  return Object.fromEntries(Object.keys(concepts).map(name => [name,
    familiarityLevels.includes(value?.[name]) ? value[name] : 'Not set',
  ]));
}

export function localIntent(question) {
  const text = question.trim();
  const plot = /^(?:please\s+)?(?:plot|graph)\s+(.+)$/i.exec(text);
  if (plot) return { type: 'plot', expression: plot[1].replace(/^(?:y|f\(x\))\s*=\s*/i, '') };
  const note = /^save note\s*:\s*(.+)$/is.exec(text);
  if (note) return { type: 'note', text: note[1] };
  if (/^(?:show (?:this|it)(?: larger)?|enlarge(?: this| it)?)[.!]?$/i.test(text)) return { type: 'enlarge' };
  const definition = /^(?:define|what is|what's)\s+(?:a |the )?(fixed point|contraction|cauchy sequence|completeness|metric space|geometric series)[?.!]?$/i.exec(text);
  if (definition) return { type: 'definition', concept: definition[1].toLowerCase() };
  return { type: 'question' };
}

export const definitions = {
  'fixed point': 'A fixed point of a map T is a point x with T(x) = x. Applying the rule leaves that point unchanged. For example, T(x) = x/2 has the fixed point 0.',
  contraction: 'A contraction brings every pair of points closer by a uniform factor q < 1: d(Tx, Ty) ≤ q d(x, y). The same q must work for all pairs. That uniform bound is stronger than merely making each particular distance smaller.',
  'cauchy sequence': 'A sequence is Cauchy when its late terms become arbitrarily close to one another. Formally, for every ε > 0 there is N such that d(xₘ, xₙ) < ε whenever m,n ≥ N. This definition does not assume you already know the limit.',
  completeness: 'A metric space is complete if every Cauchy sequence in it converges to a point that is still in the space. The real numbers are complete. The rational numbers are not: rational approximations to √2 can converge to a point missing from the rationals.',
  'metric space': 'A metric space is a set of points together with a distance d. Distances are nonnegative, vanish exactly for equal points, are symmetric, and satisfy the triangle inequality: d(x,z) ≤ d(x,y) + d(y,z).',
  'geometric series': 'A geometric series repeatedly multiplies a term by the same number q. For |q| < 1, the tail qⁿ + qⁿ⁺¹ + … equals qⁿ/(1 − q). The entire remaining sum goes to zero as n grows.',
};

export function sampleExplanation(context, familiarity, simpler = false) {
  const id = context?.id || 'complete';
  if (id === 'fixed' || id === 'idea') return 'A fixed point is a place where the rule has nothing left to change.\n\nTake T(x) = x/2. Start at 8: you get 4, 2, 1, ½, … . You get closer and closer to 0, and T(0) = 0.\n\nThe theorem tells us which conditions guarantee that this settling happens, regardless of where we start.';
  if (id === 'theorem') return 'The theorem makes two promises work together.\n\nContraction makes the remaining motion small. Completeness means the destination exists inside the space you started with. Together they guarantee a fixed point.\n\nIt is unique because two different fixed points would have to get closer when T is applied — but neither point moves.';
  if (id === 'bound' || id === 'shrinking') {
    if (simpler || familiarity['Geometric series'] !== 'Comfortable') return 'Think of each step as at most half the previous one. A step of 1 is followed by ½, ¼, ⅛, … . Even infinitely many of those steps have a finite total.\n\nThe proof uses the same idea with q instead of ½. After n steps, the whole remaining journey is at most qⁿ/(1 − q) times the first step. That bound tends to zero.\n\nThis matters because small individual steps alone do not guarantee convergence; the total remaining distance must become small.';
    return 'Iterating the contraction gives d(xₖ₊₁, xₖ) ≤ qᵏ d(x₁, x₀).\n\nThe triangle inequality bounds d(xₘ, xₙ) by the sum of those steps from n to m − 1. Extend that finite sum to the geometric tail qⁿ/(1 − q).\n\nThe bound is uniform in m > n and tends to zero, which is precisely the Cauchy condition.';
  }
  if (simpler || familiarity['Cauchy sequences'] !== 'Comfortable') return 'The late points crowd together so tightly that any two of them are as close as you want. That is what “Cauchy” means.\n\nBut crowding together does not by itself mean the destination belongs to our space. Completeness says there are no missing destinations for Cauchy sequences.\n\nSo the iterates have a limit x*. The contraction inequality makes T continuous, letting us pass to the limit in xₙ₊₁ = T(xₙ) and get x* = T(x*).';
  return 'You already have the Cauchy condition from the geometric-tail estimate. Completeness is used at exactly the next step: it supplies a limit x* ∈ X.\n\nA contraction is Lipschitz, hence continuous. Passing to the limit in xₙ₊₁ = T(xₙ) therefore yields x* = T(x*).\n\nFor uniqueness, (1 − q)d(x*, y*) ≤ 0 and 1 − q > 0 force the distance to vanish.';
}

/** Keep attention separate from the passage captured when a question starts. */
export class TurnState {
  constructor(context) { this.latest = { ...context }; this.pinned = null; this.generation = 0; }
  point(context) { this.latest = { ...context }; return this.context; }
  changeDocument(context) { this.cancel(); this.pinned = null; this.latest = { ...context }; return this.context; }
  get context() { return { ...(this.pinned || this.latest) }; }
  pin() { this.pinned ||= { ...this.latest }; return this.context; }
  release() { this.pinned = null; return this.context; }
  start() { const context = this.pin(); return { generation: ++this.generation, context }; }
  isCurrent(turn) { return turn.generation === this.generation; }
  cancel() { this.generation += 1; }
}
