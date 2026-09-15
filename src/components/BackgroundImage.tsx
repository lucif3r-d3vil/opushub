// The photo background, with a graceful failure mode.
//
// A background is decoration: if the image cannot be loaded (host down, file removed, link
// that is not really an image), the layer simply drops out and the base background + scrim
// remain. The Hub must never break — or show a broken-image icon — because a background URL
// stopped working.
//
// Detection uses a visually hidden <img> of the same URL: browsers fire `error` on it
// exactly when the picture cannot be decoded, which is precisely the moment the CSS
// background gives up too. The probe uses strict-origin-when-cross-origin (the browser
// default) rather than no-referrer, because some CDNs (including images.unsplash.com)
// may refuse or mishandle no-referrer requests, which would incorrectly mark a valid
// image as broken and make the Hub background disappear even though the CSS background
// would have loaded. The image is not display:none (some browsers skip loading those)
// but visually hidden with absolute 1x1 and opacity 0 so it still loads for error detection.
//
// The CSS url() escaping handles backslashes, quotes, and newlines. A quoted url("…")
// may contain ), &, ?, =, etc. without escaping — only " and \ and line breaks need
// escaping per CSS Syntax.
import { useEffect, useState } from 'react';

const cssUrl = (u: string) =>
  `url("${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ')}")`;

export function BackgroundImage({ url, position = 'center', fit = 'cover' }: {
  url: string; position?: 'center' | 'top' | 'bottom' | 'left' | 'right'; fit?: 'cover' | 'contain';
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [url]);

  if (broken || !url) return null;

  return (
    <div
      className="bg-img"
      style={{ backgroundImage: cssUrl(url), backgroundPosition: position, backgroundSize: fit, backgroundRepeat: 'no-repeat' }}
      aria-hidden="true"
    >
      <img
        src={url}
        alt=""
        aria-hidden="true"
        // Visually hidden but still loads: display:none would cause some browsers to skip.
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
        }}
        referrerPolicy="strict-origin-when-cross-origin"
        onError={() => setBroken(true)}
        onLoad={() => setBroken(false)}
      />
    </div>
  );
}
