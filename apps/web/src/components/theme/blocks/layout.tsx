// Layout blocks: two columns, and a section on a colour or image background. Their children are
// leaf blocks, each drawn by the canvas in its own contained wrapper.
import type { ShopperTheme, ThemeBlock, ThemeLeafBlock } from '@tendr/contracts';
import type { ReactNode } from 'react';
import { backgroundImage } from './assets';

type Of<T extends ThemeBlock['type']> = Extract<ThemeBlock, { type: T }>;
export type RenderLeaf = (block: ThemeLeafBlock) => ReactNode;

export function columns(block: Of<'columns'>, renderLeaf: RenderLeaf): ReactNode {
  return (
    <div className="tdr-columns">
      {block.columns.map((col, i) => (
        <div className="tdr-column" key={i}>
          {col.map(renderLeaf)}
        </div>
      ))}
    </div>
  );
}

export function section(
  block: Of<'section'>,
  theme: ShopperTheme,
  renderLeaf: RenderLeaf,
): ReactNode {
  return (
    <div
      className="tdr-section"
      style={{
        backgroundColor: block.background,
        backgroundImage: backgroundImage(theme, block.background_asset_id),
      }}
    >
      {block.blocks.map(renderLeaf)}
    </div>
  );
}
