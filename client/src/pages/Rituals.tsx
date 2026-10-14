import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import Field from '../components/Field';
import '../rituals.css';
import { daysSince, useRituals } from '../stores/rituals';
import {
  formatDay,
  isCorrect,
  milestone,
  parseAnswer,
  verdict,
  type Streak,
} from '../lib/dailyPuzzle';

/**
 * Rituals — plan step 27.
 *
 * Three things two people do together, none of which is a score:
 *
 *   - the day's puzzle, identical for both of them because both of them
 *     compute it, and sealed until both have answered;
 *   - a letter streak counted on UTC days, with the longest run — not the live
 *     one — as the number worth reading;
 *   - a count of days since you paired, from a date only the two of you can read.
 *
 * Two rules this page is built around, both from docs/DESIGN.md §6 and from the
 * product thesis above them:
 *
 *   - Nothing nags. There is no red, no "you lost your streak", no reminder, no
 *     notification. A day you skipped is a blank cell in a calendar, which is
 *     exactly what it is.
 *   - Nothing moves that you did not cause. The only animation is the reveal,
 *     and it runs when your partner's answer finally unlocks yours.
 */

/**
 * Monday-first, which is what a paper calendar in the UK and EU is.
 *
 * Full three-letter days, not initials. Seven single letters is one character
 * per column, and a single character in a 46px column has no visual anchor: it
 * cannot be centred by eye, so a misaligned track is invisible rather than
 * obvious. Two characters ("Mo", "Tu") are wide enough to look centred whether
 * or not they are, which is what makes the header able to report that the grid
 * beneath it is crooked.
 */
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function cellLabel(ms: number): string {
  return String(new Date(ms).getUTCDate());
}

interface Cell {
  day: string;
  number: string;
  marked: boolean;
}

export default function Rituals() {
  const { summary, puzzle, streak, revealed, anniversary, loading, saving, error, notice, load, submitAnswer, saveAnniversary } =
    useRituals();
  const [raw, setRaw] = useState('');
  const [fieldError, setFieldError] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  const day = summary?.day ?? summary?.today ?? '';
  /**
  * A username is a login, not a person.
  *
  * Signup sets `friendly_name` to the username when the form does not collect
  * one, so the fallback is almost always a machine string like
  * `alex908460638`. Printing that inside a sentence about the two of you reads
  * as a serial number attached to a person, so the trailing digits are dropped
  * and only the leading word is kept. If that leaves nothing — a username that
  * is entirely digits — it says "your pen pal" rather than printing noise.
  */
  const partnerName = useMemo(() => {
    const friendly = summary?.partner?.friendly_name?.trim();
    const username = summary?.partner?.username?.trim() ?? '';
    const isMachineName = (s: string) => /\d{3,}$/.test(s);
    if (friendly && !isMachineName(friendly)) return friendly;
    const word = (username || friendly || '').split(/[_\-.]+/)[0] ?? '';
    const cleaned = word.replace(/\d+$/, '');
    if (!cleaned) return 'your pen pal';
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }, [summary?.partner]);

  const cells = useMemo(() => buildCells(streak), [streak]);
  const markedCount = cells.filter((c) => c.marked).length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFieldError('');
    const parsed = parseAnswer(raw);
    if (parsed === null) {
      setFieldError("Today's puzzle asks for a number. Type the digits only.");
      return;
    }
    await submitAnswer(parsed);
  };

  if (!loading && summary && !summary.paired) {
    return (
      <div className="rituals">
        <h1>Rituals</h1>
        <p className="rituals-lede">
          Three small things you and one other person do together. Two people is the whole
          requirement.
        </p>

        <div className="rit-empty">
          <h2>Today&rsquo;s puzzle</h2>
          <p>There is no puzzle without a partner. Send an invite, and today&rsquo;s appears here.</p>
          <Link to="/pairing" className="button">
            Send an invite
          </Link>
        </div>
      </div>
    );
  }

  const pairingDay = summary?.letters?.pairedAt ? summary.letters.pairedAt.slice(0, 10) : null;
  const firstLetterDay = summary?.letters?.firstLetterAt
    ? summary.letters.firstLetterAt.slice(0, 10)
    : null;
  // A date the two of them chose, sealed in their own key. Falls back to the day
  // the pairing was created, which the server can of course already see.
  const countedFrom = anniversary || pairingDay;
  const togetherDays = countedFrom && day ? daysSince(countedFrom, day) : 0;

  return (
    <div className="rituals">
      <h1>Rituals</h1>
      <p className="rituals-lede">
        Three things the two of you do. They keep waiting whether or not you do them today.
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {/* ---------------------------------------------------- the puzzle -- */}
      <section className="rit-section" aria-labelledby="rit-puzzle-heading">
        <h2 id="rit-puzzle-heading">Today&rsquo;s puzzle</h2>

        {loading || !puzzle ? (
          <p className="rit-section-note">Opening the day&rsquo;s puzzle&hellip;</p>
        ) : (
          <div className="rit-slip">
            <p className="rit-stub">{formatDay(puzzle.day)}</p>
            <div className="rit-slip-body">
              <p className="rit-question">{puzzle.prompt}</p>
              <p className="rit-question-note">
                {puzzle.note} Both of you get this one for the same day. It runs on UTC so your
                day and {partnerName}&rsquo;s are the same day.
              </p>

              {!revealed && (
                <form className="rit-answer-row" onSubmit={submit}>
                  <Field
                    id="rit-answer"
                    label="Your answer"
                    value={raw}
                    onChange={setRaw}
                    error={fieldError}
                    hint={summary?.puzzle?.mine ? 'Sealed. Your answer is waiting to be opened.' : undefined}
                    maxLength={8}
                    placeholder="0"
                  />
                  {/* Once an answer is sealed this row is finished. Leaving the
                      button live invites a second submission while the message
                      directly beneath it says the answer is already sealed and
                      waiting — the page contradicting itself one line apart. */}
                  {!summary?.puzzle?.mine ? (
                    <button className="primary" type="submit" disabled={saving || !raw.trim()}>
                      {saving ? 'Sealing…' : 'Seal your answer'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => void load()} disabled={saving}>
                      {saving ? 'Checking…' : 'Check for their answer'}
                    </button>
                  )}
                </form>
              )}

              {!revealed && summary?.puzzle?.mine && (
                <p className="rit-waiting" role="status">
                  Your answer is sealed. It opens when {partnerName} sends theirs.
                  {summary.puzzle.theirPending
                    ? ' Theirs is already in — refreshing will open them.'
                    : ''}
                </p>
              )}

              {!revealed && !summary?.puzzle?.mine && (
                <p className="rit-waiting">
                  Neither of you can see the other&rsquo;s answer until you have both sent one.
                </p>
              )}

              {revealed && (
                <div className="rit-reveal" role="status" aria-live="polite">
                  <div className="rit-answers">
                    <div className="rit-answer-col">
                      <span className="rit-answer-whose">Your answer</span>
                      <span className="rit-answer-value">{revealed.mine ?? '—'}</span>
                    </div>
                    <div className="rit-answer-col">
                      <span className="rit-answer-whose">{partnerName}&rsquo;s answer</span>
                      <span className="rit-answer-value">{revealed.theirs ?? '—'}</span>
                    </div>
                  </div>
                  <p className="rit-verdict">
                    {revealed.error ||
                      (puzzle
                        ? verdict(puzzle, revealed.mine, revealed.theirs)
                        : 'Both answers are open.')}
                  </p>
                  <p className="rit-waiting">
                    {revealed.mine !== null && puzzle && !isCorrect(puzzle, revealed.mine)
                      ? `The answer was ${puzzle.answer}. Tomorrow brings a new one.`
                      : 'A new puzzle arrives with the next UTC day.'}
                  </p>
                </div>
              )}

              {notice && (
                <p className="rit-waiting" role="status">
                  {notice}
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ letters -- */}
      <section className="rit-section" aria-labelledby="rit-letters-heading">
        <h2 id="rit-letters-heading">Letters</h2>

        {!streak || streak.lastDay === null ? (
          <div className="rit-empty">
            <p>No letter has crossed yet. The calendar starts when you write the first one.</p>
            <Link to="/letters/new" className="button primary">
              Write a letter
            </Link>
          </div>
        ) : (
          <>
            <div className="rit-cal" aria-hidden="true">
              {/* No corner cell. An earlier version had one, to hold the grid's
                  first slot so Monday would sit under Monday — but 1 corner +
                  7 weekday labels is 8 items in a 7-column grid, so Sunday was
                  pushed onto a row of its own and the calendar read as having
                  eight columns. The leading blanks in `cells` already do the
                  Monday alignment the corner was meant to do. */}
              {WEEKDAYS.map((d, i) => (
                <span className="rit-cal-head" key={`${d}-${i}`}>
                  {d}
                </span>
              ))}
              {cells.map((cell) => (
                <div className={`rit-cell${cell.day ? '' : ' is-blank'}`} key={cell.day || `blank-${cell.number}`}>
                  {cell.day && <span className="rit-cell-day">{cell.number}</span>}
                  {cell.marked && <span className="rit-cell-mark" />}
                </div>
              ))}
            </div>

            <div className="rit-facts">
              <p className="rit-fact">
                <span className="rit-fact-term">Last 28 days</span>
                <span>
                  {markedCount === 0
                    ? 'No letters crossed.'
                    : `${markedCount} ${markedCount === 1 ? 'day' : 'days'} carried a letter.`}
                </span>
              </p>
              <p className="rit-fact">
                <span className="rit-fact-term">Last letter</span>
                <span>
                  {formatDay(streak.lastDay)}
                  {streak.quietDays === 0
                    ? ' — today'
                    : streak.quietDays === 1
                      ? ' — yesterday'
                      : ` — ${streak.quietDays} days ago`}
                </span>
              </p>
              <p className="rit-fact">
                <span className="rit-fact-term">Longest run</span>
                <span>
                  {streak.longest} {streak.longest === 1 ? 'day' : 'days'} in a row
                  {streak.alive && streak.current === streak.longest ? ', and it is still going' : ''}
                </span>
              </p>
            </div>

            <p className="rit-milestone">{milestone(streak) ?? 'Nothing to celebrate yet, and nothing to apologise for.'}</p>

            <p className="rit-section-note rit-note-after">
              Counted in UTC days, not local ones. Two people in two timezones would otherwise
              disagree about what &ldquo;yesterday&rdquo; means, and the streak would be an
              argument.
            </p>
          </>
        )}
      </section>

      {/* ----------------------------------------------------- together -- */}
      {pairingDay && (
        <section className="rit-section" aria-labelledby="rit-together-heading">
          <h2 id="rit-together-heading">Together</h2>

          <p className="rit-count">
            <span className="rit-count-value">{togetherDays}</span>
            <span className="rit-count-unit">
              days since {anniversary ? 'your date' : 'you paired'}
            </span>
          </p>

          <div className="rit-when">
            <p className="rit-fact">
              <span className="rit-fact-term">Paired</span>
              <span>{formatDay(pairingDay)}</span>
            </p>
            <p className="rit-fact">
              <span className="rit-fact-term">First letter</span>
              <span>
                {firstLetterDay
                  ? `${formatDay(firstLetterDay)}, ${daysSince(firstLetterDay, pairingDay)} ${daysSince(firstLetterDay, pairingDay) === 1 ? 'day' : 'days'} after pairing`
                  : 'Not yet written'}
              </span>
            </p>
          </div>

          <AnniversaryForm
            value={anniversary}
            saving={saving}
            onSave={(v) => void saveAnniversary(v)}
          />

          <p className="rit-section-note rit-note-after">
            {anniversary
              ? 'This date is sealed in your key. The server stores it as ciphertext and cannot read which day it is.'
              : 'Counting from the day you paired, which the server can see. Choose your own date and the count is sealed — the server stores ciphertext and cannot read the day.'}
          </p>
        </section>
      )}
    </div>
  );
}

function AnniversaryForm({
  value,
  saving,
  onSave,
}: {
  value: string;
  saving: boolean;
  onSave: (value: string) => void;
}) {
  // Held locally so a date picker that fires change on every keystroke does not
  // seal and upload a half-finished date.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <form
      className="rit-answer-row"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <Field
        id="rit-anniversary"
        label="Count from a date of your own"
        type="date"
        value={draft}
        onChange={setDraft}
        hint="Sealed before it leaves this device."
      />
      <button type="submit" className="rit-date-button" disabled={saving || draft === value}>
        {saving ? 'Sealing…' : value ? 'Update this date' : 'Count from this date'}
      </button>
    </form>
  );
}

/**
 * Four Monday-aligned weeks ending today.
 *
 * Leading blanks are real blanks — a calendar row that starts mid-week is a
 * lie about the shape of the month.
 */
function buildCells(streak: Streak | null): Cell[] {
  if (!streak || streak.marks.length === 0) return [];
  const first = streak.marks[0];
  const firstMs = Date.parse(`${first.day}T00:00:00.000Z`);
  const lead = (new Date(firstMs).getUTCDay() + 6) % 7;

  const out: Cell[] = [];
  for (let i = 0; i < lead; i++) out.push({ day: '', number: String(i + 1), marked: false });
  for (const mark of streak.marks) {
    const ms = Date.parse(`${mark.day}T00:00:00.000Z`);
    out.push({ day: mark.day, number: cellLabel(ms), marked: mark.marked });
  }
  // Pad the tail so the last week is a whole row.
  while (out.length % 7 !== 0) out.push({ day: '', number: '', marked: false });
  return out;
}