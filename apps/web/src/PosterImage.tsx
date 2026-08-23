import { useEffect, useState } from "react";

type Props = {
  src: string | null;
  title: string;
};

export function PosterImage({ src, title }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setUrl(null);
      return;
    }
    // Affiche TMDB (absolue) : fetch credentials:"include" est refuse par le
    // CORS de image.tmdb.org. On la laisse au navigateur telle quelle.
    if (/^https?:\/\//i.test(src)) {
      setUrl(src);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetch(src, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("poster");
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  return (
    <div
      className="poster-art"
      style={url ? { backgroundImage: `url(${url})` } : undefined}
    >
      {!url && <span>{title.slice(0, 1)}</span>}
      <div className="poster-shade" />
    </div>
  );
}
