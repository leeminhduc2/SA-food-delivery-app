import { Utensils } from 'lucide-react';
import { useEffect, useState, type ImgHTMLAttributes } from 'react';

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src?: string;
};

/**
 * Raster image with an honest missing-asset state.
 *
 * The demo catalog points at local WebP food photography. If a file is absent,
 * show a labelled neutral placeholder: never a stock photo, SVG, emoji or
 * gradient pretending to be the dish.
 */
export function SmartImage({ src, alt = '', ...props }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed)
    return (
      <span className="image-placeholder" role="img" aria-label={alt || 'Ảnh đang cập nhật'}>
        <Utensils size={22} aria-hidden="true" />
        <span>Ảnh đang cập nhật</span>
      </span>
    );
  return (
    <img
      {...props}
      src={src}
      alt={alt}
      onError={(event) => {
        setFailed(true);
        props.onError?.(event);
      }}
    />
  );
}
