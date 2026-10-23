/**
 * The chess table (plan step 26).
 *
 * The server holds a sealed position, a clock and a pair of user ids. This store
 * holds everything else: the board you are looking at, the move list, whose turn
 * it is, and the offers hanging in the air.
 *
 * Three rules this store follows, each of which is a decision rather than an
 * implementation detail:
 *
 *  1. **A position that cannot be opened is an error, never an empty board.** An
 *     empty board looks identical to "your partner has not moved yet", and a page
 *     that cannot tell those apart will eventually tell somebody the wrong one.
 *  2. **The board is derived from what the server just returned**, not from the
 *     optimistic copy that was sent. After a write, the server's sealed position
 *     is re-opened and re-verified. Optimism is for the delay between the click
 *     and the request; the server's answer is what gets drawn.
 *  3. **Offers are not actions.** A take-back the opponent has not accepted
 *     leaves `position` exactly where it was; the offer is surfaced as a prompt.
 *     Otherwise "offer undo" would be "silently rewind", which is the thing that
 *     makes a two-player board feel untrustworthy.
 */

import { create } from 'zustand';
import { activeKey } from '../lib/vault';
import { useAuth } from './auth';
import { usePairing } from './pairing';
import {
  applyMove,
  describeOutcome,
  gamesApi,
  newLocalGame,
  positionBeforeLastPly,
  openGame,
  sealGame,
  sealPayload,
  stateFromPayload,
  statusFromBoard,
  verifySealedGame,
  type GameSession,
  type GameStatus,
  type GameSummary,
  type SealedGame,
  type SealedMove,
} from '../lib/chessGames';
import { cloneState, type Color, type GameState, type Move } from '../lib/chessEngine';

export interface GamesState {
  session: GameSession | null;
  /** The board to draw. Null until a position has been opened. */
  position: GameState | null;
  moves: SealedMove[];
  /** The position one ply back, kept so a take-back can be offered with it. */
  previous: { position: GameState; moves: SealedMove[] } | null;
  history: GameSummary[];
  loading: boolean;
  sending: boolean;
  error: string;
  notice: string;

  load: () => Promise<void>;
  create: (color?: Color) => Promise<void>;
  play: (move: Move) => Promise<void>;
  resign: () => Promise<void>;
  offerDraw: () => Promise<void>;
  acceptDraw: () => Promise<void>;
  declineDraw: () => Promise<void>;
  offerUndo: () => Promise<void>;
  acceptUndo: () => Promise<void>;
  declineUndo: () => Promise<void>;
  /**
   * Rebuilds `previous` from the sealed move list after a refresh, so a
   * take-back survives the page being reloaded. Cheap (one replay) and honest:
   * it never synthesises a position that has not been sealed both ways.
   */
  recallUndoBase: () => void;
  /** Opens a finished game's final position again, read-only. */
  reopen: (id: number) => Promise<void>;
  reset: () => void;

  /** Sentence for the banner. Derived, so it cannot disagree with the session. */
  outcome: () => string;
}

/**
 * The partner's name, for a sentence that needs a person in it.
 *
 * One definition, used by load() and by acceptUndo(). The second caller used to
 * pass the literal 'your partner', so accepting a take-back announced "your
 * partner to move" while the rest of the app had been saying Margot all along.
 */
function currentPartnerName(): string {
  const partner = usePairing.getState().partner;
  return partner?.friendly_name || partner?.username || 'your partner';
}

/** Who to address the envelope to. Same shape as the rituals store's. */
function sealContext(): { senderId: number; partnerId: number; senderPublicKey: JsonWebKey; partnerPublicKey: JsonWebKey; name: string } {
  const me = useAuth.getState().user;
  const partner = usePairing.getState().partner;
  if (!me?.publicKey || !partner?.publicKey) {
    throw new Error(
      'Your key is not loaded, so the position could not be sealed. Unlock the archive and try again.',
    );
  }
  return {
    senderId: me.id,
    partnerId: partner.id,
    senderPublicKey: JSON.parse(me.publicKey) as JsonWebKey,
    partnerPublicKey: JSON.parse(partner.publicKey) as JsonWebKey,
    name: partner.friendly_name || partner.username,
  };
}

/**
 * Opens a sealed position and refuses to hand back one that does not agree with
 * itself. See `verifySealedGame` for what that guards against.
 */
async function openVerified(envelope: string, viewerId: number): Promise<{ game: SealedGame; state: GameState }> {
  const key = activeKey();
  if (!key) throw new Error('Your archive is locked, so this position cannot be opened yet.');
  const payload = await openGame(envelope, key, viewerId);
  const problem = verifySealedGame(payload);
  if (problem) throw new Error(`${problem} The two ends of this game do not agree on the position.`);
  return { game: payload, state: stateFromPayload(payload) };
}

/** Adopts a session the server has just confirmed. The one place a board is set. */
async function adopt(session: GameSession, viewerId: number, partnerName: string) {
  const { game, state } = await openVerified(session.encryptedState, viewerId);
  return {
    session,
    position: state,
    moves: game.moves,
    previous: null,
    notice: describeOutcome(session, viewerId, partnerName),
    error: '',
  };
}

export const useGames = create<GamesState>((set, get) => ({
  session: null,
  position: null,
  moves: [],
  previous: null,
  history: [],
  loading: false,
  sending: false,
  error: '',
  notice: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await usePairing.getState().refresh();
      const me = useAuth.getState().user;
      if (!me) {
        set({ loading: false, session: null, position: null, moves: [] });
        return;
      }
      const partnerName = currentPartnerName();

      // The board is the active correspondence's board: the pal named here is
      // re-checked against `pairs` server-side.
      const pal = usePairing.getState().activePalId;
      const listing = await gamesApi
        .list(pal)
        .catch(() => ({ games: [] as GameSummary[], activeId: null }));
      const live = await gamesApi.active(pal);

      if (!live.game) {
        set({ history: listing.games, session: null, position: null, moves: [], previous: null, loading: false, notice: '' });
        return;
      }

      const adopted = await adopt(live.game, me.id, partnerName);
      set({ ...adopted, history: listing.games, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : 'The board could not be opened.',
      });
    }
  },

  create: async (color = 'w') => {
    set({ sending: true, error: '', notice: '' });
    try {
      const ctx = sealContext();
      const me = useAuth.getState().user!;
      const state = newLocalGame();
      const payload = sealPayload(state, []);
      const encrypted = await sealGame(payload, ctx);

      const { game } = await gamesApi.create({ color, encryptedState: encrypted }, usePairing.getState().activePalId);
      const adopted = await adopt(game, me.id, ctx.name);
      set({ ...adopted, sending: false, history: get().history });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'The game could not be started.' });
    }
  },

  play: async (move) => {
    const { session, position, moves, sending } = get();
    if (sending) return;
    if (!session || !position) {
      set({ error: 'There is no game to play.' });
      return;
    }
    if (session.turn !== session.youAre) {
      set({ error: session.turn === 'w' ? 'White is to move.' : 'Black is to move.' });
      return;
    }
    if (session.status !== 'open') {
      set({ error: 'This game is over.' });
      return;
    }

    // Build the position that WILL exist after this move, locally, before
    // anything is sent. It is the only way the sealed state can be consistent
    // with the sealed move list.
    const next = applyMove(position, move, moves);
    const status: GameStatus = statusFromBoard(next.state);

    set({ sending: true, error: '' });
    try {
      const ctx = sealContext();
      const me = useAuth.getState().user!;
      const payload = sealPayload(next.state, [...moves, next.record]);
      const encrypted = await sealGame(payload, ctx);

      const { game } = await gamesApi.move(session.id, {
        color: session.youAre as Color,
        version: session.version,
        encryptedState: encrypted,
        status,
      });

      // Trust the server's answer over what we hoped it would be.
      const adopted = await adopt(game, me.id, ctx.name);
      set({
        ...adopted,
        previous: { position: cloneState(position), moves },
        sending: false,
      });
    } catch (e) {
      // The board is deliberately NOT advanced on failure: a move that was not
      // accepted by the server has not happened, and drawing it would leave the
      // page disagreeing with the record.
      set({ sending: false, error: e instanceof Error ? e.message : 'The move was not accepted.' });
    }
  },

  resign: async () => {
    const { session } = get();
    if (!session) return;
    set({ sending: true, error: '' });
    try {
      const { game } = await gamesApi.resign(session.id);
      set({ session: game, sending: false, notice: describeOutcome(game, useAuth.getState().user!.id) });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'You could not resign.' });
    }
  },

  offerDraw: async () => {
    const { session } = get();
    if (!session) return;
    set({ sending: true, error: '' });
    try {
      const { game } = await gamesApi.offerDraw(session.id);
      set({ session: game, sending: false, notice: 'Draw offered. It stands until they answer.' });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'The offer was not accepted.' });
    }
  },

  acceptDraw: async () => {
    const { session } = get();
    if (!session) return;
    set({ sending: true, error: '' });
    try {
      const { game } = await gamesApi.acceptDraw(session.id);
      set({ session: game, sending: false, notice: describeOutcome(game, useAuth.getState().user!.id) });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'The draw was not accepted.' });
    }
  },

  declineDraw: async () => {
    const { session } = get();
    if (!session) return;
    set({ sending: true, error: '' });
    try {
      const { game } = await gamesApi.declineDraw(session.id);
      set({ session: game, sending: false, notice: 'Draw declined. The game goes on.' });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'The offer was not declined.' });
    }
  },

  offerUndo: async () => {
    const { session, previous } = get();
    if (!session || !previous) {
      set({ error: 'There is no move of yours to take back.' });
      return;
    }
    set({ sending: true, error: '' });
    try {
      const ctx = sealContext();
      const encrypted = await sealGame(sealPayload(previous.position, previous.moves), ctx);
      const { game } = await gamesApi.offerUndo(session.id, { version: session.version, encryptedState: encrypted });
      // The board does not move. `previous` is kept, so declining costs nothing.
      set({ session: game, sending: false, notice: 'Take-back offered. It happens only if they accept.' });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'The take-back was not offered.' });
    }
  },

  acceptUndo: async () => {
    const { session } = get();
    if (!session) return;
    set({ sending: true, error: '' });
    try {
      const me = useAuth.getState().user!;
      const { game } = await gamesApi.acceptUndo(session.id, session.version);
      // The board comes from the server's rewound position, not from popping the
      // local list: if the two disagree, the server's sealed state is the record.
      const adopted = await adopt(game, me.id, currentPartnerName());
      set({ ...adopted, sending: false });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'The take-back was not accepted.' });
    }
  },

  declineUndo: async () => {
    const { session } = get();
    if (!session) return;
    set({ sending: true, error: '' });
    try {
      const { game } = await gamesApi.declineUndo(session.id);
      set({ session: game, sending: false, notice: 'Take-back declined. The move stands.' });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : 'The offer was not declined.' });
    }
  },

  recallUndoBase: () => {
    const { session, moves, previous } = get();
    if (!session || previous || session.status !== 'open') return;
    const me = useAuth.getState().user;
    if (!me || session.lastMoveBy !== me.id) return;
    try {
      set({ previous: positionBeforeLastPly(moves) });
    } catch {
      // A list that failed verification never reaches this store, so this is
      // paranoia. Leave `previous` null: the offer simply is not drawn, rather
      // than drawn and refused.
    }
  },

  reopen: async (id) => {
    set({ loading: true, error: '', notice: '' });
    try {
      const me = useAuth.getState().user;
      if (!me) throw new Error('You are not signed in.');
      const { game } = await gamesApi.get(id);
      if (game.status === 'open') throw new Error('That game is still being played.');
      const name = currentPartnerName();
      const adopted = await adopt(game, me.id, name);
      set({
        ...adopted,
        previous: null,
        loading: false,
        notice: describeOutcome(game, me.id, name) + ' Reading it back does not change it.',
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'That game could not be reopened.' });
    }
  },

  reset: () =>
    set({
      session: null,
      position: null,
      moves: [],
      previous: null,
      history: [],
      loading: false,
      sending: false,
      error: '',
      notice: '',
    }),

  outcome: () => {
    const { session } = get();
    if (!session) return '';
    const partner = usePairing.getState().partner;
    return describeOutcome(session, useAuth.getState().user?.id ?? 0, partner?.friendly_name || partner?.username);
  },
}));