import { useCallback, useEffect, useMemo, useRef } from 'react';
import { MAX_PIANO_MIDI, MIN_PIANO_MIDI, isBlackKey, midiToName } from '../music/pitch';
import { qwertyLabelForMidi, octaveBaseMidi } from '../music/keymap';

export interface KeyboardProps {
  activeMidis: number[];
  pressedMidis?: number[];
  qwertyOctave: number;
  showLabels?: boolean;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
}

interface WhiteKey {
  midi: number;
}

interface BlackKey {
  midi: number;
  leftPct: number;
  widthPct: number;
}

const WHITE_KEY_COUNT = 52;

function buildKeys(): { whites: WhiteKey[]; blacks: BlackKey[] } {
  const whites: WhiteKey[] = [];
  const blacks: BlackKey[] = [];
  const whiteWidthPct = 100 / WHITE_KEY_COUNT;
  const blackWidthPct = whiteWidthPct * 0.62;
  let whiteCount = 0;

  for (let midi = MIN_PIANO_MIDI; midi <= MAX_PIANO_MIDI; midi += 1) {
    if (isBlackKey(midi)) {
      blacks.push({
        midi,
        leftPct: whiteCount * whiteWidthPct - blackWidthPct / 2,
        widthPct: blackWidthPct,
      });
    } else {
      whites.push({ midi });
      whiteCount += 1;
    }
  }
  return { whites, blacks };
}

/** Full 88-key playable piano with pointer multi-touch and QWERTY hints. */
export function Keyboard({
  activeMidis,
  pressedMidis,
  qwertyOctave,
  showLabels = true,
  onNoteOn,
  onNoteOff,
}: KeyboardProps) {
  const { whites, blacks } = useMemo(buildKeys, []);
  const activeSet = useMemo(() => new Set(activeMidis), [activeMidis]);
  const pressedSet = useMemo(() => new Set(pressedMidis ?? []), [pressedMidis]);
  const pointers = useRef(new Map<number, number>());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the chosen QWERTY octave in view — essential on phones, where only a
  // couple of octaves fit on screen at once.
  const centerKeyboard = useCallback(
    (smooth: boolean) => {
      const scroll = scrollRef.current;
      const piano = scroll?.querySelector<HTMLElement>('.piano');
      if (!scroll || !piano) return;
      const targetMidi = Math.max(MIN_PIANO_MIDI, Math.min(MAX_PIANO_MIDI, octaveBaseMidi(qwertyOctave)));
      let whiteIndex = 0;
      for (let midi = MIN_PIANO_MIDI; midi < targetMidi; midi += 1) {
        if (!isBlackKey(midi)) whiteIndex += 1;
      }
      const keyWidth = piano.clientWidth / WHITE_KEY_COUNT;
      const maxScroll = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      const left = Math.min(maxScroll, Math.max(0, whiteIndex * keyWidth - scroll.clientWidth / 2 + keyWidth));
      scroll.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    },
    [qwertyOctave],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => centerKeyboard(true));
    // Rotation or window resizing changes how much of the keyboard is visible,
    // so re-centre after the new layout settles.
    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => centerKeyboard(false), 120);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [centerKeyboard]);

  useEffect(
    () => () => {
      for (const midi of pointers.current.values()) onNoteOff(midi);
      pointers.current.clear();
    },
    [onNoteOff],
  );

  const press = (midi: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
    pointers.current.set(event.pointerId, midi);
    onNoteOn(midi, 100);
  };

  const release = (event: React.PointerEvent<HTMLButtonElement>) => {
    const midi = pointers.current.get(event.pointerId);
    if (midi === undefined) return;
    pointers.current.delete(event.pointerId);
    onNoteOff(midi);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="piano-scroll" ref={scrollRef}>
      <div className="piano" role="group" aria-label="88-key piano keyboard">
      <div className="piano-white-row">
        {whites.map(({ midi }) => {
          const name = midiToName(midi);
          const qwerty = qwertyLabelForMidi(midi, qwertyOctave);
          const isC = midi % 12 === 0;
          return (
            <button
              key={midi}
              type="button"
              tabIndex={-1}
              aria-label={`Play ${name}`}
              className={[
                'piano-key',
                'white',
                activeSet.has(midi) ? 'active' : '',
                pressedSet.has(midi) ? 'pressed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerDown={press(midi)}
              onPointerUp={release}
              onPointerCancel={release}
              onPointerLeave={release}
              onContextMenu={(event) => event.preventDefault()}
            >
              {showLabels && (
                <span className="key-labels">
                  {qwerty && <span className="key-qwerty">{qwerty}</span>}
                  {isC && <span className="key-note">{name}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {blacks.map(({ midi, leftPct, widthPct }) => {
        const qwerty = qwertyLabelForMidi(midi, qwertyOctave);
        return (
          <button
            key={midi}
            type="button"
            tabIndex={-1}
            aria-label={`Play ${midiToName(midi)}`}
            className={[
              'piano-key',
              'black',
              'black-overlay',
              activeSet.has(midi) ? 'active' : '',
              pressedSet.has(midi) ? 'pressed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onPointerDown={press(midi)}
            onPointerUp={release}
            onPointerCancel={release}
            onPointerLeave={release}
            onContextMenu={(event) => event.preventDefault()}
          >
            {showLabels && qwerty && (
              <span className="key-labels">
                <span className="key-qwerty">{qwerty}</span>
              </span>
            )}
          </button>
        );
      })}
      </div>
    </div>
  );
}
