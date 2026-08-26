import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BELLBIRD_MARK_ASSET_URL, BellbirdWordmark } from "./BellbirdWordmark";

describe("BellbirdWordmark", () => {
  it("uses the Bellbird mark and name without the upstream T3 wordmark", () => {
    const markup = renderToStaticMarkup(<BellbirdWordmark />);

    expect(BELLBIRD_MARK_ASSET_URL).toBe("/bellbird-mark.png");
    expect(markup).toContain('src="/bellbird-mark.png"');
    expect(markup).toContain("Bellbird");
    expect(markup).not.toContain("T3");
  });
});
