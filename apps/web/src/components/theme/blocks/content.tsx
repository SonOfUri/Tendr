// Content blocks: heading, rich text, image, banner, video, divider, spacer.
import type { ShopperTheme, ThemeLeafBlock } from '@tendr/contracts';
import type { ReactNode } from 'react';
import { backgroundImage, imageUrl } from './assets';

type Of<T extends ThemeLeafBlock['type']> = Extract<ThemeLeafBlock, { type: T }>;

export function heading(block: Of<'heading'>): ReactNode {
  const Tag = block.level === 2 ? 'h2' : 'h3';
  return <Tag className="tdr-heading">{block.text}</Tag>;
}

/** The API's sanitised HTML for the block; the raw markdown is never rendered. */
export function richText(block: Of<'rich_text'>, theme: ShopperTheme): ReactNode {
  const html = theme.rendered[block.id];
  if (!html) return null;
  return <div className="tdr-rich-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function image(block: Of<'image'>, theme: ShopperTheme): ReactNode {
  const src = imageUrl(theme, block.asset_id);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element -- assets come from Tendr's asset origin
  const img = <img className="tdr-image" src={src} alt={block.alt} loading="lazy" />;
  return block.link_url ? (
    <a href={block.link_url} target="_blank" rel="noopener noreferrer">
      {img}
    </a>
  ) : (
    img
  );
}

export function banner(block: Of<'banner'>, theme: ShopperTheme): ReactNode {
  const bgImage = backgroundImage(theme, block.asset_id);
  if (!block.text && !bgImage && !block.background) return null;
  return (
    <div
      className="tdr-banner"
      data-image={bgImage ? '' : undefined}
      style={{ backgroundColor: block.background, backgroundImage: bgImage }}
    >
      {block.text ? <p className="tdr-banner-text">{block.text}</p> : null}
    </div>
  );
}

export function video(block: Of<'video'>): ReactNode {
  const src =
    block.provider === 'youtube'
      ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(block.video_id)}`
      : `https://player.vimeo.com/video/${encodeURIComponent(block.video_id)}?dnt=1`;
  return (
    <div className="tdr-video">
      <iframe
        src={src}
        title={block.provider === 'youtube' ? 'YouTube video' : 'Vimeo video'}
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="fullscreen; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    </div>
  );
}

export function divider(): ReactNode {
  return <hr className="tdr-divider" />;
}

export function spacer(block: Of<'spacer'>): ReactNode {
  return <div className="tdr-spacer" data-size={block.size} aria-hidden="true" />;
}
