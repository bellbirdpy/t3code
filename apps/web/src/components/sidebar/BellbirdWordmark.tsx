export const BELLBIRD_MARK_ASSET_URL = "/bellbird-mark.png";

export function BellbirdWordmark() {
  return (
    <span className="flex shrink-0 items-center gap-1.5" data-bellbird-wordmark>
      <img
        alt=""
        aria-hidden="true"
        className="h-5 w-5 rounded-sm bg-white object-contain p-px"
        src={BELLBIRD_MARK_ASSET_URL}
      />
      <span className="truncate text-sm font-semibold tracking-tight">Bellbird</span>
    </span>
  );
}
