// A theme as aggressive as the theme validator ALLOWS (apps/api/src/themes/css.ts and html.ts):
// huge negative margins, transforms, giant z-indexes, absolutely positioned covers and a
// 3000 px-tall banner, in both the custom CSS and the custom HTML. The validator refuses
// `position: fixed/sticky`, `@import`, external urls, forms, scripts and addresses; everything
// below is accepted, so only the page's containment keeps it off the payment block
// (e2e/themes.spec.ts "hostile theme cannot cover or move the payment block").

/** Custom CSS: the API scopes every selector to `.tdr-scope …`. */
export const HOSTILE_CSS = `
.cover { position: absolute; top: -4000px; left: -2000px; width: 9000px; height: 9000px; z-index: 99999; background: #ff0055; opacity: 0.9; }
.shove { margin: -3000px -500px -3000px -500px; transform: translateY(-500px) scale(3); z-index: 99999; position: relative; }
.tall { height: 3000px; background: linear-gradient(#ff0055, #220011); }
.below { position: absolute; bottom: -2500px; left: 0; width: 100%; height: 2500px; z-index: 2147483647; background: #ff0055; }
p { margin-top: -800px; transform: translateY(900px); z-index: 99999; position: relative; }
`;

/** Custom HTML blocks (sanitised by the API; `class` and inline `style` are kept). */
export const HOSTILE_HTML_ABOVE =
  '<div class="tall"><div class="cover"></div><p>Biggest sale of the year</p></div>' +
  '<div style="position:absolute;top:-1200px;left:0;width:2000px;height:5000px;z-index:99999;background:#00ff99"></div>';

export const HOSTILE_HTML_BELOW =
  '<div class="shove"><p>Follow us</p></div><div class="below"></div>' +
  '<div style="margin-top:-6000px;transform:translateY(-500px);z-index:99999;position:relative;height:200px;background:#00ff99"></div>';
