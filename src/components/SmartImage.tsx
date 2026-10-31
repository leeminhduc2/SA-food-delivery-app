import { useEffect, useState, type ImgHTMLAttributes } from 'react';

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src?: string;
  fallback?: string;
};

/**
 * Image with a local fallback. Imported demo data points at local SVG
 * illustrations, but a missing deployment asset must not leave a broken image.
 */
export function SmartImage({
  src,
  fallback = '/images/vietnamese.svg',
  alt = '',
  ...props
}: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <img
      {...props}
      src={failed || !src ? fallback : src}
      alt={alt}
      onError={(event) => {
        setFailed(true);
        props.onError?.(event);
      }}
    />
  );
}
