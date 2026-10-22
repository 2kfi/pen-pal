import { useEffect, useState } from 'react';

/**
 * Monogram avatar.
 *
 * DESIGN-UPDATED.md §3 puts a 38-42px circular avatar on every contact row, §6
 * one on the profile header. The schema has accounts for real avatars, but the
 * product's UI ships none: nothing uploads, nothing fetches one, and a
 * remote-image dependency in an E2E-encrypted letter app needs a decision of
 * its own. Until that decision exists, the monogram is what each row shows:
 * one initial cut from the display name, drawn as SVG so it theme-shares and
 * needs no network and no artist.
 *
 * @param name - the correspondence's display name, or the account's own
 * @param size - px diameter; `38` matches the reference contact row, `28` the
 *   48px header (a 38px avatar would leave no breathing room at that height)
 */
export default function Avatar({ name, size = 38 }: { name: string; size?: number }) {
  // The first grapheme cluster, not the first code unit: a name starting with
  // an astral character must not render its half of a broken surrogate.
  const [initial, setInitial] = useState(() => firstChar(name));
  useEffect(() => {
    setInitial(firstChar(name));
  }, [name]);

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      <svg className="avatar-inner" width={size} height={size} viewBox="0 0 40 40" focusable="false">
        <circle cx="20" cy="20" r="19.5" className="avatar-disc" />
        <text x="20" y="20" textAnchor="middle" dominantBaseline="central" className="avatar-letter">
          {initial}
        </text>
      </svg>
    </span>
  );
}

function firstChar(name: string): string {
  if (!name) return '?';
  const [char] = Array.from(name.trim());
  return (char || '?').toUpperCase();
}
