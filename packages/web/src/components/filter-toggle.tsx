import { tr } from "../l10n.js";
export function FilterToggle({
  open,
  active,
  title,
  controls,
  onToggle,
}: {
  open: boolean;
  active: boolean;
  /** ツールチップ（何で絞れるか） */
  title: string;
  /** 開く欄の id */
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`filter-toggle${active ? " active" : ""}${open ? " open" : ""}`}
      aria-label={active ? tr("絞り込み（絞っている）") : tr("絞り込み")}
      title={title}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
    >
      <FunnelIcon />
    </button>
  );
}

/** 絞り込みの漏斗の印。線は currentColor で、絞っている間は CSS で中を塗る（.filter-toggle.active） */
function FunnelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z"
        fill="currentColor"
        fillOpacity={0}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
