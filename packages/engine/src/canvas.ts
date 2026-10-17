/**
 * Size of a canvas's backing store, in device pixels, for a given CSS size.
 *
 * A canvas has two sizes: how big it looks on the page (CSS pixels) and how many
 * pixels it actually stores. On a 2x "Retina" screen, a 400px-wide canvas needs an
 * 800px-wide backing store or everything drawn into it looks blurry.
 */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { width: number; height: number } {
  return {
    width: Math.round(cssWidth * devicePixelRatio),
    height: Math.round(cssHeight * devicePixelRatio),
  };
}
