import type { Score } from '../music/types';

export type GameKind = 'falling' | 'quiz';

export interface GamesPageProps {
  score: Score;
  onStart: (kind: GameKind) => void;
}

const GAMES: Array<{
  kind: GameKind;
  icon: string;
  title: string;
  tagline: string;
  bullets: string[];
}> = [
  {
    kind: 'falling',
    icon: '🎹',
    title: 'Falling Notes',
    tagline: 'Hit the keys as the notes reach the line.',
    bullets: ['Perfect / Great / Good timing', 'Combo, score & accuracy', 'Slow it down to 50% when learning'],
  },
  {
    kind: 'quiz',
    icon: '👂',
    title: 'Ear & Key Training',
    tagline: 'Find the note by ear or by name.',
    bullets: ['10 rounds per run', 'Hear-the-note and find-the-key modes', 'Builds note recognition fast'],
  },
];

export function GamesPage({ score, onStart }: GamesPageProps) {
  return (
    <div className="games-page">
      <div className="games-hero">
        <p className="eyebrow">Practice room</p>
        <h2>Turn practice into a game</h2>
        <p className="muted">
          Both games use your current song: <strong>{score.title}</strong>. Pick one and start
          playing — the piano keys and sound are the same as in the studio.
        </p>
      </div>
      <div className="game-cards">
        {GAMES.map((game) => (
          <article key={game.kind} className="game-card">
            <div className="game-icon" aria-hidden="true">
              {game.icon}
            </div>
            <h3>{game.title}</h3>
            <p>{game.tagline}</p>
            <ul>
              {game.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
            <button
              type="button"
              className="primary game-start"
              onClick={() => onStart(game.kind)}
            >
              Play {game.title}
            </button>
          </article>
        ))}
      </div>
      <div className="games-tip muted">
        Tip: turn your speakers on and press any key once to enable audio. In Falling Notes, you can
        slow the tempo down and switch on the guide so you hear the tune while you learn it.
      </div>
    </div>
  );
}
