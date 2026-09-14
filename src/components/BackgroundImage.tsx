// The photo background, with a graceful failure mode.
//
// A background is decoration: if the image cannot be loaded (host down, file removed, link
// that is not really an image), the layer simply drops out and the base background + scrim
// remain. The Hub must never break — or show a broken-image icon — because a background URL
// stopped working.
//
// Detection is a hidden <img> of the same URL: browsers fire `error` on it exactly when the
// picture cannot be decoded, which is precisely the moment the CSS background gives up too.
import { useEffect, useState } from 'react';

const cssUrl = (u: string) => `url("${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;

export function BackgroundImage({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [url]);
  if (broken || !url) return null;
  return (
    <div className="bg-img" style={{ backgroundImage: cssUrl(url) }}>
      <img
        src={url}
        alt=""
        aria-hidden="true"
        style={{ display: 'none' }}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    </div>
  );
}
