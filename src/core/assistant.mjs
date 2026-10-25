import { PAPER, PASSAGES } from './discussion.mjs';
import { definitions } from './tutor.mjs';
import { parseExpression } from './math.mjs';

export const SAMPLE_PAPER = Object.freeze({ id: 'fixed-points-v1', title: PAPER, version: 'original-v1' });
const MAX_REQUEST = 4000;
const MAX_SOURCE = 12000;
const DEFAULT_RANGE = Object.freeze({ min: -5, max: 5 });

function text(value, max, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || (!allowEmpty && !value.trim())) throw new TypeError(`${label} must contain ${allowEmpty ? '0' : '1'}–${max} characters.`);
  return value.trim();
}

/** A source is a detached, flat snapshot. Moving the pointer cannot alter it. */
export function pinSource(passage, options = {}) {
  if (!passage || typeof passage !== 'object' || Array.isArray(passage)) throw new TypeError('Choose a passage first.');
  const paper = options.paper ?? passage.paper ?? SAMPLE_PAPER;
  const title = text(typeof paper === 'string' ? paper : paper?.title, 300, 'Paper title');
  const page = passage.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new RangeError('Choose a valid source page.');
  const passageId = text(passage.passageId ?? passage.id ?? `page-${page}`, 160, 'Passage ID');
  const documentId = text(options.documentId ?? passage.documentId ?? (typeof paper === 'object' ? paper.id : undefined)
    ?? `local:${title.slice(0, 154)}`, 160, 'Document ID');
  const kind = options.kind ?? passage.kind ?? 'sample';
  if (!['sample', 'pdf'].includes(kind)) throw new TypeError('Unknown source kind.');
  return Object.freeze({
    id: passageId, passageId,
    label: text(passage.label ?? `Page ${page}`, 160, 'Passage label'),
    number: text(String(passage.number ?? page), 30, 'Passage number'),
    text: text(passage.text, MAX_SOURCE, 'Passage'),
    paper: title, documentId, page, kind,
  });
}

const CONCEPTS = Object.freeze([
  { id: 'metric-space', label: 'Metric space', concept: 'metric space', passageId: 'theorem' },
  { id: 'contraction', label: 'Contraction', concept: 'contraction', passageId: 'idea' },
  { id: 'fixed-point', label: 'Fixed point', concept: 'fixed point', passageId: 'idea' },
  { id: 'geometric-series', label: 'Geometric series', concept: 'geometric series', passageId: 'bound' },
  { id: 'cauchy-sequence', label: 'Cauchy sequence', concept: 'cauchy sequence', passageId: 'bound' },
  { id: 'completeness', label: 'Completeness', concept: 'completeness', passageId: 'complete' },
]);
// These are authored reading connections for this original example, not embeddings.
const MENTIONS = Object.freeze({
  idea: ['contraction', 'fixed-point'],
  theorem: ['metric-space', 'contraction', 'fixed-point', 'completeness'],
  bound: ['geometric-series', 'cauchy-sequence'],
  complete: ['completeness', 'cauchy-sequence', 'contraction', 'fixed-point'],
});
const PREREQUISITES = Object.freeze([
  ['contraction', 'metric-space'], ['completeness', 'cauchy-sequence'],
  ['cauchy-sequence', 'metric-space'],
]);

/** Imported passages intentionally have no inferred concept links. */
export function buildReadingGraph(passages = PASSAGES, options = {}) {
  if (!Array.isArray(passages) || passages.length > 80) throw new TypeError('Choose at most 80 passages.');
  const prepared = (passages === PASSAGES || options.preparedSample === true)
    && passages.length === PASSAGES.length
    && passages.every((passage, index) => ['id', 'label', 'text'].every(key => passage?.[key] === PASSAGES[index][key]));
  const paper = options.paper ?? (prepared ? SAMPLE_PAPER : undefined);
  const nodes = passages.map(passage => {
    const source = pinSource(passage, { ...options, paper: paper ?? passage?.paper ?? { id: 'local-paper', title: 'Local paper' },
      kind: prepared ? 'sample' : (options.kind ?? passage?.kind ?? 'pdf') });
    return { id: `passage:${source.passageId}`, label: source.label, type: 'passage', text: source.text, passageId: source.passageId, source };
  });
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new TypeError('Passage IDs must be distinct.');
  const edges = [];
  if (prepared) {
    for (const concept of CONCEPTS) {
      const source = nodes.find(node => node.passageId === concept.passageId).source;
      nodes.push({ id: `concept:${concept.id}`, label: concept.label, type: 'concept', concept: concept.concept,
        text: definitions[concept.concept], passageId: source.passageId, source });
    }
    for (const [passageId, concepts] of Object.entries(MENTIONS)) for (const conceptId of concepts) {
      edges.push({ id: `mentions:${passageId}:${conceptId}`, source: `passage:${passageId}`, target: `concept:${conceptId}`,
        type: 'mentions', label: 'Prepared reading connection' });
    }
    for (const [conceptId, prerequisiteId] of PREREQUISITES) {
      edges.push({ id: `depends:${conceptId}:${prerequisiteId}`, source: `concept:${conceptId}`, target: `concept:${prerequisiteId}`,
        type: 'dependsOn', label: 'Prepared prerequisite' });
    }
  }
  return { label: prepared ? 'Prepared sample reading map' : 'Passage map', prepared, nodes, edges };
}

const aliases = new Map(CONCEPTS.flatMap(concept => {
  const terms = [concept.concept, concept.label.toLowerCase()];
  if (concept.id === 'cauchy-sequence') terms.push('cauchy sequences');
  if (concept.id === 'metric-space') terms.push('metric spaces');
  if (concept.id === 'fixed-point') terms.push('fixed points');
  return terms.map(term => [term, concept.concept]);
}));

/** Only direct user commands become local actions. All other text stays a question. */
export function parseCommand(request) {
  const original = text(request, MAX_REQUEST, 'Request');
  const question = original.replace(/^(?:hey\s+)?(?:companion|jarvis)(?:\s*[,!:]\s*|\s+)/i, '').trim() || original;
  const command = question.replace(/^please\s+/i, '');
  const ask = () => ({ type: 'ask', question });
  const note = /^(?:save|take)\s+(?:a\s+)?note\s*:\s*([\s\S]*)$/i.exec(command)
    ?? /^save\s+(?:a\s+)?note\s+that\s+([\s\S]+)$/i.exec(command);
  if (note) return { type: 'saveNote', text: text(note[1], MAX_REQUEST, 'Note') };
  if (/^(?:save\s+(?:this|(?:this|the)\s+(?:answer|explanation|passage))(?:\s+as\s+(?:a\s+)?note)?|save\s+(?:a\s+)?note)[.!]?$/i.test(command)) {
    return { type: 'saveNote', text: null };
  }
  // Do not execute one clause of a quoted transcript or a compound instruction.
  if (/[\r\n;]|&&|\|\||\b(?:and then|then)\b/i.test(command)) return ask();
  const plain = command.replace(/[.!?]$/, '').trim();
  if (/^(?:open|show)\s+(?:the\s+)?shared\s+room$/i.test(plain)) return { type: 'openSharedRoom' };
  const search = /^(?:search\s+(?:(?:my|the)\s+)?notes(?:\s+for)?|find\s+in\s+(?:my\s+)?notes(?:\s+for)?)(?:\s+(.+))?$/i.exec(plain);
  if (search) return { type: 'searchNotes', query: text(search[1] ?? '', 400, 'Search', true) };
  const definition = /^(?:define|(?:find|show)\s+(?:the\s+)?definition\s+(?:of|for))\s+(?:a\s+|an\s+|the\s+)?(.+)$/i.exec(plain);
  if (definition) {
    const concept = aliases.get(definition[1].toLowerCase());
    return concept ? { type: 'findDefinition', concept } : ask();
  }
  const selection = /^(?:select|go\s+to|show)\s+(?:the\s+)?passage\s+(.+)$/i.exec(plain);
  if (selection && /^[\p{L}\p{N} _'’.,-]{1,160}$/u.test(selection[1])) return { type: 'selectPassage', target: selection[1].trim() };
  const plot = /^(?:plot|graph)\s+(.+)$/i.exec(plain);
  if (plot) {
    let expression = plot[1];
    let { min, max } = DEFAULT_RANGE;
    let defaultRange = true;
    const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
    const range = new RegExp(`^(.*?)\\s+(?:(?:for\\s+x\\s+)?from\\s+(${number})\\s+to\\s+(${number})|(?:on|over)\\s*\\[\\s*(${number})\\s*,\\s*(${number})\\s*\\])$`, 'i').exec(expression);
    if (range) {
      expression = range[1]; min = Number(range[2] ?? range[4]); max = Number(range[3] ?? range[5]); defaultRange = false;
    }
    expression = expression.replace(/^(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, '').trim()
      .replace(/\b(x)\s+squared\b/gi, '$1^2').replace(/\b(x)\s+cubed\b/gi, '$1^3')
      .replace(/²/g, '^2').replace(/³/g, '^3').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(max - min) || min >= max) {
      throw new RangeError('Choose finite x bounds with the minimum smaller than the maximum.');
    }
    parseExpression(expression);
    return { type: 'plot', expression, min, max, defaultRange };
  }
  return ask();
}

/** Search only saved notes; returned objects cannot alter stored notes. */
export function searchNotes(notes, query = '') {
  if (!Array.isArray(notes) || notes.length > 500) throw new TypeError('Keep at most 500 saved notes.');
  const terms = text(query, 400, 'Search', true).toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return notes.filter(note => {
    if (!note || typeof note.text !== 'string' || !note.text.trim() || note.text.length > MAX_SOURCE) return false;
    const haystack = [note.text, note.source?.paper, note.source?.label].filter(value => typeof value === 'string').join(' ').toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  }).slice(-30).reverse().map(note => structuredClone(note));
}

/** History follows the exact pinned source, never a newly hovered passage. */
export function prepareHistory(messages, source) {
  if (!Array.isArray(messages) || messages.length > 500) throw new TypeError('Keep at most 500 conversation messages.');
  if (!source) return [];
  const pinned = pinSource(source);
  const sameSource = candidate => candidate && ['documentId', 'id', 'page', 'paper', 'text'].every(key => candidate[key] === pinned[key]);
  return messages.filter(message => ['user', 'assistant'].includes(message?.role)
    && typeof message.text === 'string' && message.text.trim() && message.text.length <= 6000
    && sameSource(message.source)).slice(-12).map(message => ({ role: message.role, text: message.text }));
}
