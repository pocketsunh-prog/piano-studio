/**
 * Turns a free-text request ("dreamy waltz in A minor, 16 bars, slow") into
 * composer options. Used by the AI Composer dialog to make generation feel
 * prompt-driven while keeping the actual composition deterministic and local.
 */
import type {
  AiDifficulty,
  AiMood,
  AiStyle,
  AiTimeSignature,
} from './composer';

export interface AiPromptSpec {
  style?: AiStyle;
  mood?: AiMood;
  keyRoot?: number;
  mode?: 'major' | 'minor';
  bars?: number;
  bpm?: number;
  timeSignature?: AiTimeSignature;
  difficulty?: AiDifficulty;
}

const NOTE_BASE: Record<string, number> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

export function parsePrompt(prompt: string): AiPromptSpec {
  const text = prompt.toLowerCase().replace(/♭/g, 'b').replace(/♯/g, '#');
  const spec: AiPromptSpec = {};

  // Style
  if (/\bwaltz\b|\bvalse\b/.test(text)) {
    spec.style = 'waltz';
    spec.timeSignature = '3/4';
  } else if (/\bjazz\b/.test(text)) spec.style = 'jazz';
  else if (/\bambient\b|\batmospheric\b/.test(text)) spec.style = 'ambient';
  else if (/\bpop\b/.test(text)) spec.style = 'pop';
  else if (/\bromantic\b/.test(text)) spec.style = 'romantic';
  else if (/\bclassical\b/.test(text) || /\bcinematic\b/.test(text)) spec.style = 'classical';

  // Mood
  if (/\bsad\b|\bmelanchol|\bmoody\b|\bdark\b|\bwistful\b/.test(text)) {
    spec.mood = 'melancholic';
  } else if (/\bepic\b|\bdramatic\b|\bpowerful\b|\bheroic\b|\bcinematic\b/.test(text)) {
    spec.mood = 'epic';
  } else if (/\bcalm\b|\brelax|\bpeaceful\b|\bquiet\b|\bsoft\b|\bslow\b/.test(text)) {
    spec.mood = 'calm';
  } else if (/\bdream|\bethereal\b|\bfloating\b|\bmoon\b|\bnocturn|\bnight\b/.test(text)) {
    spec.mood = 'dreamy';
  } else if (/\bhappy\b|\bjoyful\b|\bupbeat\b|\bcheerful\b|\bbright\b/.test(text)) {
    spec.mood = 'happy';
  }

  // Key + mode: "in A minor", "F# major", "in D"
  const explicitKey =
    /(?:in|key of)\s+([a-g])([#b]?)\s*(major|minor|maj|min|m)?\b/.exec(text) ??
    /\b([a-g])([#b]?)\s*(major|minor)\b/.exec(text);
  if (explicitKey) {
    const letter = explicitKey[1];
    const accidental = explicitKey[2] ?? '';
    let pitch = NOTE_BASE[letter];
    if (accidental === '#') pitch += 1;
    if (accidental === 'b') pitch -= 1;
    spec.keyRoot = ((pitch % 12) + 12) % 12;
    const modeText = explicitKey[3] ?? '';
    if (modeText.startsWith('min') || modeText === 'm') spec.mode = 'minor';
    else if (modeText.startsWith('maj')) spec.mode = 'major';
  }

  // If the key was written without a mode, infer it from the mood.
  if (spec.keyRoot !== undefined && spec.mode === undefined) {
    if (spec.mood === 'melancholic' || spec.mood === 'epic') spec.mode = 'minor';
    else if (spec.mood === 'happy') spec.mode = 'major';
  }

  // Length, tempo, meter
  const barsMatch = /(\d{1,2})\s*(?:bars?|measures?)/.exec(text);
  if (barsMatch) spec.bars = Math.min(48, Math.max(4, Number(barsMatch[1])));

  const bpmMatch = /(\d{2,3})\s*bpm\b/.exec(text);
  if (bpmMatch) spec.bpm = Math.min(180, Math.max(45, Number(bpmMatch[1])));

  const meterMatch = /\b(3\/4|4\/4|6\/8)\b/.exec(text);
  if (meterMatch) spec.timeSignature = meterMatch[1] as AiTimeSignature;

  // Difficulty
  if (/\bbeginner\b|\beasy\b|\bsimple\b/.test(text)) spec.difficulty = 'easy';
  else if (/\badvanced\b|\bhard\b|\bvirtuoso\b|\bcomplex\b/.test(text)) {
    spec.difficulty = 'advanced';
  } else if (/\bintermediate\b|\bmedium\b/.test(text)) spec.difficulty = 'medium';

  return spec;
}
