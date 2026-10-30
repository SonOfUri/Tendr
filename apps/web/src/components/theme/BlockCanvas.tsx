'use client';

// The checkout canvas: the theme's blocks in order. Each merchant block is drawn as
//   <div class="tdr-wrap" data-type><div class="tdr-scope"><div class="tdr-content" data-block>
// Merchant CSS is scoped to `.tdr-scope …` by the API, and `.tdr-wrap` (owned by Tendr's CSS)
// contains layout and paint, so nothing a block draws escapes its box. The sealed payment block
// is a sibling `<section class="tdr-payment" data-sealed>`, outside every `.tdr-scope`: no
// merchant selector can match it or anything in it.
import type { ShopperTheme, ThemeBlock, ThemeLeafBlock } from '@tendr/contracts';
import type { ReactNode } from 'react';
import { header, footerLinks, socialLinks } from './blocks/brand';
import { banner, divider, heading, image, richText, spacer, video } from './blocks/content';
import { customHtml } from './blocks/custom-html';
import { columns, section } from './blocks/layout';
import { orderSummary } from './blocks/order-summary';
import { Countdown, deliveryNote, faq, reviews, trustBadges } from './blocks/selling';

export type BlockCanvasSlots = {
  /** The sealed payment block: amount, payee, token choice, Pay button, address, timers… */
  payment: ReactNode;
  /** Line items, or a payment link's title and description. The block hides without it. */
  orderSummary?: ReactNode;
  /** The success canvas's thank-you message. */
  thankYou?: ReactNode;
  /** The success canvas's "Back to store" link. */
  backToStore?: ReactNode;
};

type Props = {
  blocks: readonly ThemeBlock[];
  theme: ShopperTheme;
  slots: BlockCanvasSlots;
};

/** What a merchant block draws, or null to leave it out (unknown type, no content). */
function content(
  block: ThemeBlock,
  theme: ShopperTheme,
  slots: BlockCanvasSlots,
  renderLeaf: (b: ThemeLeafBlock) => ReactNode,
): ReactNode {
  switch (block.type) {
    case 'header':
      return header(block, theme);
    case 'heading':
      return heading(block);
    case 'rich_text':
      return richText(block, theme);
    case 'image':
      return image(block, theme);
    case 'banner':
      return banner(block, theme);
    case 'video':
      return video(block);
    case 'divider':
      return divider();
    case 'spacer':
      return spacer(block);
    case 'order_summary':
      return orderSummary(slots.orderSummary);
    case 'trust_badges':
      return trustBadges(block, theme);
    case 'reviews':
      return reviews(block);
    case 'faq':
      return faq(block);
    case 'countdown':
      return <Countdown block={block} />;
    case 'delivery_note':
      return deliveryNote(block);
    case 'social_links':
      return socialLinks(block);
    case 'footer_links':
      return footerLinks(block);
    case 'custom_html':
      return customHtml(block);
    case 'columns':
      return columns(block, renderLeaf);
    case 'section':
      return section(block, theme, renderLeaf);
    case 'thank_you':
      return slots.thankYou ?? null;
    case 'back_to_store':
      return slots.backToStore ?? null;
    default:
      // `payment` is drawn by the canvas itself; anything else is a type this build doesn't know.
      return null;
  }
}

function Wrapped({ block, children }: { block: ThemeBlock; children: ReactNode }) {
  return (
    <div className="tdr-wrap" data-type={block.type}>
      <div className="tdr-scope">
        <div className="tdr-content" data-block={block.id}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Sealed({ children }: { children: ReactNode }) {
  return (
    <section className="tdr-payment" data-sealed="">
      {children}
    </section>
  );
}

export function BlockCanvas({ blocks, theme, slots }: Props) {
  const renderBlock = (block: ThemeBlock, nested: boolean): ReactNode => {
    if (block.hidden || block.type === 'payment') return null;
    const inner = content(block, theme, slots, (leaf) => renderBlock(leaf, true));
    if (inner === null || inner === undefined || inner === false) return null;
    return (
      <Wrapped key={`${nested ? 'n' : 't'}-${block.id}`} block={block}>
        {inner}
      </Wrapped>
    );
  };

  // The payment block is drawn once, at its place in the list. A list without one (never valid,
  // but payment must not depend on the theme) gets it at the end. The success canvas has no
  // payment block and passes `payment: null`.
  const sealedAt = blocks.findIndex((b) => b.type === 'payment');
  const out: ReactNode[] = blocks.map((block, i) =>
    i === sealedAt ? <Sealed key="tdr-payment">{slots.payment}</Sealed> : renderBlock(block, false),
  );
  if (sealedAt === -1 && slots.payment != null) {
    out.push(<Sealed key="tdr-payment">{slots.payment}</Sealed>);
  }

  return <div className="tdr-canvas">{out}</div>;
}
