/**
 * Ear-training / key-finding quiz.
 *
 * Ten rounds, two modes:
 *  - "Hear the note": the engine plays a note from C4..C5, the player finds the key.
 *  - "Find the key": the note name is shown, the player presses that exact key.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PianoEngine } from '../audio/PianoEngine';
import { midiToName } from '../music/pitch';
import {
  MAX_OCTAVE,
  MIN_OCTAVE,
  QWERTY_KEYMAP,
  octaveBaseMidi,
  qwertyLabelForMidi,
} from '../music/keymap';
import {
  QUIZ_BONUS_WINDOW_MS,
  QUIZ_KEYBOARD_HIGH_MIDI,
  QUIZ_KEYBOARD_LOW_MIDI,
  QUIZ_MODE_LABELS,
  QUIZ_ROUNDS,
  buildQuizKeyboard,
  generateQuizRun,
  isQuizCorrect,
  quizPoints,
  summarizeQuiz,
  validateQuizRun,
  type QuizAnswer,
  type QuizMode,
  type QuizRound,
  type QuizSummary,
} from './quizLogic';
import './GameView.css';

export interface QuizViewProps {
  engine: PianoEngine;
  onExit: () => void;
  onActiveKeysChange?: (midis: number[]) => void;
}

type QuizPhase = 'idle' | 'playing' | 'feedback' | 'results';

interface Feedback {
  kind: 'correct' | 'wrong';
  text: string;
  sub: string;
}

const MODE_ORDER: QuizMode[] = ['ear', 'find'];
const QUIZ_OCTAVE_MIN = 4;
const QUIZ_OCTAVE_MAX = 5;
const ADVANCE_CORRECT_MS = 1000;
const ADVANCE_WRONG_MS = 2000;
const REPLAY_LABEL = 'Play the note again';
const HIDDEN_NOTE_LABEL = '?';

function safeAudio(action: () => void): void {
  try {
    action();
  } catch {
    // A disposed / unavailable AudioContext must never break the quiz.
  }
}

function clearTimer(ref: { current: number | null }): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function quizKeyLayout(key: { black: boolean; whiteIndex: number }): {
  left: string;
  width: string;
} {
  const whiteWidth = 100 / 14;
  if (key.black) {
    const width = whiteWidth * 0.62;
    return {
      left: `calc(${(key.whiteIndex + 1) * whiteWidth}% - ${width / 2}%)`,
      width: `${width}%`,
    };
  }
  return { left: `${key.whiteIndex * whiteWidth}%`, width: `${whiteWidth}%` };
}

export function QuizView({ engine, onExit, onActiveKeysChange }: QuizViewProps) {
  const engineRef = useRef<PianoEngine>(engine);
  const callbacksRef = useRef({ onExit, onActiveKeysChange });
  const mountedRef = useRef(false);
  const startingRef = useRef(false);
  const phaseRef = useRef<QuizPhase>('idle');
  const roundsRef = useRef<QuizRound[]>([]);
  const roundIndexRef = useRef(0);
  const roundStartRef = useRef(0);
  const answersRef = useRef<QuizAnswer[]>([]);
  const scoreRef = useRef(0);
  const streakRef = useRef(0);
  const bestStreakRef = useRef(0);
  const octaveRef = useRef(4);
  const playTimerRef = useRef<number | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const soundTimerRef = useRef<number | null>(null);
  const activeKeyTimerRef = useRef<number | null>(null);

  const [phase, setPhaseState] = useState<QuizPhase>('idle');
  const [mode, setMode] = useState<QuizMode>('ear');
  const [rounds, setRounds] = useState<QuizRound[]>([]);
  const [roundIndex, setRoundIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pressedMidi, setPressedMidi] = useState<number | null>(null);
  const [correctMidi, setCorrectMidi] = useState<number | null>(null);
  const [lastWasCorrect, setLastWasCorrect] = useState<boolean | null>(null);
  const [octave, setOctave] = useState(4);
  const [summary, setSummary] = useState<QuizSummary | null>(null);
  const [starting, setStarting] = useState(false);

  const keys = useMemo(() => buildQuizKeyboard(), []);
  const currentRound = rounds[roundIndex] ?? rounds[0] ?? null;
  const activeMode = currentRound?.mode ?? mode;

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);
  useEffect(() => {
    callbacksRef.current = { onExit, onActiveKeysChange };
  }, [onExit, onActiveKeysChange]);

  const clearAllTimers = useCallback(() => {
    clearTimer(playTimerRef);
    clearTimer(advanceTimerRef);
    clearTimer(soundTimerRef);
    clearTimer(activeKeyTimerRef);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAllTimers();
      safeAudio(() => engine.stopAll());
      try {
        callbacksRef.current.onActiveKeysChange?.([]);
      } catch {
        // ignore consumer errors
      }
    };
  }, [clearAllTimers, engine]);

  const pushPhase = useCallback((next: QuizPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const flashActiveKey = useCallback((midi: number) => {
    try {
      callbacksRef.current.onActiveKeysChange?.([midi]);
    } catch {
      // ignore consumer errors
    }
    clearTimer(activeKeyTimerRef);
    activeKeyTimerRef.current = window.setTimeout(() => {
      try {
        callbacksRef.current.onActiveKeysChange?.([]);
      } catch {
        // ignore
      }
    }, 240);
  }, []);

  const playNote = useCallback((midi: number, velocity = 84, duration = 0.8) => {
    safeAudio(() => {
      const instance = engineRef.current;
      instance.scheduleNote(midi, velocity, instance.now() + 0.03, duration);
    });
  }, []);

  const changeOctave = useCallback((delta: 1 | -1) => {
    const next = clamp(octaveRef.current + delta, QUIZ_OCTAVE_MIN, QUIZ_OCTAVE_MAX);
    if (next === octaveRef.current) return;
    if (next < MIN_OCTAVE || next > MAX_OCTAVE) return;
    octaveRef.current = next;
    setOctave(next);
  }, []);

  const finishRun = useCallback(() => {
    clearAllTimers();
    safeAudio(() => engineRef.current.stopAll());
    setFeedback(null);
    setSummary(summarizeQuiz(answersRef.current, QUIZ_ROUNDS));
    pushPhase('results');
  }, [clearAllTimers, pushPhase]);

  const beginRound = useCallback(
    (index: number, runMode: QuizMode) => {
      const run = roundsRef.current;
      const round = run[index];
      if (!round) {
        finishRun();
        return;
      }
      clearTimer(playTimerRef);
      clearTimer(advanceTimerRef);
      clearTimer(soundTimerRef);
      roundIndexRef.current = index;
      roundStartRef.current = performance.now();
      setRoundIndex(index);
      setFeedback(null);
      setPressedMidi(null);
      setCorrectMidi(null);
      setLastWasCorrect(null);
      pushPhase('playing');
      if (runMode === 'ear') {
        playTimerRef.current = window.setTimeout(() => {
          playNote(round.midi, 84, 0.85);
        }, 200);
      }
    },
    [finishRun, playNote, pushPhase],
  );

  const startRun = useCallback(
    async (nextMode: QuizMode) => {
      if (startingRef.current) return;
      startingRef.current = true;
      setStarting(true);
      clearAllTimers();
      try {
        await engineRef.current.ensureStarted();
      } catch {
        // The quiz still works visually without audio.
      }
      startingRef.current = false;
      if (!mountedRef.current) return;
      setStarting(false);
      setMode(nextMode);
      let run = generateQuizRun(nextMode, { rounds: QUIZ_ROUNDS, seed: Date.now() });
      if (validateQuizRun(run).length > 0) {
        run = generateQuizRun(nextMode, { rounds: QUIZ_ROUNDS, seed: 7 });
      }
      roundsRef.current = run;
      answersRef.current = [];
      scoreRef.current = 0;
      streakRef.current = 0;
      bestStreakRef.current = 0;
      setRounds(run);
      setAnswers([]);
      setScore(0);
      setStreak(0);
      setBestStreak(0);
      setSummary(null);
      octaveRef.current = QUIZ_OCTAVE_MIN;
      setOctave(QUIZ_OCTAVE_MIN);
      beginRound(0, nextMode);
    },
    [beginRound, clearAllTimers],
  );

  const handleAnswer = useCallback(
    (midi: number) => {
      if (phaseRef.current !== 'playing') return;
      const round = roundsRef.current[roundIndexRef.current];
      if (!round) return;
      const elapsedMs = Math.max(0, performance.now() - roundStartRef.current);
      const correct = isQuizCorrect(round, midi);
      const points = quizPoints(correct, elapsedMs);
      const answer: QuizAnswer = {
        roundIndex: round.index,
        targetMidi: round.midi,
        playedMidi: midi,
        mode: round.mode,
        correct,
        elapsedMs,
        points,
      };
      const nextAnswers = [...answersRef.current, answer];
      answersRef.current = nextAnswers;
      setAnswers(nextAnswers);
      scoreRef.current += points;
      setScore(scoreRef.current);
      if (correct) {
        streakRef.current += 1;
        bestStreakRef.current = Math.max(bestStreakRef.current, streakRef.current);
      } else {
        streakRef.current = 0;
      }
      setStreak(streakRef.current);
      setBestStreak(bestStreakRef.current);
      setPressedMidi(midi);
      setCorrectMidi(round.midi);
      setLastWasCorrect(correct);
      const targetName = midiToName(round.midi);
      const playedName = midiToName(midi);
      const feedbackKind: Feedback['kind'] = correct ? 'correct' : 'wrong';
      setFeedback({
        kind: feedbackKind,
        text: correct
          ? `Correct! ${targetName}`
          : round.mode === 'ear'
            ? `That was ${targetName}`
            : `That was ${targetName}, you pressed ${playedName}`,
        sub: correct
          ? `+${points} points${streakRef.current > 1 ? ` · ${streakRef.current} in a row` : ''}`
          : round.mode === 'ear'
            ? 'Listen to the two notes and notice the distance between them.'
            : `Look for ${targetName} on the keyboard — it is highlighted.`,
      });
      pushPhase('feedback');
      flashActiveKey(midi);

      // Press sound, then reveal the target note (ear mode always, find mode only when correct).
      playNote(midi, 76, 0.35);
      clearTimer(soundTimerRef);
      if (correct || round.mode === 'ear') {
        soundTimerRef.current = window.setTimeout(
          () => playNote(round.midi, 88, 0.65),
          correct ? 160 : 420,
        );
      }

      clearTimer(advanceTimerRef);
      advanceTimerRef.current = window.setTimeout(
        () => {
          const nextIndex = roundIndexRef.current + 1;
          if (nextIndex >= roundsRef.current.length) finishRun();
          else beginRound(nextIndex, roundsRef.current[nextIndex].mode);
        },
        correct ? ADVANCE_CORRECT_MS : ADVANCE_WRONG_MS,
      );
    },
    [beginRound, finishRun, flashActiveKey, playNote, pushPhase],
  );

  const replayNote = useCallback(() => {
    if (phaseRef.current !== 'playing') return;
    const round = roundsRef.current[roundIndexRef.current];
    if (!round) return;
    void engineRef.current
      .ensureStarted()
      .then(() => playNote(round.midi, 86, 0.9))
      .catch(() => {
        // Audio unavailable; keep the quiz playable.
      });
  }, [playNote]);

  const backToIdle = useCallback(() => {
    clearAllTimers();
    safeAudio(() => engineRef.current.stopAll());
    roundsRef.current = [];
    answersRef.current = [];
    setRounds([]);
    setAnswers([]);
    setSummary(null);
    setFeedback(null);
    setPressedMidi(null);
    setCorrectMidi(null);
    pushPhase('idle');
  }, [clearAllTimers, pushPhase]);

  const exitQuiz = useCallback(() => {
    clearAllTimers();
    safeAudio(() => engineRef.current.stopAll());
    try {
      callbacksRef.current.onExit();
    } catch {
      // ignore consumer errors
    }
  }, [clearAllTimers]);

  // Physical keyboard input for the quiz.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'x') {
        event.preventDefault();
        changeOctave(key === 'z' ? -1 : 1);
        return;
      }
      const semitone = QWERTY_KEYMAP[key];
      if (semitone === undefined) return;
      const midi = octaveBaseMidi(octaveRef.current) + semitone;
      if (midi < QUIZ_KEYBOARD_LOW_MIDI || midi > QUIZ_KEYBOARD_HIGH_MIDI) return;
      event.preventDefault();
      handleAnswer(midi);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [changeOctave, handleAnswer]);

  // ------------------------------------------------------------------ render

  const dotStatus = (index: number): string => {
    const answer = answers.find((item) => item.roundIndex === index);
    if (answer) return answer.correct ? 'correct' : 'wrong';
    if (index === roundIndex) return 'current';
    return '';
  };

  const targetName = currentRound ? midiToName(currentRound.midi) : '';
  const showReveal = phase === 'feedback' && currentRound !== null;

  const idleContent = (
    <div className="game-dialog">
      <p className="game-eyebrow">Ear &amp; keyboard training</p>
      <h3>Ten rounds, one note at a time</h3>
      <p className="game-dialog-lede">
        Train your ear and your keyboard geography. Choose a mode, then answer all ten rounds.
        Fast, correct answers earn a timing bonus.
      </p>
      <div className="quiz-mode-grid" role="group" aria-label="Quiz mode">
        {MODE_ORDER.map((item) => (
          <button
            key={item}
            type="button"
            className={`quiz-mode-card ${mode === item ? 'selected' : ''}`}
            aria-pressed={mode === item}
            onClick={() => setMode(item)}
          >
            <span className="mode-icon" aria-hidden="true">
              {item === 'ear' ? '♪' : '♯'}
            </span>
            <strong>{QUIZ_MODE_LABELS[item]}</strong>
            <span>
              {item === 'ear'
                ? 'A note is played — find the matching key. The name stays hidden until you answer.'
                : 'The note name is shown — press that exact key on the keyboard.'}
            </span>
          </button>
        ))}
      </div>
      <div className="game-actions">
        <button
          type="button"
          className="primary"
          data-autostart="start"
          onClick={() => void startRun(mode)}
          disabled={starting}
        >
          {starting ? 'Starting…' : 'Start practice'}
        </button>
        <button type="button" className="ghost" onClick={exitQuiz}>
          Back to library
        </button>
      </div>
      <p className="game-hint">
        Targets are C4–C5 on a two-octave keyboard. Click the keys or use{' '}
        <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>G</kbd> <kbd>H</kbd>{' '}
        <kbd>J</kbd> <kbd>K</kbd> and <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd>{' '}
        <kbd>U</kbd>; <kbd>Z</kbd>/<kbd>X</kbd> shifts the octave.
      </p>
    </div>
  );

  const resultsContent =
    summary && currentRound !== null ? (
      <div className="game-dialog quiz-results">
        <div className="game-results">
          <div className="game-results-head">
            <div className={`game-rank rank-${summary.rank}`} aria-hidden="true">
              {summary.rank}
            </div>
            <div className="game-results-title">
              <p className="game-eyebrow">{QUIZ_MODE_LABELS[activeMode]} · complete</p>
              <div className="game-results-score">
                {summary.score.toLocaleString('en-US')}
                <small>points</small>
              </div>
              <p className="game-dialog-lede">
                {summary.correct}/{summary.rounds} correct · {summary.accuracy.toFixed(0)}%
                accuracy · best streak {summary.bestStreak} · average{' '}
                {(summary.averageMs / 1000).toFixed(1)}s per answer
              </p>
            </div>
          </div>
          <div className="game-result-grid">
            <div className="game-result-stat">
              <span>Correct</span>
              <strong>{summary.correct}</strong>
            </div>
            <div className="game-result-stat miss">
              <span>Wrong</span>
              <strong>{summary.wrong}</strong>
            </div>
            <div className="game-result-stat">
              <span>Best streak</span>
              <strong>{summary.bestStreak}</strong>
            </div>
            <div className="game-result-stat">
              <span>Avg. time</span>
              <strong>{(summary.averageMs / 1000).toFixed(1)}s</strong>
            </div>
          </div>
          <div className="game-actions">
            <button
              type="button"
              className="primary"
              data-autostart="retry"
              onClick={() => void startRun(activeMode)}
            >
              Retry
            </button>
            <button type="button" onClick={backToIdle}>
              Change mode
            </button>
            <span className="spacer" />
            <button type="button" className="ghost" onClick={exitQuiz}>
              Back to library
            </button>
          </div>
          <p className="game-hint">
            Tip: if a mode feels hard, start with “Find the key” to learn the layout, then switch to
            “Hear the note”.
          </p>
        </div>
      </div>
    ) : null;

  const playContent = (
    <div className="quiz-content">
      <div className="quiz-progress-dots" aria-hidden="true">
        {rounds.map((round) => (
          <span key={round.index} className={`quiz-dot ${dotStatus(round.index)}`} />
        ))}
      </div>

      <div className="quiz-prompt">
        <p className="quiz-prompt-label">
          {activeMode === 'ear'
            ? showReveal
              ? 'It was'
              : 'Listen and find the key'
            : 'Press this key'}
        </p>
        {activeMode === 'ear' && !showReveal ? (
          <div className="quiz-note hidden-note" aria-label="Hidden note">
            {HIDDEN_NOTE_LABEL}
          </div>
        ) : (
          <div className="quiz-note" aria-live="polite">
            {targetName}
          </div>
        )}
        <p className="quiz-prompt-hint">
          {phase === 'feedback'
            ? activeMode === 'ear'
              ? 'The correct key is highlighted below.'
              : 'The correct key is highlighted below.'
            : activeMode === 'ear'
              ? 'Which key did you hear? Click it or press its keyboard letter.'
              : `Find ${targetName} on the keyboard below — the octave matters.`}
        </p>
        {activeMode === 'ear' && phase === 'playing' ? (
          <button type="button" className="quiz-replay" onClick={replayNote}>
            <span className="speaker" aria-hidden="true">
              ♪
            </span>
            {REPLAY_LABEL}
          </button>
        ) : null}
      </div>

      <div className="quiz-feedback" role="status" aria-live="polite" aria-atomic="true">
        {feedback ? (
          <>
            <span className={`quiz-feedback-line ${feedback.kind}`}>
              <span aria-hidden="true">{feedback.kind === 'correct' ? '✓' : '✕'}</span>
              {feedback.text}
            </span>
            <span className="quiz-feedback-sub">{feedback.sub}</span>
          </>
        ) : (
          <span className="quiz-feedback-sub">
            Each run is ten rounds of notes from C4 to C5.
          </span>
        )}
      </div>

      <div className="quiz-keyboard" role="group" aria-label="Piano keys">
        {keys.map((key) => {
          const style = quizKeyLayout(key);
          const hint = qwertyLabelForMidi(key.midi, octave);
          const isRevealed = phase === 'feedback' && correctMidi === key.midi;
          const isPressedWrong =
            phase === 'feedback' && lastWasCorrect === false && pressedMidi === key.midi;
          const classes = [
            'quiz-key',
            key.black ? 'black-key' : 'white-key',
            isRevealed ? 'correct-key' : '',
            isPressedWrong ? 'wrong-key' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={key.midi}
              type="button"
              className={classes}
              style={style}
              aria-label={`Play ${key.name}`}
              aria-disabled={phase !== 'playing'}
              onClick={() => handleAnswer(key.midi)}
            >
              <span className="quiz-key-hint">{hint ?? ''}</span>
              <span className="quiz-key-name">{key.name}</span>
            </button>
          );
        })}
      </div>

      <div className="quiz-hud-line">
        <span>
          Round{' '}
          <strong>
            {Math.min(roundIndex + 1, QUIZ_ROUNDS)}/{QUIZ_ROUNDS}
          </strong>
        </span>
        <span>
          Score <strong>{score}</strong>
        </span>
        <span>
          Streak{' '}
          <strong className={streak >= 3 ? 'streak-hot' : ''}>{streak}</strong>
        </span>
        <span>
          Best <strong>{bestStreak}</strong>
        </span>
        <span>
          Octave <strong>{octave}</strong>
        </span>
        <span>
          Timing bonus window <strong>{QUIZ_BONUS_WINDOW_MS / 1000}s</strong>
        </span>
      </div>
    </div>
  );

  return (
    <div className="quiz-view" data-phase={phase}>
      <div className="quiz-topbar">
        <div className="quiz-topbar-main">
          <h2 className="quiz-title">Ear Training</h2>
          <p className="quiz-subtitle">
            {QUIZ_MODE_LABELS[activeMode]} · {QUIZ_ROUNDS} rounds · notes C4–C5
          </p>
        </div>
        <div className="quiz-topbar-actions">
          {phase === 'playing' || phase === 'feedback' ? (
            <span className="game-chip">
              Round{' '}
              <strong>
                {Math.min(roundIndex + 1, QUIZ_ROUNDS)}/{QUIZ_ROUNDS}
              </strong>
            </span>
          ) : null}
          <span className="game-chip accent">
            Score <strong>{score}</strong>
          </span>
          <span className="game-chip">
            Streak <strong>{streak}</strong>
          </span>
          <button type="button" className="ghost" onClick={exitQuiz}>
            Back to library
          </button>
        </div>
      </div>

      <div className="quiz-stage">
        {phase === 'idle' ? idleContent : null}
        {phase === 'results' ? resultsContent : null}
        {phase === 'playing' || phase === 'feedback' ? playContent : null}
      </div>
    </div>
  );
}
