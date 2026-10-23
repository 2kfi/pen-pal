import { create } from 'zustand';
import { api } from '../lib/api';
import { DecryptionError, openLetter, sealLetter, isEnvelope } from '../lib/crypto';
import { activeKey } from '../lib/vault';
import { useAuth } from '../stores/auth';
import { usePairing } from '../stores/pairing';
import { computeStreak, puzzleFor, type Puzzle, type Streak } from '../lib/dailyPuzzle';

/** The ritual you are doing is the one for the pal you have selected. */
function activePalParam(): number | null {
  return usePairing.getState().activePalId;
}

/**
 * Rituals (plan step 27).
 *
 * The server holds ciphertext and two things it already owned: which UTC days a
 * letter crossed, and when you paired. Everything else — the puzzle, the answer,
 * the streak, the anniversary — is computed here, in this browser, and the parts
 * we want to keep are written back sealed.
 *
 * Decryption failures are surfaced and never swallowed. A ritual that silently
 * showed nothing would look identical to "your partner has not answered yet",
 * which is the one thing this page must never get wrong.
 */

export interface RitualPartner {
  id: number;
  username: string;
  friendly_name?: string | null;
}

interface Submission {
  encryptedAnswer: string;
  submittedAt: string;
}

interface SummaryResponse {
  paired: boolean;
  today: string;
  day?: string;
  pairKey?: string;
  partner?: RitualPartner | null;
  letters?: { days: string[]; pairedAt: string; firstLetterAt: string | null };
  puzzle?: {
    day: string;
    revealed: boolean;
    mine: Submission | null;
    theirs: Submission | null;
    theirPending?: boolean;
  };
  ledger?: { encryptedState: string; updatedAt: string } | null;
}

/** What the client seals about itself. The server reads none of this. */
export interface RitualLedger {
  v: 1;
  current: number;
  longest: number;
  /** The day the pair chose to count from. Null means "count from the pairing". */
  anniversary: string | null;
  /** True once the seal for this ledger has actually been written back. */
  written: boolean;
}

interface RitualsState {
  summary: SummaryResponse | null;
  puzzle: Puzzle | null;
  streak: Streak | null;
  /** Plaintext answers, once the server has released both envelopes. */
  revealed: { mine: string | null; theirs: string | null; error: string } | null;
  ledger: RitualLedger | null;
  anniversary: string;
  loading: boolean;
  saving: boolean;
  error: string;
  notice: string;
  load: (day?: string) => Promise<void>;
  submitAnswer: (raw: string) => Promise<void>;
  saveAnniversary: (day: string) => Promise<void>;
  reset: () => void;
}

const EMPTY: Streak = {
  current: 0,
  longest: 0,
  lastDay: null,
  alive: false,
  quietDays: -1,
  marks: [],
};

/** Which of us is the sender for this envelope — needed to address it. */
function sealContext() {
  const me = useAuth.getState().user;
  const partner = usePairing.getState().partner;
  if (!me?.publicKey || !partner?.publicKey) {
    throw new Error(
      'Your key is not loaded, so the ritual could not be sealed. Unlock the archive and try again.',
    );
  }
  return {
    senderId: me.id,
    recipientId: partner.id,
    senderPublicKey: JSON.parse(me.publicKey) as JsonWebKey,
    recipientPublicKey: JSON.parse(partner.publicKey) as JsonWebKey,
    name: partner.friendly_name || partner.username,
  };
}

async function openWithKey(envelope: unknown): Promise<string> {
  const parsed: unknown = typeof envelope === 'string' ? safeParse(envelope) : envelope;
  const key = activeKey();
  const me = useAuth.getState().user;
  if (!isEnvelope(parsed) || !key || !me) throw new DecryptionError();
  return openLetter(parsed, key, me.id);
}

/**
 * Opens a sealed ledger, or null.
 *
 * This awaits on purpose. An earlier version fired the open and forgot about it,
 * so the anniversary landed a frame or two after the page had already rendered a
 * count from the pairing date — a number that visibly changes under the reader
 * with no action of theirs, which reads as a bug in the count rather than a
 * ledger arriving. A ledger we cannot open is simply not used; that is never a
 * blocking error, because the fallback (the day you paired) is always right.
 */
async function readLedger(raw: string | null | undefined): Promise<RitualLedger | null> {
  if (!raw) return null;
  try {
    const value = JSON.parse(await openWithKey(raw)) as RitualLedger;
    if (!value || value.v !== 1) return null;
    return { ...value, anniversary: value.anniversary ?? null };
  } catch {
    return null;
  }
}

export const useRituals = create<RitualsState>((set, get) => ({
  summary: null,
  puzzle: null,
  streak: null,
  revealed: null,
  ledger: null,
  anniversary: '',
  loading: false,
  saving: false,
  error: '',
  notice: '',

  load: async (day) => {
    set({ loading: true, error: '' });
    try {
      await usePairing.getState().refresh();
      // Rituals are per correspondence. The pal named here is re-derived
      // against `pairs` server-side; omitting it falls back to the newest pal.
      const pal = activePalParam();
      const params = new URLSearchParams();
      if (day) params.set('day', day);
      if (pal !== null) params.set('pal', String(pal));
      const query = params.size ? `?${params}` : '';
      const summary = await api<SummaryResponse>(`/api/rituals${query}`);
      const activeDay = summary.day ?? summary.today;

      const streak = summary.letters
        ? computeStreak(summary.letters.days, summary.today)
        : EMPTY;

      const puzzle = summary.pairKey ? puzzleFor(summary.pairKey, activeDay) : null;

      let revealed: RitualsState['revealed'] = null;
      if (summary.puzzle?.revealed) {
        const mine = await openWithKey(summary.puzzle.mine?.encryptedAnswer ?? '').catch(() => null);
        const theirs = await openWithKey(summary.puzzle.theirs?.encryptedAnswer ?? '').catch(() => null);
        const error =
          mine === null && theirs === null
            ? 'Neither answer could be opened. They may belong to a different pairing.'
            : mine === null
              ? 'Your answer could not be opened. It may belong to a different pairing.'
              : theirs === null
                ? "Your partner's answer could not be opened. It may belong to a different pairing."
                : '';
        revealed = { mine, theirs, error };
      }

      const ledger = await readLedger(summary.ledger?.encryptedState);

      set({
        summary,
        puzzle,
        streak,
        revealed,
        ledger,
        anniversary: ledger?.anniversary ?? '',
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not open the rituals.' });
    }
  },

  submitAnswer: async (raw) => {
    const { summary, puzzle } = get();
    if (!summary?.pairKey || !puzzle) {
      set({ error: 'There is no puzzle open right now.' });
      return;
    }
    set({ saving: true, error: '', notice: '' });
    try {
      const ctx = sealContext();
      const envelope = await sealLetter(raw, { ...ctx, sentAt: new Date().toISOString() });
      const res = await api<{
        revealed: boolean;
        mine: Submission | null;
        theirs: Submission | null;
        theirPending: boolean;
      }>('/api/rituals/puzzle', {
        method: 'POST',
        body: JSON.stringify({ day: puzzle.day, encryptedAnswer: JSON.stringify(envelope), pal: activePalParam() }),
      });

      let revealed: RitualsState['revealed'] = null;
      let notice = '';
      if (res.revealed) {
        const theirs = await openWithKey(res.theirs?.encryptedAnswer ?? '').catch(() => null);
        revealed = {
          mine: raw,
          theirs,
          error:
            theirs === null
              ? "Your partner's answer could not be opened. It may belong to a different pairing."
              : '',
        };
      } else {
        notice = `${ctx.name} has not answered yet. Yours stays sealed until they do.`;
      }

      // The day's summary now describes the world one submission later. Without
      // this the form stays blank and the "yours is sealed, waiting on them"
      // line never appears, so a successful send looks exactly like a no-op
      // until the page is reloaded.
      const before = get().summary;
      const sealed: Submission = { encryptedAnswer: JSON.stringify(envelope), submittedAt: envelope.sentAt };
      const summary =
        before?.puzzle?.day === puzzle.day
          ? {
              ...before,
              puzzle: {
                ...before.puzzle,
                mine: sealed,
                revealed: res.revealed,
                theirs: res.revealed ? res.theirs : before.puzzle.theirs,
                theirPending: res.revealed ? false : res.theirPending,
              },
            }
          : before;

      set({ summary, revealed, notice, saving: false });
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : 'The answer could not be sealed.' });
    }
  },

  saveAnniversary: async (day) => {
    const { streak } = get();
    set({ saving: true, error: '' });
    try {
      const ctx = sealContext();
      const ledger: RitualLedger = {
        v: 1,
        current: streak?.current ?? 0,
        longest: streak?.longest ?? 0,
        anniversary: day || null,
        written: true,
      };
      const envelope = await sealLetter(JSON.stringify(ledger), {
        ...ctx,
        sentAt: new Date().toISOString(),
      });
      await api('/api/rituals/ledger', {
        method: 'PUT',
        body: JSON.stringify({ encryptedState: JSON.stringify(envelope), pal: activePalParam() }),
      });
      set({ ledger, anniversary: day, saving: false, notice: 'Saved. Only you and your partner can read it.' });
    } catch (e) {
      set({
        saving: false,
        error: e instanceof Error ? e.message : 'The date could not be sealed, so it was not saved.',
      });
    }
  },

  reset: () =>
    set({
      summary: null,
      puzzle: null,
      streak: null,
      revealed: null,
      ledger: null,
      anniversary: '',
      loading: false,
      saving: false,
      error: '',
      notice: '',
    }),
}));

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Days since a UTC day, for the anniversary counter. Never negative. */
export function daysSince(day: string, todayStr: string): number {
  const a = Date.parse(`${day}T00:00:00.000Z`);
  const b = Date.parse(`${todayStr}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}