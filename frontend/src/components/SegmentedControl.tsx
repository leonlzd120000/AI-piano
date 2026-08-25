interface Segment<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  ariaLabel: string;
  value: T;
  segments: Segment<T>[];
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  segments,
  onChange
}: SegmentedControlProps<T>) {
  return (
    <div className="segmented-control" role="group" aria-label={ariaLabel}>
      {segments.map((segment) => (
        <button
          key={segment.value}
          type="button"
          className={value === segment.value ? "is-selected" : undefined}
          aria-pressed={value === segment.value}
          onClick={() => onChange(segment.value)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}
