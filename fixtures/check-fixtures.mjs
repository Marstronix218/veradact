#!/usr/bin/env node
// Dependency-free consistency check for the Veradact fixtures.
//   node fixtures/check-fixtures.mjs
// Implements the normalization contract (see fixtures/README.md) and asserts that
// every quote used by the seed ledger and the eval sets matches its source exactly once.
// Exits non-zero on any failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const KINDS = ['problem', 'constraint', 'assumption', 'decision', 'requirement'];
const STATUSES = [
  'confirmed',
  'pending',
  'disputed',
  'withdrawn',
  'superseded',
  'revised_after_confirmation',
  'needs_review',
];
const MACHINE_STATES = ['OH', 'TX', 'GA', 'MI'];
const SEED_SOURCES = ['01-kickoff.vtt', '02-security-review.md', '03-scope-call.srt'];
const EVAL_SOURCES = [
  'e1-retail-kickoff.vtt',
  'e2-insurer-notes.md',
  'e3-hospital-scope.srt',
  'e4-bank-email.txt',
];
const CANDIDATE_FLAWS = ['HALLUCINATED_QUOTE', 'WRONG_OFFSETS', 'FALSE_POSITIVE', 'KIND_MISMATCH'];
// Totals the eval set must contain across all four recorded files.
const FLAW_TOTALS = {
  WRONG_OFFSETS: 2,
  HALLUCINATED_QUOTE: 2,
  FALSE_POSITIVE: 2,
  MISSED: 3,
  KIND_MISMATCH: 1,
};

// ---------------------------------------------------------------- normalization

function splitBlocks(raw) {
  const blocks = [];
  let cur = [];
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

// One entry per cue: the cue text lines joined with a single space. Header blocks, cue ids,
// SRT numbers and timing lines are dropped (everything before and including the timing line).
function cueTexts(raw) {
  const out = [];
  for (const block of splitBlocks(raw)) {
    const ti = block.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    out.push(
      block
        .slice(ti + 1)
        .map((l) => l.trim())
        .join(' '),
    );
  }
  return out;
}

function voiceToLabel(text) {
  const m = text.match(/^<v(?:\.[^\s>]+)*\s+([^>]+)>([\s\S]*)$/);
  if (!m) return text;
  return `${m[1].trim()}: ${m[2].replace(/<\/v>\s*$/, '').trim()}`;
}

export function normalize(file, raw) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vtt') return cueTexts(raw).map(voiceToLabel).join('\n');
  if (ext === '.srt') return cueTexts(raw).join('\n');
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

// Cues for .vtt/.srt, non-empty lines for .md/.txt.
function unitCount(file, raw) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vtt' || ext === '.srt') return cueTexts(raw).length;
  return normalize(file, raw)
    .split('\n')
    .filter((l) => l.trim() !== '').length;
}

// ---------------------------------------------------------------- helpers

const failures = [];
const fail = (msg) => failures.push(msg);

const readText = (file) => fs.readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(readText(file));

function occurrences(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}

function loadSource(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    fail(`${name}: file missing`);
    return null;
  }
  const raw = readText(file);
  return { name, raw, text: normalize(name, raw) };
}

// Returns a list of problems for a quote (empty list = fine).
function quoteProblems(src, quote, speaker) {
  const problems = [];
  if (typeof quote !== 'string') return ['quote is not a string'];
  if (quote.length < 20 || quote.length > 250) problems.push(`length ${quote.length} not in 20-250`);
  if (/[^\x20-\x7E]/.test(quote)) problems.push('contains non-ASCII or control characters');
  const n = occurrences(src.text, quote);
  if (n !== 1) problems.push(`occurs ${n}x in normalized text (need exactly 1)`);
  if (n >= 1 && speaker) {
    const i = src.text.indexOf(quote);
    const lineStart = src.text.lastIndexOf('\n', i - 1) + 1;
    const prefix = src.text.slice(lineStart, i);
    const ext = path.extname(src.name).toLowerCase();
    if (ext === '.vtt' || ext === '.srt') {
      if (!prefix.startsWith(`${speaker}: `)) problems.push(`line is not spoken by "${speaker}"`);
    } else if (ext === '.txt') {
      // Email export: the speaker is the sender of the enclosing message (nearest From: header above).
      const head = src.text.slice(0, i);
      const fromAt = head.lastIndexOf('From: ');
      const fromLine = fromAt < 0 ? '' : head.slice(fromAt, head.indexOf('\n', fromAt));
      if (!fromLine.startsWith(`From: ${speaker} <`)) problems.push(`enclosing message is not from "${speaker}"`);
    } else if (!prefix.includes(`${speaker}:`)) {
      problems.push(`no "${speaker}:" label before quote on its line`);
    }
  }
  return problems;
}

function report(where, problems) {
  for (const p of problems) fail(`${where}: ${p}`);
}

const countBy = (arr, fn) => arr.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] || 0) + 1), m), {});
const fmtCounts = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

// ---------------------------------------------------------------- seed

function checkSeed(summary) {
  const dir = path.join(HERE, 'seed');
  const sources = {};
  const ranges = { '01-kickoff.vtt': [60, 90], '03-scope-call.srt': [40, 60] };
  for (const name of SEED_SOURCES) {
    const src = loadSource(dir, name);
    if (!src) continue;
    sources[name] = src;
    const n = unitCount(name, src.raw);
    summary.push(`seed/${name}: ${n} ${/\.(vtt|srt)$/.test(name) ? 'cues' : 'non-empty lines'}`);
    if (ranges[name] && (n < ranges[name][0] || n > ranges[name][1])) {
      fail(`${name}: ${n} cues outside ${ranges[name][0]}-${ranges[name][1]}`);
    }
  }

  const participants = readJson(path.join(dir, 'participants.json'));
  const contacts = readJson(path.join(dir, 'contacts.json'));
  const items = readJson(path.join(dir, 'items.json'));

  // contacts
  if (!Array.isArray(contacts) || contacts.length !== 3) fail('contacts.json: expected array of 3');
  for (const c of contacts) {
    if (!c.name || !c.title || !/@halvorsen-freight\.example$/.test(c.email || '')) {
      fail(`contacts.json: bad contact ${JSON.stringify(c)}`);
    }
  }

  // participants
  for (const name of SEED_SOURCES) {
    const p = participants[name];
    if (!p) {
      fail(`participants.json: missing entry for ${name}`);
      continue;
    }
    if (!/^[A-Z]{2}$/.test(p.jurisdiction || '')) fail(`participants.json: ${name} jurisdiction not a US state code`);
    if (p.consent_attested !== true) fail(`participants.json: ${name} consent_attested must be true`);
    if (/\.(vtt|srt)$/.test(name) && !MACHINE_STATES.includes(p.jurisdiction)) {
      fail(`participants.json: ${name} jurisdiction ${p.jurisdiction} not in ${MACHINE_STATES.join('/')}`);
    }
    if (!Array.isArray(p.participants) || p.participants.length < 4) fail(`participants.json: ${name} participants missing`);
  }
  const halvorsenNames = Object.values(participants)
    .flatMap((p) => p.participants || [])
    .filter((x) => x.org === 'Halvorsen Freight')
    .map((x) => x.name);
  for (const c of contacts) {
    if (!halvorsenNames.includes(c.name)) fail(`contacts.json: ${c.name} not a Halvorsen participant`);
  }

  // items: structure
  if (!Array.isArray(items) || items.length !== 24) fail(`items.json: expected 24 items, got ${items.length}`);
  const byKey = new Map();
  for (const it of items) {
    if (byKey.has(it.key)) fail(`items.json: duplicate key ${it.key}`);
    byKey.set(it.key, it);
  }
  const speakerOk = (srcName, speaker) => {
    const names = (participants[srcName]?.participants || []).map((x) => x.name);
    if (/\.(vtt|srt)$/.test(srcName)) return names.includes(speaker);
    return names.some((n) => n === speaker || n.split(' ')[0] === speaker);
  };
  for (const it of items) {
    const w = `items.json ${it.key}`;
    if (!KINDS.includes(it.kind)) fail(`${w}: invalid kind ${it.kind}`);
    if (!STATUSES.includes(it.demo_status)) fail(`${w}: invalid demo_status ${it.demo_status}`);
    if (typeof it.statement !== 'string' || !it.statement.trim()) fail(`${w}: empty statement`);
    if (!Array.isArray(it.depends_on)) fail(`${w}: depends_on must be an array`);
    const manual = it.source === null;
    if (manual && (it.quote !== null || it.speaker !== null)) fail(`${w}: manual item must have null quote and speaker`);
    if (!manual) {
      if (!SEED_SOURCES.includes(it.source)) fail(`${w}: unknown source ${it.source}`);
      else {
        report(w, quoteProblems(sources[it.source], it.quote, it.speaker));
        if (/\.(vtt|srt)$/.test(it.source) && !it.speaker) fail(`${w}: machine transcript item needs a speaker`);
        if (it.speaker && !speakerOk(it.source, it.speaker)) fail(`${w}: speaker "${it.speaker}" not in participants.json`);
      }
    }
    for (const d of it.depends_on || []) {
      if (!byKey.has(d)) fail(`${w}: depends_on unknown key ${d}`);
      if (d === it.key) fail(`${w}: depends on itself`);
    }
    if ((it.depends_on || []).length && !['decision', 'requirement'].includes(it.kind)) {
      fail(`${w}: only decision/requirement may have depends_on (kind=${it.kind})`);
    }
    if (it.revises !== null && !byKey.has(it.revises)) fail(`${w}: revises unknown key ${it.revises}`);
    if (it.superseded_by != null) {
      const target = byKey.get(it.superseded_by);
      if (!target) fail(`${w}: superseded_by unknown key ${it.superseded_by}`);
      else if (target.revises !== it.key) fail(`${w}: superseded_by ${it.superseded_by} does not point back via revises`);
      if (it.demo_status !== 'superseded') fail(`${w}: superseded_by set but status is ${it.demo_status}`);
    }
    if (it.demo_status === 'superseded' && it.superseded_by == null && !items.some((x) => x.revises === it.key)) {
      fail(`${w}: superseded item has no replacement`);
    }
    if (it.demo_status === 'revised_after_confirmation' && it.revises === null) {
      fail(`${w}: revised_after_confirmation item must set revises`);
    }
    if (it.followup !== undefined) {
      const f = it.followup;
      if (!sources[f?.source]) fail(`${w}: followup.source invalid`);
      else {
        report(`${w} followup`, quoteProblems(sources[f.source], f.quote, f.speaker));
        if (!speakerOk(f.source, f.speaker)) fail(`${w}: followup speaker "${f.speaker}" not in participants.json`);
      }
    }
    if (['disputed', 'withdrawn'].includes(it.demo_status) && it.followup === undefined) {
      fail(`${w}: ${it.demo_status} item should carry a followup quote`);
    }
  }

  // items: coverage required by the spec
  const kinds = countBy(items, (i) => i.kind);
  const statuses = countBy(items, (i) => i.demo_status);
  const manualCount = items.filter((i) => i.source === null).length;
  for (const k of KINDS) if ((kinds[k] || 0) < 3) fail(`items.json: need >=3 of kind ${k}, got ${kinds[k] || 0}`);
  if (manualCount < 2) fail(`items.json: need >=2 manual items, got ${manualCount}`);
  const minStatus = {
    confirmed: 8,
    pending: 4,
    disputed: 2,
    withdrawn: 1,
    superseded: 1,
    revised_after_confirmation: 2,
    needs_review: 2,
  };
  for (const [s, min] of Object.entries(minStatus)) {
    if ((statuses[s] || 0) < min) fail(`items.json: need >=${min} ${s}, got ${statuses[s] || 0}`);
  }

  // items: demo storylines
  const revised = items.find(
    (i) =>
      i.demo_status === 'revised_after_confirmation' &&
      /5:00/.test(i.statement) &&
      i.revises &&
      /5:30/.test(byKey.get(i.revises)?.quote || ''),
  );
  if (!revised) fail('items.json: missing the 5:30 -> 5:00 revised_after_confirmation pair');
  const needsReview = items.filter((i) => i.demo_status === 'needs_review');
  for (const n of needsReview) {
    const changed = (n.depends_on || []).some((d) =>
      ['superseded', 'disputed', 'withdrawn', 'revised_after_confirmation'].includes(byKey.get(d)?.demo_status),
    );
    if (!changed) fail(`items.json ${n.key}: needs_review item depends on nothing that changed`);
  }
  if (
    !items.some(
      (i) =>
        i.kind === 'decision' &&
        i.source === '03-scope-call.srt' &&
        i.depends_on.some((d) => byKey.get(d)?.kind === 'assumption'),
    )
  ) {
    fail('items.json: missing a scope-call decision that depends on an assumption');
  }

  summary.push(`seed items: ${items.length} total, ${manualCount} manual`);
  summary.push(`  by kind:   ${fmtCounts(kinds)}`);
  summary.push(`  by status: ${fmtCounts(statuses)}`);
  summary.push(`  by source: ${fmtCounts(countBy(items, (i) => i.source ?? 'manual'))}`);
}

// ---------------------------------------------------------------- eval

function parseNotes(notes, where) {
  const flags = { candidates: {}, expected: {} };
  if (!Array.isArray(notes)) {
    fail(`${where}: _notes must be an array`);
    return flags;
  }
  for (const n of notes) {
    const m = /^(candidates|expected)\[(\d+)\]:\s*([A-Z_]+)\b/.exec(n);
    if (!m) continue; // free-form note
    flags[m[1]][Number(m[2])] = m[3];
  }
  return flags;
}

function checkEval(summary) {
  const dir = path.join(HERE, 'eval');
  const totals = Object.fromEntries(Object.keys(FLAW_TOTALS).map((k) => [k, 0]));

  for (const name of EVAL_SOURCES) {
    const src = loadSource(dir, name);
    if (!src) continue;
    const base = name.replace(/\.[^.]+$/, '');
    const n = unitCount(name, src.raw);
    if (n < 25 || n > 45) fail(`eval/${name}: ${n} units outside 25-45`);

    const expectedFile = readJson(path.join(dir, `${base}.expected.json`));
    const recorded = readJson(path.join(dir, `${base}.recorded.json`));
    if (expectedFile.source !== name) fail(`${base}.expected.json: source should be ${name}`);
    const expected = expectedFile.expected || [];
    if (expected.length < 5 || expected.length > 8) fail(`${base}.expected.json: ${expected.length} items outside 5-8`);

    expected.forEach((e, i) => {
      const w = `${base}.expected[${i}]`;
      if (!KINDS.includes(e.kind)) fail(`${w}: invalid kind ${e.kind}`);
      if (!e.statement) fail(`${w}: missing statement`);
      report(w, quoteProblems(src, e.quote, null));
    });
    const expQuotes = expected.map((e) => e.quote);
    if (new Set(expQuotes).size !== expQuotes.length) fail(`${base}.expected.json: duplicate quotes`);

    const flags = parseNotes(recorded._notes, `${base}.recorded.json`);
    const cands = recorded.candidates || [];
    const found = { WRONG_OFFSETS: [], HALLUCINATED_QUOTE: [], FALSE_POSITIVE: [], KIND_MISMATCH: [] };

    cands.forEach((c, i) => {
      const w = `${base}.candidates[${i}]`;
      for (const k of ['kind', 'statement', 'quote', 'start', 'end', 'speaker_label', 'confidence', 'suggested_depends_on', 'revises']) {
        if (!(k in c)) fail(`${w}: missing field ${k}`);
      }
      if (!KINDS.includes(c.kind)) fail(`${w}: invalid kind ${c.kind}`);
      if (!(c.confidence >= 0 && c.confidence <= 1)) fail(`${w}: confidence outside 0-1`);
      if (!Array.isArray(c.suggested_depends_on)) fail(`${w}: suggested_depends_on must be an array`);
      if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start >= c.end) fail(`${w}: bad start/end`);

      const occ = typeof c.quote === 'string' ? occurrences(src.text, c.quote) : -1;
      if (occ === 0) {
        found.HALLUCINATED_QUOTE.push(i);
        return; // deliberate hallucination: nothing else to verify
      }
      report(w, quoteProblems(src, c.quote, c.speaker_label));
      if (src.text.slice(c.start, c.end) !== c.quote) found.WRONG_OFFSETS.push(i);
      const match = expected.find((e) => e.quote === c.quote);
      if (!match) found.FALSE_POSITIVE.push(i);
      else if (match.kind !== c.kind) found.KIND_MISMATCH.push(i);
    });

    const candQuotes = new Set(cands.map((c) => c.quote));
    const missed = expected.map((e, i) => (candQuotes.has(e.quote) ? -1 : i)).filter((i) => i >= 0);

    // The _notes must list exactly the flaws that are really in the data.
    for (const flag of CANDIDATE_FLAWS) {
      const noted = Object.entries(flags.candidates)
        .filter(([, f]) => f === flag)
        .map(([i]) => Number(i));
      if (JSON.stringify(noted.sort()) !== JSON.stringify([...found[flag]].sort())) {
        fail(`${base}.recorded.json: _notes ${flag} ${JSON.stringify(noted)} != actual ${JSON.stringify(found[flag])}`);
      }
      totals[flag] += found[flag].length;
    }
    const notedMissed = Object.entries(flags.expected)
      .filter(([, f]) => f === 'MISSED')
      .map(([i]) => Number(i));
    if (JSON.stringify(notedMissed.sort()) !== JSON.stringify(missed)) {
      fail(`${base}.recorded.json: _notes MISSED ${JSON.stringify(notedMissed)} != actual ${JSON.stringify(missed)}`);
    }
    totals.MISSED += missed.length;

    summary.push(
      `eval/${name}: ${n} units, ${expected.length} expected, ${cands.length} candidates | ` +
        `offsets=${found.WRONG_OFFSETS.length} halluc=${found.HALLUCINATED_QUOTE.length} ` +
        `fp=${found.FALSE_POSITIVE.length} missed=${missed.length} kind=${found.KIND_MISMATCH.length}`,
    );
  }

  for (const [flag, want] of Object.entries(FLAW_TOTALS)) {
    if (totals[flag] !== want) fail(`eval flaw census: ${flag} total ${totals[flag]} != required ${want}`);
  }
  summary.push(`eval flaw census: ${fmtCounts(totals)}`);
}

// ---------------------------------------------------------------- main

function main() {
  const summary = [];
  for (const fn of [checkSeed, checkEval]) {
    try {
      fn(summary);
    } catch (err) {
      fail(`${fn.name} crashed: ${err.message}`);
    }
  }
  console.log(summary.join('\n'));
  if (failures.length) {
    console.error(`\nFAILED: ${failures.length} problem(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nOK: all fixture checks passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { cueTexts };
