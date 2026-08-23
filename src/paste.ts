import { Transform } from 'node:stream';

/**
 * Bracketed paste.
 *
 * By default a terminal sends pasted text as if it were typed, so every
 * newline inside the paste reaches readline as a completed line and submits
 * immediately. With bracketed paste enabled the terminal wraps the pasted
 * block in markers, which lets us tell "the user pressed Enter" apart from
 * "there was a newline in the middle of a paste".
 */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Length of the longest suffix of `text` that could be the start of `marker`.
 * A marker can be split across two reads, so that many bytes are held back
 * until the next chunk arrives rather than being emitted and misread.
 */
function partialMarkerLength(text: string, marker: string): number {
  const max = Math.min(marker.length - 1, text.length);
  for (let length = max; length > 0; length--) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/** Newlines inside a paste must not reach readline, or it submits the line. */
function flatten(pasted: string): string {
  return pasted.replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Filters stdin so newlines inside a bracketed paste become spaces, and the
 * markers themselves never reach readline. Text typed normally is untouched,
 * so Enter still submits.
 */
export function createPasteFilter(): Transform {
  let inPaste = false;
  let held = '';

  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      let data = held + chunk.toString('utf8');
      held = '';
      let out = '';

      for (;;) {
        if (inPaste) {
          const end = data.indexOf(PASTE_END);
          if (end === -1) {
            const keep = partialMarkerLength(data, PASTE_END);
            out += flatten(data.slice(0, data.length - keep));
            held = data.slice(data.length - keep);
            break;
          }
          out += flatten(data.slice(0, end));
          data = data.slice(end + PASTE_END.length);
          inPaste = false;
        } else {
          const start = data.indexOf(PASTE_START);
          if (start === -1) {
            const keep = partialMarkerLength(data, PASTE_START);
            out += data.slice(0, data.length - keep);
            held = data.slice(data.length - keep);
            break;
          }
          out += data.slice(0, start);
          data = data.slice(start + PASTE_START.length);
          inPaste = true;
        }
      }

      callback(null, out);
    },

    flush(callback): void {
      // Whatever is left was never a complete marker; pass it through.
      callback(null, inPaste ? flatten(held) : held);
    },
  });
}
