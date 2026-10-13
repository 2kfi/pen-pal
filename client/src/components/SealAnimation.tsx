/**
 * The seal & send moment — the one orchestrated animation in PenPal.
 *
 * docs/DESIGN.md §6 budgets it at 700ms and describes exactly three beats:
 * the envelope folds, the wax presses down, the letter travels off the right
 * edge. This file owns those three beats and nothing else. There is no
 * entrance animation on mount, no loop, and no scroll trigger: the moment only
 * exists because the user pressed "Seal and send".
 *
 * Three rules from §6 that shaped the implementation:
 *
 * 1. `prefers-reduced-motion: reduce` collapses motion to a 1-frame state
 *    change — *absent*, not shortened. tokens.css already collapses every CSS
 *    transition for those users; GSAP writes inline transforms and is invisible
 *    to that rule, so the same query is checked here in JS and the moment is
 *    skipped outright. Both checks live: the caller never sets `moment`, so the
 *    stage is never in the DOM — and this effect settles immediately if it is
 *    somehow reached anyway.
 *
 * 2. The motion is decorative. The stage is `aria-hidden`, holds no focusable
 *    content, and is `pointer-events: none`, so it can neither steal focus nor
 *    swallow a click meant for the button underneath it.
 *
 * 3. The animation gates the send rather than decorating it: `onSettled` fires
 *    when the letter is gone (or has come back), and the caller decides what
 *    that means.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

/** 'departing' — folds, seals, leaves. 'returning' — a failed send, undone. */
export type SealMoment = 'departing' | 'returning';

/** docs/DESIGN.md §6: 700ms, end to end. */
const FOLD_MS = 240;
const PRESS_MS = 160;
const SEND_MS = 700 - (FOLD_MS + PRESS_MS - 20);

/** The failing-send undo. Deliberately quicker than the departure. */
const RECALL_MS = 340;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Mirrors the media query tokens.css collapses durations against. Read as a
 * hook rather than once per send so that flipping the OS setting mid-session
 * takes effect without a reload.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    setReduced(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

interface SealAnimationProps {
  /** Which beat to play. `null` keeps the stage out of the DOM entirely. */
  moment: SealMoment | null;
  /**
   * The submit button. The envelope is placed against it so the letter reads as
   * leaving *from* the action rather than materialising somewhere on screen.
   */
  originRef: RefObject<HTMLElement>;
  /** Fired when the moment is over: the letter is gone, or it is back. */
  onSettled: () => void;
}

export default function SealAnimation({ moment, originRef, onSettled }: SealAnimationProps) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  // Kept in a ref so a new callback identity each render never re-runs the
  // timeline — the moment is a one-shot, not a reaction to props.
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });

  useGSAP(
    (_context, contextSafe) => {
      if (!moment || !root.current) return;
      // useGSAP always hands this down; the type marks it optional. Without it
      // the completion callback would fire after the context is reverted, i.e.
      // after this screen is gone.
      const done = (contextSafe ?? ((fn: () => void) => fn))(() => settled.current());

      // Reduced motion means no moment. Resolve now; the caller's next step
      // happens on the very next frame with nothing drawn in between.
      if (reduced) {
        done();
        return;
      }

      const [envelope, flap, wax, route] = gsap.utils.toArray<HTMLElement>(
        ['.seal-envelope', '.seal-flap', '.seal-wax', '.seal-route'],
        root.current,
      );

      // Measure before touching anything: the envelope is still at its CSS
      // origin here, so its box is the untransformed one.
      const box = envelope.getBoundingClientRect();
      const origin = originRef.current?.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const offscreen = vw + box.width;

      // The letter leaves from the button's trailing edge, never from on top of
      // it — the button keeps saying "Sealing…" for the whole moment, and a
      // letter that hides the control which sent it is a worse story anyway.
      // On a phone the row is narrow and there is no room beside the button, so
      // the letter drops below it and travels right across the empty page
      // instead. Both are anchored to the action; neither covers it.
      const fitsBeside = !!origin && origin.right + box.width <= vw;
      const startX = origin
        ? fitsBeside
          ? origin.right
          : Math.min(origin.left, vw - box.width)
        : 0;
      const startY = origin
        ? fitsBeside
          ? origin.top + origin.height / 2 - box.height / 2
          : origin.bottom
        : vh / 2 - box.height / 2;

      const tl = gsap.timeline({ onComplete: done });

      if (moment === 'departing') {
        gsap.set(envelope, { x: startX, y: startY });
        gsap.set(route, {
          x: startX + box.width,
          y: startY + box.height / 2,
          width: Math.max(0, vw - startX - box.width),
        });

        // 1. The flap comes down. Snappy in, because paper has no weight.
        tl.fromTo(
          flap,
          { rotateX: 0 },
          { rotateX: 180, duration: FOLD_MS / 1000, ease: 'power2.in' },
        )
          // 2. The wax presses. Slightly over-scaled on arrival so it lands and
          //    settles like something soft being pushed, not a cross-fade.
          .fromTo(
            wax,
            { scale: 1.45, yPercent: -55, opacity: 0 },
            {
              scale: 1,
              yPercent: 0,
              opacity: 1,
              duration: PRESS_MS / 1000,
              ease: 'back.out(2.6)',
            },
            (FOLD_MS - 20) / 1000,
          )
          // 3. And away. Accelerating, so it leaves rather than slides, with
          //    just enough lift on the leading edge that it reads as a thing
          //    being tossed rather than a box being translated.
          .to(
            envelope,
            { x: offscreen, rotation: -3, duration: SEND_MS / 1000, ease: 'power2.in' },
            (FOLD_MS + PRESS_MS - 20) / 1000,
          )
          // The route is consumed by the letter that is running along it.
          .to(route, { autoAlpha: 0, duration: 0.16 }, (FOLD_MS + PRESS_MS - 20) / 1000);
      } else {
        // The letter never arrived. Put it back exactly where it started and
        // undo the seal, so the screen matches the truth: still unsent.
        gsap.set(route, { autoAlpha: 0 });
        gsap.set(envelope, { x: offscreen, y: startY });
        gsap.set(wax, { scale: 1, yPercent: 0, opacity: 1 });
        gsap.set(flap, { rotateX: 180 });

        tl.fromTo(
          envelope,
          { opacity: 0.9 },
          { opacity: 1, duration: RECALL_MS / 1000, ease: 'power2.out' },
        )
          .fromTo(
            envelope,
            { x: offscreen },
            { x: startX, duration: RECALL_MS / 1000, ease: 'power2.out' },
            0,
          )
          // The wax lifts off before the flap opens — the other order reads as
          // the seal melting.
          .to(wax, { scale: 1.25, opacity: 0, duration: 0.14, ease: 'power2.in' }, 0.06)
          .to(flap, { rotateX: 0, duration: 0.24, ease: 'power2.out' }, 0.16);
      }
    },
    { dependencies: [moment, reduced], scope: root, revertOnUpdate: true },
  );

  if (!moment) return null;

  return (
    /* Decorative, so it is not in the accessibility tree at all — the state it
       conveys ("your letter is on its way") is carried by the submit button. */
    <div className="seal-stage" ref={root} aria-hidden="true">
      <div className="seal-lane">
        <span className="seal-route" />
        <div className="seal-envelope">
          <span className="seal-paper" />
          <span className="seal-flap" />
          <span className="seal-wax" />
        </div>
      </div>
    </div>
  );
}